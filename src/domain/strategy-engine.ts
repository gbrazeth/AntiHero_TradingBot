import type { FastifyBaseLogger } from 'fastify';
import type { WebhookPayload, WebhookEvent } from '../webhook/webhook.schema.js';
import { prisma } from '../infra/prisma.js';
import { RiskManager } from './risk-manager.js';
import { BinanceAdapter } from '../infra/binance-adapter.js';
import { TelegramNotifier } from '../infra/telegram-notifier.js';
import { env } from '../config/env.js';

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
     * Starts the polling mechanism to detect native Take Profit/Stop Loss executions
     * on Binance and update the local DB (e.g. applying break-even).
     */
    public startPolling(): void {
        setInterval(() => {
            this.pollPositions().catch(err => this.logger.error({ err }, 'Polling error'));
        }, 15000);
    }

    private async pollPositions(): Promise<void> {
        const openPositions = await prisma.position.findMany({ where: { status: 'open' } });
        for (const pos of openPositions) {
            await this.syncPositionState(pos.symbol);
        }
    }

    /**
     * Main entry point. Routes the signal to the correct handler.
     */
    async handleSignal(payload: WebhookPayload, signalId: number): Promise<void> {
        this.logger.info({ event: payload.event, signalId }, 'StrategyEngine processing signal');

        await this.risk.ensureDailyPnlRow();
        await this.syncPositionState(payload.symbol);

        try {
            switch (payload.event as WebhookEvent) {
                case 'MACD_ENTRY_LONG':
                case 'RSI_ENTRY_LONG':
                case 'TREND_ENTRY_LONG':
                    await this.handleEntry({ payload, signalId, side: 'LONG' });
                    break;

                case 'MACD_ENTRY_SHORT':
                case 'RSI_ENTRY_SHORT':
                case 'TREND_ENTRY_SHORT':
                    await this.handleEntry({ payload, signalId, side: 'SHORT' });
                    break;

                case 'VMC_PARTIAL_25_LONG':
                case 'VMC_PARTIAL_50_LONG':
                case 'MACD_PARTIAL_LONG':
                    // Bullish momentum weakening -> exit pieces of a LONG position
                    await this.handlePartial({ payload, signalId, side: 'LONG', pct: 0.33 });
                    break;

                case 'VMC_PARTIAL_25_SHORT':
                case 'VMC_PARTIAL_50_SHORT':
                case 'MACD_PARTIAL_SHORT':
                    // Bearish momentum weakening -> exit pieces of a SHORT position
                    await this.handlePartial({ payload, signalId, side: 'SHORT', pct: 0.33 });
                    break;

                case 'TARGET_PRICE_LONG':
                    // Target Price hit for LONG position
                    await this.handlePartial({ payload, signalId, side: 'LONG', pct: 0.33 });
                    break;

                case 'TARGET_PRICE_SHORT':
                    // Target Price hit for SHORT position
                    await this.handlePartial({ payload, signalId, side: 'SHORT', pct: 0.33 });
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

    // ── Position State Sync ──────────────────────────────────────────────

    /**
     * Synchronizes the local DB position state with Binance.
     * Crucial to avoid "[-2022] ReduceOnly Order is rejected" when TP/SL hit on Binance
     * but the local SQLite DB still thinks the position is open.
     */
    private async syncPositionState(symbol: string): Promise<void> {
        try {
            const realPos = await this.exchange.getPosition(symbol);
            
            const dbPos = await prisma.position.findFirst({
                where: { symbol, status: 'open' },
            });

            if (dbPos && !realPos) {
                this.logger.info({ symbol, posId: dbPos.id }, 'Sync: Position closed on Binance (likely SL/TP). Updating DB.');

                const closePrice = dbPos.slPrice || dbPos.entryPrice;
                const slHitPnl = dbPos.side === 'BUY'
                    ? (closePrice - dbPos.entryPrice) * dbPos.currentQty
                    : (dbPos.entryPrice - closePrice) * dbPos.currentQty;

                const currentRealized = dbPos.realizedPnl || 0;

                await prisma.position.update({
                    where: { id: dbPos.id },
                    data: { 
                        status: 'closed', 
                        currentQty: 0,
                        realizedPnl: currentRealized + slHitPnl
                    },
                });

                const margin = (dbPos.currentQty * dbPos.entryPrice) / (env.LEVERAGE || 20);
                const roiPct = margin > 0 ? (slHitPnl / margin) * 100 : 0;

                // Log the full close / SL hit event
                await prisma.tradeLog.create({
                    data: {
                        positionId: dbPos.id,
                        event: 'SL_HIT',
                        side: dbPos.side,
                        symbol: dbPos.symbol,
                        qty: dbPos.currentQty,
                        price: closePrice,
                        pnl: parseFloat(slHitPnl.toFixed(4)),
                        roiPct: parseFloat(roiPct.toFixed(2)),
                        details: 'Position fully closed on Binance (SL or manual)',
                    },
                });
            } else if (dbPos && realPos) {
                const realQty = parseFloat(realPos.size);
                if (realQty > 0 && realQty < dbPos.currentQty - 0.001) {
                    this.logger.info(
                        { symbol, posId: dbPos.id, dbQty: dbPos.currentQty, realQty }, 
                        'Sync: Native Partial TP hit detected. Updating DB.'
                    );

                    const closedQty = dbPos.currentQty - realQty;
                    const pctClosed = (closedQty / dbPos.qty) * 100;
                    const partialPnl = dbPos.side === 'BUY'
                        ? (parseFloat(realPos.markPrice) - dbPos.entryPrice) * closedQty
                        : (dbPos.entryPrice - parseFloat(realPos.markPrice)) * closedQty;

                    const currentRealized = dbPos.realizedPnl || 0;

                    // Check if we've crossed the 20% ROI threshold (first 2 TP levels = 20% of qty closed)
                    // 20% ROI TP is the 2nd level. When totalClosed >= 20% of original qty, activate conditional SL.
                    const totalClosed = dbPos.qty - realQty;
                    const totalClosedPct = totalClosed / dbPos.qty;
                    const shouldActivateConditionalSl = !dbPos.beApplied && totalClosedPct >= 0.19; // ~20% closed = 2nd TP hit

                    let newSlPrice = dbPos.slPrice;

                    if (shouldActivateConditionalSl) {
                        // Cancel old SL and place new one at -15% ROI
                        newSlPrice = this.risk.calcConditionalSl(
                            dbPos.side as 'LONG' | 'SHORT',
                            dbPos.entryPrice,
                            -0.15 // -15% ROI
                        );
                        const entrySide = dbPos.side === 'BUY' ? 'BUY' : 'SELL';

                        try {
                            // Cancel old STOP_MARKET order first
                            await this.exchange.cancelAllOpenOrders(dbPos.symbol);
                            
                            // Place new SL at -15% ROI
                            await this.exchange.setTradingStop({
                                symbol: dbPos.symbol,
                                side: entrySide,
                                stopLoss: String(newSlPrice),
                                qty: String(realQty),
                            });

                            // Re-place remaining TP orders that haven't been hit yet
                            const leverage = env.LEVERAGE || 20;
                            const roiTargets = [
                                { roi: 0.25, pct: 0.10 },
                                { roi: 0.33, pct: 0.10 },
                                { roi: 0.50, pct: 0.10 },
                                { roi: 0.75, pct: 0.10 },
                                { roi: 1.00, pct: 0.10 },
                                { roi: 1.50, pct: 0.05 },
                                { roi: 2.00, pct: 0.05 },
                                { roi: 2.50, pct: 0.05 },
                                { roi: 3.00, pct: 0.05 },
                                { roi: 4.00, pct: 0.05 },
                                { roi: 5.00, pct: 0.05 }
                            ];

                            let remainingQty = realQty;
                            for (let i = 0; i < roiTargets.length; i++) {
                                const t = roiTargets[i];
                                if (!t || remainingQty <= 0.001) break;

                                const priceMovePct = t.roi / leverage;
                                const tpPrice = dbPos.side === 'BUY'
                                    ? parseFloat((dbPos.entryPrice * (1 + priceMovePct)).toFixed(2))
                                    : parseFloat((dbPos.entryPrice * (1 - priceMovePct)).toFixed(2));

                                let tpQty = parseFloat((dbPos.qty * t.pct).toFixed(3));
                                const minQty = parseFloat((6.0 / dbPos.entryPrice).toFixed(3));
                                if (tpQty < minQty) tpQty = minQty;
                                if (tpQty > remainingQty) tpQty = remainingQty;

                                const isLast = (i === roiTargets.length - 1);
                                const finalQty = isLast ? remainingQty.toFixed(3) : tpQty.toFixed(3);

                                await this.exchange.setTakeProfit({
                                    symbol: dbPos.symbol,
                                    side: dbPos.side as 'BUY' | 'SELL',
                                    tpPrice: String(tpPrice),
                                    qty: finalQty,
                                });
                                remainingQty -= parseFloat(finalQty);
                            }

                            this.logger.info(
                                { symbol, newSlPrice, oldSl: dbPos.slPrice },
                                '⚡ Conditional SL activated: 20% ROI TP hit → SL moved to -15% ROI'
                            );

                            await this.telegram.notifyBreakEven({
                                symbol: dbPos.symbol,
                                newSl: newSlPrice,
                            });
                        } catch (err) {
                            this.logger.warn({ err }, 'Failed to set conditional SL after 20% ROI TP hit');
                        }
                    }

                    await prisma.position.update({
                        where: { id: dbPos.id },
                        data: { 
                            currentQty: realQty, 
                            slPrice: shouldActivateConditionalSl ? newSlPrice : dbPos.slPrice,
                            beApplied: shouldActivateConditionalSl ? true : dbPos.beApplied,
                            realizedPnl: currentRealized + partialPnl
                        },
                    });

                    const margin = (closedQty * dbPos.entryPrice) / (env.LEVERAGE || 20);
                    const roiPct = margin > 0 ? (partialPnl / margin) * 100 : 0;

                    // Log the native partial TP event
                    await prisma.tradeLog.create({
                        data: {
                            positionId: dbPos.id,
                            event: 'PARTIAL_TP',
                            side: dbPos.side,
                            symbol: dbPos.symbol,
                            qty: closedQty,
                            price: parseFloat(realPos.markPrice),
                            pnl: parseFloat(partialPnl.toFixed(4)),
                            roiPct: parseFloat(roiPct.toFixed(2)),
                            details: `TP hit: ${pctClosed.toFixed(1)}% of position closed${shouldActivateConditionalSl ? ' | SL moved to -15% ROI' : ''}`,
                        },
                    });

                    await this.telegram.notifyPartialExit({
                        symbol: dbPos.symbol,
                        pct: parseFloat(pctClosed.toFixed(2)),
                        price: dbPos.entryPrice,
                        closedQty: String(closedQty.toFixed(3)),
                        event: 'NATIVE_PARTIAL_HIT'
                    });
                } else if (realQty > dbPos.currentQty + 0.001) {
                    // Position increased (manual trade?), just update DB
                    await prisma.position.update({
                        where: { id: dbPos.id },
                        data: { currentQty: realQty },
                    });
                }
            }
        } catch (err) {
            this.logger.warn({ err, symbol }, 'Failed to sync position state from Binance');
        }
    }

    // ── Entry Logic ──────────────────────────────────────────────────────

    private async handleEntry(params: {
        payload: WebhookPayload;
        signalId: number;
        side: 'LONG' | 'SHORT';
    }): Promise<void> {
        const { payload, signalId, side } = params;

        // 1. Trend Filter Check (Removed per client request for Opção 2)
        // Client wants to take short-term 15m signals even if against 1D trend.

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

                // Cancel all existing open orders (TPs, SLs)
                await this.exchange.cancelAllOpenOrders(payload.symbol);

                // Give Binance matching engine time to free up margin
                await new Promise(res => setTimeout(res, 1500));
                
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

                const margin = (closedQty * openPos.entryPrice) / (env.LEVERAGE || 60);
                const roiPct = margin > 0 ? (pnl / margin) * 100 : 0;

                // Log the auto-reversal close event
                await prisma.tradeLog.create({
                    data: {
                        positionId: openPos.id,
                        event: 'Close (Reversal)',
                        side: openPos.side,
                        symbol: openPos.symbol,
                        qty: closedQty,
                        price: payload.price,
                        pnl: parseFloat(pnl.toFixed(4)),
                        roiPct: parseFloat(roiPct.toFixed(2)),
                        details: `Position closed due to opposite trend signal`,
                    },
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
        const newPosition = await prisma.position.create({
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

        // 6b. Log entry event
        await prisma.tradeLog.create({
            data: {
                positionId: newPosition.id,
                event: 'ENTRY',
                side: exchangeSide,
                symbol: payload.symbol,
                qty: risk.qty,
                price: payload.price,
                details: `${side} entry at ${payload.price} | SL: ${risk.slPrice} | Leverage: 20x`,
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

        // 8. Set Take Profits natively (13 levels based on ROI)
        try {
            const tps = risk.tps;
            let remainingQty = risk.qty;
            
            for (let i = 0; i < tps.length; i++) {
                const tp = tps[i];
                if (!tp) continue;
                if (remainingQty <= 0.001) break; // Float precision safeguard
                
                let tpQty = parseFloat((risk.qty * tp.pct).toFixed(3));
                
                // Binance MIN_NOTIONAL is 5 USDT. We force at least 6 USDT worth to be safe.
                const minQty = parseFloat((6.0 / payload.price).toFixed(3));
                if (tpQty < minQty) {
                    tpQty = minQty;
                }
                
                // Don't exceed remaining
                if (tpQty > remainingQty) {
                    tpQty = remainingQty;
                }
                
                // For the very last TP, we use whatever is remaining to prevent dusting
                const isLast = (i === tps.length - 1);
                const finalQtyStr = isLast ? remainingQty.toFixed(3) : tpQty.toFixed(3);

                await this.exchange.setTakeProfit({
                    symbol: payload.symbol,
                    side: exchangeSide,
                    tpPrice: String(tp.price),
                    qty: finalQtyStr,
                });
                
                remainingQty -= parseFloat(finalQtyStr);
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

        // Calculate PNL for this partial transaction
        const closedQty = partial.qtyToClose;
        const pnl = position.side === 'BUY'
            ? (payload.price - position.entryPrice) * closedQty
            : (position.entryPrice - payload.price) * closedQty;

        const currentRealized = position.realizedPnl || 0;

        // 5. Update position in DB (SL stays at initial level — no break-even)
        const positionFullyClosed = newQty <= 0;
        await prisma.position.update({
            where: { id: position.id },
            data: {
                currentQty: positionFullyClosed ? 0 : newQty,
                realizedPnl: currentRealized + pnl,
                status: positionFullyClosed ? 'closed' : 'open',
            },
        });

        // 6. Log partial exit event
        const partialMargin = (partial.qtyToClose * position.entryPrice) / (env.LEVERAGE || 20);
        const partialRoi = partialMargin > 0 ? (pnl / partialMargin) * 100 : 0;
        await prisma.tradeLog.create({
            data: {
                positionId: position.id,
                event: positionFullyClosed ? 'FULL_CLOSE' : 'PARTIAL_EXIT',
                side: position.side,
                symbol: payload.symbol,
                qty: partial.qtyToClose,
                price: payload.price,
                pnl: parseFloat(pnl.toFixed(4)),
                roiPct: parseFloat(partialRoi.toFixed(2)),
                details: `${(pct * 100).toFixed(0)}% partial exit via webhook (SL kept at initial level)`,
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
                exchangeOrderId,
            },
            `✅ Partial exit ${pct * 100}% executed`,
        );
    }
}
