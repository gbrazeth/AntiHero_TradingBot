import type { FastifyBaseLogger } from 'fastify';
import type { WebhookPayload, WebhookEvent } from '../webhook/webhook.schema.js';
import { prisma } from '../infra/prisma.js';
import { RiskManager } from './risk-manager.js';
import { BybitAdapter } from '../infra/bybit-adapter.js';
import { TelegramNotifier } from '../infra/telegram-notifier.js';

// ─── State Machine ────────────────────────────────────────────────────────
//
//  FLAT ──(MACD_ENTRY_LONG)──► LONG
//  FLAT ──(MACD_ENTRY_SHORT)─► SHORT
//
//  LONG
//    ├─ VMC_PARTIAL_25_LONG  → close 25% of position, apply BE if first partial
//    └─ VMC_PARTIAL_50_LONG  → close 50% of position, apply BE if first partial
//
//  SHORT
//    ├─ VMC_PARTIAL_25_SHORT → close 25% of position, apply BE if first partial
//    └─ VMC_PARTIAL_50_SHORT → close 50% of position, apply BE if first partial
//
//  Cross-side ENTRY signals while in a position → ignored (RiskManager blocks)

/**
 * StrategyEngine — Domain layer.
 *
 * The single point of truth for the state machine.
 * Orchestrates: RiskManager → BybitAdapter → DB persistence → TelegramNotifier.
 */
export class StrategyEngine {
    private readonly risk: RiskManager;
    private readonly bybit: BybitAdapter;
    private readonly telegram: TelegramNotifier;

    constructor(private readonly logger: FastifyBaseLogger) {
        this.risk = new RiskManager(logger);
        this.bybit = new BybitAdapter(logger);
        this.telegram = new TelegramNotifier(logger);
    }

    /**
     * Main entry point. Routes the signal to the correct handler.
     */
    async handleSignal(payload: WebhookPayload, signalId: number): Promise<void> {
        this.logger.info({ event: payload.event, signalId }, 'StrategyEngine processing signal');

        await this.risk.ensureDailyPnlRow();

        try {
            switch (payload.event as WebhookEvent) {
                case 'MACD_ENTRY_LONG':
                    await this.handleEntry({ payload, signalId, side: 'LONG' });
                    break;

                case 'MACD_ENTRY_SHORT':
                    await this.handleEntry({ payload, signalId, side: 'SHORT' });
                    break;

                case 'VMC_PARTIAL_25_LONG':
                    await this.handlePartial({ payload, signalId, side: 'LONG', pct: 0.25 });
                    break;

                case 'VMC_PARTIAL_50_LONG':
                    await this.handlePartial({ payload, signalId, side: 'LONG', pct: 0.50 });
                    break;

                case 'VMC_PARTIAL_25_SHORT':
                    await this.handlePartial({ payload, signalId, side: 'SHORT', pct: 0.25 });
                    break;

                case 'VMC_PARTIAL_50_SHORT':
                    await this.handlePartial({ payload, signalId, side: 'SHORT', pct: 0.50 });
                    break;

                default:
                    this.logger.warn({ event: payload.event }, 'Unknown event — skipping');
            }
        } catch (err) {
            this.logger.error({ err, event: payload.event }, 'StrategyEngine error');
            await this.telegram.notifyError(`StrategyEngine.${payload.event}`, err);
            throw err;
        }
    }

    // ── Entry Logic ──────────────────────────────────────────────────────

