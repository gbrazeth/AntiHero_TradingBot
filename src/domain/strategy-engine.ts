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

                case 'SMA9_CROSS_ABOVE':
                case 'SMA9_CROSS_BELOW':
                    await this.handleSma9Cross({ payload, signalId });
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

    private async handleSma9Cross(params: { payload: WebhookPayload; signalId: number }): Promise<void> {
        const { payload } = params;
        
        // Find open position for this symbol
        const position = await prisma.position.findFirst({
            where: { symbol: payload.symbol, status: 'open' },
        });

        if (!position) {
            this.logger.info({ symbol: payload.symbol }, 'No open position found for SMA9 cross');
            return;
        }

        let newScenario: 'SCENARIO_1' | 'SCENARIO_2' | null = null;

        if (payload.event === 'SMA9_CROSS_BELOW') {
            newScenario = position.side === 'BUY' ? 'SCENARIO_2' : 'SCENARIO_1';
        } else if (payload.event === 'SMA9_CROSS_ABOVE') {
            newScenario = position.side === 'SELL' ? 'SCENARIO_2' : 'SCENARIO_1';
        }

        if (!newScenario || newScenario === position.scenario) {
            this.logger.info({ symbol: payload.symbol, newScenario }, 'Scenario unchanged or invalid');
            return;
        }

        this.logger.info({ symbol: payload.symbol, oldScenario: position.scenario, newScenario }, '⚡ Scenario changed due to SMA9 cross');

        // Update DB
        await prisma.position.update({
            where: { id: position.id },
            data: { scenario: newScenario },
        });

        const entrySide = position.side as 'BUY' | 'SELL';
        const rules = this.risk.getScenarioRules(newScenario);

        // Determine what TPs are still pending based on maxRoiReached
        // and what the current SL should be
        let targetSlAction = 'NONE';
        let targetSlRoi = 0;
        let trailingShouldBeActive = false;

        const pendingTps = [];

        for (const rule of rules) {
            if (position.maxRoiReached >= rule.tpRoi) {
                // This rule's ROI was already reached. Adopt its SL action.
                if (rule.slAction === 'MOVE_TO_ROI') {
                    targetSlAction = 'MOVE_TO_ROI';
                    targetSlRoi = rule.slRoi ?? 0;
                }
                if (rule.activateTrailing) {
                    trailingShouldBeActive = true;
                }
            } else {
                // This rule's ROI has NOT been reached. Add it to pending TPs.
                pendingTps.push(rule);
            }
        }

        // Calculate new SL based on the adopted rule
        let newSlPrice = position.slPrice || position.entryPrice;
        if (targetSlAction === 'MOVE_TO_ROI') {
            newSlPrice = this.risk.calcConditionalSl(entrySide === 'BUY' ? 'LONG' : 'SHORT', position.entryPrice, targetSlRoi);
        }

        try {
            // Cancel all orders (SL + old TPs)
            await this.exchange.cancelAllOpenOrders(position.symbol);

            // Re-place SL immediately
            await this.exchange.setTradingStop({
                symbol: position.symbol,
                side: entrySide,
                stopLoss: String(newSlPrice),
                qty: String(position.currentQty),
            });

            // Re-place pending TPs
            let remainingQty = position.currentQty;
            const tps = this.risk.calcTpsForRules(entrySide === 'BUY' ? 'LONG' : 'SHORT', position.entryPrice, pendingTps);

            for (const tp of tps) {
                if (remainingQty <= 0.001) break;
                
                let tpQty = parseFloat((position.qty * tp.pct).toFixed(3));
                const minQty = parseFloat((6.0 / position.entryPrice).toFixed(3));
                if (tpQty < minQty) tpQty = minQty;
                if (tpQty > remainingQty) tpQty = remainingQty;

                await this.exchange.setTakeProfit({
                    symbol: position.symbol,
                    side: entrySide,
                    tpPrice: String(tp.price),
                    qty: tpQty.toFixed(3),
                });
                remainingQty -= parseFloat(tpQty.toFixed(3));
            }

            // If trailing should be active but wasn't (e.g. we switched to a scenario where it's already active)
            if (trailingShouldBeActive && !position.trailingActive) {
                if (remainingQty > 0.001) {
                    const callbackRate = "2.5"; // 50% ROI / 20x = 2.5%
                    const markPrice = (await this.exchange.getPosition(position.symbol))?.markPrice || String(position.entryPrice);
                    await this.exchange.setTrailingStop({
                        symbol: position.symbol,
                        side: entrySide,
                        qty: String(remainingQty),
                        activationPrice: markPrice,
                        callbackRate
                    });
                    
                    await prisma.position.update({
                        where: { id: position.id },
                        data: { trailingActive: true },
                    });
                }
            }

            // Notify Telegram
            await this.telegram.notifyBreakEven({
                symbol: position.symbol,
                newSl: newSlPrice,
            });

        } catch (err) {
            this.logger.error({ err, symbol: position.symbol }, '🚨 Failed to re-arm orders during scenario switch');
            await this.telegram.notifyError(
                'SCENARIO SWITCH FAILURE',
                new Error(`Falha ao rearmar ordens para ${position.symbol} na mudança de cenário. Verifique a Binance manualmente.`)
            );
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

                    // Determine which rules were hit based on totalClosedPct
                    const totalClosed = dbPos.qty - realQty;
                    const totalClosedPct = totalClosed / dbPos.qty;
                    
                    const rules = this.risk.getScenarioRules(dbPos.scenario as 'SCENARIO_1' | 'SCENARIO_2');
                    let cumPct = 0;
                    let targetSlAction = 'NONE';
                    let targetSlRoi = 0;
                    let activateTrailing = false;
                    let maxRoiReached = dbPos.maxRoiReached;

                    for (const rule of rules) {
                        cumPct += rule.closePct;
                        if (totalClosedPct + 0.001 >= cumPct) { // +0.001 for float precision
                            maxRoiReached = Math.max(maxRoiReached, rule.tpRoi);
                            if (rule.slAction === 'MOVE_TO_ROI') {
                                targetSlAction = 'MOVE_TO_ROI';
                                targetSlRoi = rule.slRoi ?? 0;
                            }
                            if (rule.activateTrailing) {
                                activateTrailing = true;
                            }
                        }
                    }

                    let newSlPrice = dbPos.slPrice;
                    let slChanged = false;

                    if (targetSlAction === 'MOVE_TO_ROI') {
                        const calculatedSl = this.risk.calcConditionalSl(
                            dbPos.side as 'LONG' | 'SHORT',
                            dbPos.entryPrice,
                            targetSlRoi
                        );
                        if (calculatedSl !== dbPos.slPrice) {
                            newSlPrice = calculatedSl;
                            slChanged = true;
                        }
                    }

                    if (slChanged) {
                        const entrySide = dbPos.side === 'BUY' ? 'BUY' : 'SELL';
                        try {
                            // Cancel all existing orders (old SL + old TPs)
                            await this.exchange.cancelAllOpenOrders(dbPos.symbol);
                            
                            // Immediately place new SL
                            await this.exchange.setTradingStop({
                                symbol: dbPos.symbol,
                                side: entrySide,
                                stopLoss: String(newSlPrice),
                                qty: String(realQty),
                            });

                            this.logger.info(
                                { symbol, newSlPrice, oldSl: dbPos.slPrice, targetSlRoi },
                                '⚡ SL moved dynamically based on TP hit'
                            );

                            await this.telegram.notifyBreakEven({
                                symbol: dbPos.symbol,
                                newSl: newSlPrice as number,
                            });

                            // Re-place remaining TP orders
                            try {
                                let remainingQty = realQty;
                                const pendingRules = rules.filter(r => r.tpRoi > maxRoiReached);
                                const tps = this.risk.calcTpsForRules(entrySide === 'BUY' ? 'LONG' : 'SHORT', dbPos.entryPrice, pendingRules);

                                for (const tp of tps) {
                                    if (remainingQty <= 0.001) break;
                                    let tpQty = parseFloat((dbPos.qty * tp.pct).toFixed(3));
                                    const minQty = parseFloat((6.0 / dbPos.entryPrice).toFixed(3));
                                    if (tpQty < minQty) tpQty = minQty;
                                    if (tpQty > remainingQty) tpQty = remainingQty;

                                    await this.exchange.setTakeProfit({
                                        symbol: dbPos.symbol,
                                        side: entrySide,
                                        tpPrice: String(tp.price),
                                        qty: tpQty.toFixed(3),
                                    });
                                    remainingQty -= parseFloat(tpQty.toFixed(3));
                                }
                            } catch (tpErr) {
                                this.logger.warn({ tpErr }, 'Failed to re-place TPs after dynamic SL move (SL is still active)');
                            }
                        } catch (err) {
                            this.logger.error({ err }, '🚨 CRITICAL: Failed to set dynamic SL! Attempting to restore original SL.');
                            newSlPrice = dbPos.slPrice ?? dbPos.entryPrice;
                            try {
                                await this.exchange.setTradingStop({
                                    symbol: dbPos.symbol,
                                    side: entrySide,
                                    stopLoss: String(dbPos.slPrice),
                                    qty: String(realQty),
                                });
                            } catch (restoreErr) {
                                this.logger.error({ restoreErr }, '🚨🚨 CRITICAL: Could not restore original SL! Position is UNPROTECTED!');
                                await this.telegram.notifyError(
                                    'STOP LOSS FAILURE',
                                    new Error(`URGENTE: Posição ${dbPos.symbol} está SEM STOP LOSS! Verifique manualmente na Binance AGORA!`)
                                );
                            }
                        }
                    }

                    // Handle Trailing Stop Activation
                    let trailingActive = dbPos.trailingActive;
                    if (activateTrailing && !trailingActive) {
                        try {
                            const entrySide = dbPos.side === 'BUY' ? 'BUY' : 'SELL';
                            const callbackRate = "2.5"; // 50% ROI / 20x
                            const markPrice = realPos.markPrice;
                            
                            // Cancel all open orders first to remove standard SL
                            await this.exchange.cancelAllOpenOrders(dbPos.symbol);
                            
                            await this.exchange.setTrailingStop({
                                symbol: dbPos.symbol,
                                side: entrySide,
                                qty: String(realQty),
                                activationPrice: markPrice,
                                callbackRate
                            });
                            trailingActive = true;
                            this.logger.info({ symbol }, '⚡ Native Trailing Stop activated on Binance');
                        } catch (err) {
                            this.logger.error({ err }, 'Failed to activate trailing stop');
                        }
                    }

                    await prisma.position.update({
                        where: { id: dbPos.id },
                        data: { 
                            currentQty: realQty, 
                            slPrice: newSlPrice,
                            maxRoiReached,
                            trailingActive,
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
                            details: `TP hit: ${pctClosed.toFixed(1)}% of position closed${slChanged ? ` | SL moved to ${targetSlRoi}% ROI` : ''}`,
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
            this.logger.error({ err }, '🚨 CRITICAL: Failed to set initial stop loss!');
            await this.telegram.notifyError(
                'STOP LOSS FAILURE',
                new Error(`URGENTE: Posição ${payload.symbol} ${side} aberta SEM STOP LOSS! SL deveria ser ${risk.slPrice}. Verifique manualmente na Binance AGORA!`)
            );
        }

        // 8. Set Take Profits natively (13 levels based on ROI)
        try {
            const tps = risk.tps;
            
            for (let i = 0; i < tps.length; i++) {
                const tp = tps[i];
                if (!tp) continue;
                
                let tpQty = parseFloat((risk.qty * tp.pct).toFixed(3));
                
                // Binance MIN_NOTIONAL is 5 USDT. We force at least 6 USDT worth to be safe.
                const minQty = parseFloat((6.0 / payload.price).toFixed(3));
                if (tpQty < minQty) {
                    tpQty = minQty;
                }

                await this.exchange.setTakeProfit({
                    symbol: payload.symbol,
                    side: exchangeSide,
                    tpPrice: String(tp.price),
                    qty: tpQty.toFixed(3),
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
