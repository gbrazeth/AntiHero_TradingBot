import type { FastifyBaseLogger } from 'fastify';
import type { WebhookPayload, WebhookEvent } from '../webhook/webhook.schema.js';
import { prisma } from '../infra/prisma.js';
import { RiskManager } from './risk-manager.js';
import { BinanceAdapter } from '../infra/binance-adapter.js';
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
    private readonly exchange: BinanceAdapter;
    private readonly telegram: TelegramNotifier;

    constructor(private readonly logger: FastifyBaseLogger) {
        this.risk = new RiskManager(logger);
        this.exchange = new BinanceAdapter(logger);
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

        // 1. Trend Filter Check
        if (payload.trend_1d && payload.trend_1d !== 'NONE') {
            const isCounterTrend = 
                (side === 'LONG' && payload.trend_1d === 'DOWN') ||
                (side === 'SHORT' && payload.trend_1d === 'UP');
                
            if (isCounterTrend) {
                this.logger.warn(
                    { side, trend: payload.trend_1d },
                    'Entry blocked by 1D Trend Filter (counter-trend)'
                );
                return;
            }
        }

        const exchangeSide: 'BUY' | 'SELL' = side === 'LONG' ? 'BUY' : 'SELL';

        // 2. Existing open position check & Auto-Reversal
        const openPos = await prisma.position.findFirst({
            where: { symbol: payload.symbol, status: 'open' },
        });

        if (openPos) {
            if (openPos.side === exchangeSide) {
                this.logger.warn({ posId: openPos.id }, 'Already in a position for this symbol/side — ignoring');
                return;
            } else {
                this.logger.info({ posId: openPos.id }, 'Opposite position detected. Executing Auto-Reversal.');
                
                // Close previous position on Binance
                await this.exchange.placeOrder({
                    symbol: payload.symbol,
                    side: exchangeSide, // to close a SHORT we BUY
                    qty: String(openPos.currentQty),
                    reduceOnly: true,
                });
                
                // Calculate PNL based on closing the previous position
                const closedQty = openPos.currentQty;
                const pnl = openPos.side === 'BUY' 
                    ? (payload.price - openPos.entryPrice) * closedQty 
                    : (openPos.entryPrice - payload.price) * closedQty;
                
                const currentRealized = openPos.realizedPnl || 0;
                
                // Mark closed in DB
                await prisma.position.update({
                    where: { id: openPos.id },
                    data: { status: 'closed', currentQty: 0, realizedPnl: currentRealized + pnl },
                });
            }
        }

        // 3. Risk check
        const risk = await this.risk.checkEntry({
            symbol: payload.symbol,
            side,
            entryPrice: payload.price,
        });

        if (!risk.allowed) {
            this.logger.warn({ reason: risk.reason }, 'Entry blocked by RiskManager');
            return;
        }

        // 4. Place order on Binance
        const exchangeOrderId = await this.exchange.placeOrder({
            symbol: payload.symbol,
            side: exchangeSide,
            qty: String(risk.qty),
        });

        // 5. Persist order to DB (linked to signal)
        await prisma.order.create({
            data: {
                signalId,
                side: exchangeSide,
                qty: risk.qty,
                price: payload.price,
                orderType: 'Market',
                exchangeOrderId,
                status: 'filled',
            },
        });

        // 6. Persist position
        await prisma.position.create({
            data: {
                symbol: payload.symbol,
                side: exchangeSide,
                entryPrice: payload.price,
                qty: risk.qty,
                currentQty: risk.qty,
                slPrice: risk.slPrice,
                status: 'open',
            },
        });

        // 7. Set initial stop loss (Using Algo API format with qty)
        try {
            await this.exchange.setTradingStop({
                symbol: payload.symbol,
                side: exchangeSide,
                stopLoss: String(risk.slPrice),
                qty: String(risk.qty),
            });
        } catch (err) {
            this.logger.warn({ err }, 'Failed to set initial stop loss');
        }

        // 8. Set Take Profits natively
        try {
            const tp1Qty = parseFloat((risk.qty * 0.5).toFixed(3));
            const tp2Qty = parseFloat((risk.qty - tp1Qty).toFixed(3));

            if (tp1Qty > 0) {
                await this.exchange.setTakeProfit({
                    symbol: payload.symbol,
                    side: exchangeSide,
                    tpPrice: String(risk.tp1Price),
                    qty: String(tp1Qty),
                });
            }
            if (tp2Qty > 0) {
                await this.exchange.setTakeProfit({
                    symbol: payload.symbol,
                    side: exchangeSide,
                    tpPrice: String(risk.tp2Price),
                    qty: String(tp2Qty),
                });
            }
        } catch (err) {
            this.logger.warn({ err }, 'Failed to set take profit limit orders');
        }

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
            { side, symbol: payload.symbol, qty: risk.qty, slPrice: risk.slPrice, exchangeOrderId },
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
                side: side === 'LONG' ? 'BUY' : 'SELL',
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

        const closeSide: 'BUY' | 'SELL' = side === 'LONG' ? 'SELL' : 'BUY';
        const qtyToClose = String(partial.qtyToClose);

        // 3. Place reduce-only order on Binance
        const exchangeOrderId = await this.exchange.placeOrder({
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
                exchangeOrderId,
                status: 'filled',
            },
        });

        const newQty = parseFloat((position.currentQty - partial.qtyToClose).toFixed(4));
        const isFirstPartial = !position.beApplied;

        // 5. Apply break-even after first partial
        let newSlPrice = position.slPrice ?? position.entryPrice;
        if (isFirstPartial) {
            newSlPrice = this.risk.calcBreakEven(side, position.entryPrice);
            const entrySide: 'BUY' | 'SELL' = side === 'LONG' ? 'BUY' : 'SELL';
            try {
                await this.exchange.setTradingStop({
                    symbol: payload.symbol,
                    side: entrySide,
                    stopLoss: String(newSlPrice),
                    qty: String(newQty),
                });
            } catch (err) {
                this.logger.warn({ err }, 'Failed to set break-even stop loss via Binance API');
            }

            await this.telegram.notifyBreakEven({
                symbol: payload.symbol,
                newSl: newSlPrice,
            });

            this.logger.info(
                { symbol: payload.symbol, newSlPrice },
                '⚡ Break-even applied after first partial',
            );
        }

        // Calculate PNL for this partial transaction
        const closedQty = partial.qtyToClose;
        const pnl = position.side === 'BUY'
            ? (payload.price - position.entryPrice) * closedQty
            : (position.entryPrice - payload.price) * closedQty;

        const currentRealized = position.realizedPnl || 0;

        // 6. Update position in DB
        const positionFullyClosed = newQty <= 0;
        await prisma.position.update({
            where: { id: position.id },
            data: {
                currentQty: positionFullyClosed ? 0 : newQty,
                slPrice: newSlPrice,
                beApplied: true,
                realizedPnl: currentRealized + pnl,
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
                exchangeOrderId,
            },
            `✅ Partial exit ${pct * 100}% executed`,
        );
    }
}