    private async handleEntry(params: {
        payload: WebhookPayload;
        signalId: number;
        side: 'LONG' | 'SHORT';
    }): Promise<void> {
        const { payload, signalId, side } = params;

        // 1. Risk check
        const risk = await this.risk.checkEntry({
            symbol: payload.symbol,
            side,
            entryPrice: payload.price,
        });

        if (!risk.allowed) {
            this.logger.warn({ reason: risk.reason }, 'Entry blocked by RiskManager');
            return;
        }

        const bybitSide: 'Buy' | 'Sell' = side === 'LONG' ? 'Buy' : 'Sell';

        // 2. Place order on Bybit
        const bybitOrderId = await this.bybit.placeOrder({
            symbol: payload.symbol,
            side: bybitSide,
            qty: String(risk.qty),
        });

        // 3. Set initial stop loss
        await this.bybit.setTradingStop({
            symbol: payload.symbol,
            stopLoss: String(risk.slPrice),
        });

        // 4. Persist order to DB (linked to signal)
        await prisma.order.create({
            data: {
                signalId,
                side: bybitSide,
                qty: risk.qty,
                price: payload.price,
                orderType: 'Market',
                bybitOrderId,
                status: 'filled',
            },
        });

        // 5. Persist position
        await prisma.position.create({
            data: {
                symbol: payload.symbol,
                side: bybitSide,
                entryPrice: payload.price,
                qty: risk.qty,
                currentQty: risk.qty,
                slPrice: risk.slPrice,
                status: 'open',
            },
        });

        // 6. Notify
        await this.telegram.notifyEntry({
            side,
            symbol: payload.symbol,
            price: payload.price,
            qty: risk.qty,
            slPrice: risk.slPrice,
            event: payload.event,
        });

        this.logger.info(
            { side, symbol: payload.symbol, qty: risk.qty, slPrice: risk.slPrice, bybitOrderId },
            '✅ Entry executed successfully',
        );
    }

    // ── Partial Exit Logic ───────────────────────────────────────────────

    private async handlePartial(params: {
        payload: WebhookPayload;
        signalId: number;
        side: 'LONG' | 'SHORT';
        pct: number;
    }): Promise<void> {
        const { payload, signalId, side, pct } = params;

        // 1. Find open position
        const position = await prisma.position.findFirst({
            where: {
                symbol: payload.symbol,
                side: side === 'LONG' ? 'Buy' : 'Sell',
                status: 'open',
            },
        });

        if (!position) {
            this.logger.warn(
                { symbol: payload.symbol, side, event: payload.event },
                'No open position found for partial exit — ignoring',
            );
            return;
        }

        // 2. Risk check for partial exit
        const partial = this.risk.checkPartialExit({
            currentQty: position.currentQty,
            pct,
            entryPrice: position.entryPrice,
        });

        if (!partial.allowed) {
            this.logger.warn({ reason: partial.reason }, 'Partial exit blocked by RiskManager');
            return;
        }

        const closeSide: 'Buy' | 'Sell' = side === 'LONG' ? 'Sell' : 'Buy';
        const qtyToClose = String(partial.qtyToClose);

        // 3. Place reduce-only order on Bybit
        const bybitOrderId = await this.bybit.placeOrder({
            symbol: payload.symbol,
            side: closeSide,
            qty: qtyToClose,
            reduceOnly: true,
        });

        // 4. Persist order
        await prisma.order.create({
            data: {
                signalId,
                side: closeSide,
                qty: partial.qtyToClose,
                price: payload.price,
                orderType: 'Market',
                bybitOrderId,
                status: 'filled',
            },
        });

        const newQty = parseFloat((position.currentQty - partial.qtyToClose).toFixed(4));
        const isFirstPartial = !position.beApplied;

        // 5. Apply break-even after first partial
        let newSlPrice = position.slPrice ?? position.entryPrice;
        if (isFirstPartial) {
            newSlPrice = this.risk.calcBreakEven(side, position.entryPrice);
            await this.bybit.setTradingStop({
                symbol: payload.symbol,
                stopLoss: String(newSlPrice),
            });

            await this.telegram.notifyBreakEven({
                symbol: payload.symbol,
                newSl: newSlPrice,
            });

            this.logger.info(
                { symbol: payload.symbol, newSlPrice },
                '⚡ Break-even applied after first partial',
            );
        }

        // 6. Update position in DB
        const positionFullyClosed = newQty <= 0;
        await prisma.position.update({
            where: { id: position.id },
            data: {
                currentQty: positionFullyClosed ? 0 : newQty,
                slPrice: newSlPrice,
                beApplied: true,
                status: positionFullyClosed ? 'closed' : 'open',
            },
        });

        // 7. Notify
        await this.telegram.notifyPartialExit({
            symbol: payload.symbol,
            pct: pct * 100,
            price: payload.price,
            closedQty: qtyToClose,
            event: payload.event,
        });

        this.logger.info(
            {
                symbol: payload.symbol,
                pct: pct * 100,
                qtyToClose,
                newQty,
                beApplied: isFirstPartial,
                bybitOrderId,
            },
            `✅ Partial exit ${pct * 100}% executed`,
        );
    }
}
