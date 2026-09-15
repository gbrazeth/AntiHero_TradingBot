import type { FastifyBaseLogger } from 'fastify';
import type { WebhookPayload, WebhookEvent } from '../webhook/webhook.schema.js';
import { prisma } from '../infra/prisma.js';
import { RiskManager } from './risk-manager.js';
import { BinanceAdapter } from '../infra/binance-adapter.js';
import { TelegramNotifier } from '../infra/telegram-notifier.js';
import { TpManager } from './tp-manager.js';
import { env } from '../config/env.js';

export class StrategyEngine {
    private readonly risk: RiskManager;
    private readonly exchange: BinanceAdapter;
    private readonly telegram: TelegramNotifier;
    private readonly tpManager: TpManager;

    constructor(private readonly logger: FastifyBaseLogger) {
        this.risk = new RiskManager(logger);
        this.exchange = new BinanceAdapter(logger);
        this.telegram = new TelegramNotifier(logger);
        this.tpManager = new TpManager(logger, this.exchange, this.telegram);
    }

    public startPolling(): void {
        setInterval(() => {
            this.pollPositions().catch(err => this.logger.error({ err }, 'Polling error'));
        }, 15000);
    }

    private async pollPositions(): Promise<void> {
        const openPositions = await prisma.position.findMany({ where: { status: 'open' } });
        for (const pos of openPositions) {
            await this.syncPositionState(pos.symbol);
            
            // Check TPs
            const refreshedPos = await prisma.position.findUnique({ where: { id: pos.id } });
            if (refreshedPos && refreshedPos.status === 'open' && refreshedPos.currentQty > 0) {
                await this.tpManager.checkAndExecuteTPs(refreshedPos);
            }
        }
    }

    async handleSignal(payload: WebhookPayload, signalId: number): Promise<void> {
        this.logger.info({ event: payload.event, signalId }, 'StrategyEngine processing signal');

        await this.risk.ensureDailyPnlRow();
        await this.syncPositionState(payload.symbol);

        try {
            switch (payload.event as WebhookEvent) {
                case 'SMA_ENTRY_LONG':
                    await this.handleEntry({ payload, signalId, side: 'LONG' });
                    break;
                case 'SMA_ENTRY_SHORT':
                    await this.handleEntry({ payload, signalId, side: 'SHORT' });
                    break;
                default:
                    this.logger.warn({ event: payload.event }, 'Event IGNORED (only SMA_ENTRY_LONG/SHORT allowed)');
            }
        } catch (err) {
            this.logger.error({ err, event: payload.event }, 'StrategyEngine error');
            await this.telegram.notifyError(`StrategyEngine.${payload.event}`, err);
            throw err;
        }
    }

    private async syncPositionState(symbol: string): Promise<void> {
        try {
            const realPos = await this.exchange.getPosition(symbol);
            
            const dbPos = await prisma.position.findFirst({
                where: { symbol, status: 'open' },
            });

            if (dbPos && !realPos) {
                this.logger.info({ symbol, posId: dbPos.id }, 'Sync: Position closed on Binance (likely SL or trailing). Updating DB.');

                // Cancel any dangling stops
                await this.exchange.cancelAllOpenOrders(symbol);

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

                await prisma.tradeLog.create({
                    data: {
                        positionId: dbPos.id,
                        event: 'CLOSED',
                        side: dbPos.side,
                        symbol: dbPos.symbol,
                        qty: dbPos.currentQty,
                        price: closePrice,
                        pnl: parseFloat(slHitPnl.toFixed(4)),
                        roiPct: parseFloat(roiPct.toFixed(2)),
                        details: 'Position fully closed on Binance (SL, Trailing, or manual)',
                    },
                });
            }
        } catch (err) {
            this.logger.warn({ err, symbol }, 'Failed to sync position state from Binance');
        }
    }

    private async handleEntry(params: {
        payload: WebhookPayload;
        signalId: number;
        side: 'LONG' | 'SHORT';
    }): Promise<void> {
        const { payload, signalId, side } = params;
        const exchangeSide: 'BUY' | 'SELL' = side === 'LONG' ? 'BUY' : 'SELL';

        // 1. Auto-Reversal & existing position check
        const openPos = await prisma.position.findFirst({
            where: { symbol: payload.symbol, status: 'open' },
        });

        if (openPos) {
            if (openPos.side === exchangeSide) {
                this.logger.warn({ posId: openPos.id }, 'Already in a position for this symbol/side — ignoring');
                return;
            } else {
                this.logger.info({ posId: openPos.id }, 'Opposite position detected. Executing Auto-Reversal.');
                
                await this.exchange.cancelAllOpenOrders(payload.symbol);
                
                await this.exchange.placeOrder({
                    symbol: payload.symbol,
                    side: exchangeSide, // to close a SHORT we BUY, to close a LONG we SELL
                    qty: String(openPos.currentQty),
                    reduceOnly: true,
                });

                await new Promise(res => setTimeout(res, 1500));
                
                const closedQty = openPos.currentQty;
                const pnl = openPos.side === 'BUY' 
                    ? (payload.price - openPos.entryPrice) * closedQty 
                    : (openPos.entryPrice - payload.price) * closedQty;
                
                const currentRealized = openPos.realizedPnl || 0;
                
                await prisma.position.update({
                    where: { id: openPos.id },
                    data: { status: 'closed', currentQty: 0, realizedPnl: currentRealized + pnl },
                });

                const margin = (closedQty * openPos.entryPrice) / (env.LEVERAGE || 20);
                const roiPct = margin > 0 ? (pnl / margin) * 100 : 0;

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

        // 2. Risk check
        const risk = await this.risk.checkEntry({
            symbol: payload.symbol,
            side,
            entryPrice: payload.price,
            wma250: payload.wma_250,
        });

        if (!risk.allowed) {
            this.logger.warn({ reason: risk.reason }, 'Entry blocked by RiskManager');
            return;
        }

        // 3. Place order
        const exchangeOrderId = await this.exchange.placeOrder({
            symbol: payload.symbol,
            side: exchangeSide,
            qty: String(risk.qty),
        });

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

        // 4. Persist position
        const newPosition = await prisma.position.create({
            data: {
                symbol: payload.symbol,
                side: exchangeSide,
                entryPrice: payload.price,
                qty: risk.qty,
                currentQty: risk.qty,
                originalQty: risk.qty,
                slPrice: risk.slPrice,
                status: 'open',
            },
        });

        await prisma.tradeLog.create({
            data: {
                positionId: newPosition.id,
                event: 'ENTRY',
                side: exchangeSide,
                symbol: payload.symbol,
                qty: risk.qty,
                price: payload.price,
                details: `${side} entry at ${payload.price} | SL: ${risk.slPrice}`,
            },
        });

        // 5. Set SL
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
                new Error(`URGENTE: Posição ${payload.symbol} aberta SEM STOP LOSS! SL deveria ser ${risk.slPrice}.`)
            );
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
            { side, symbol: payload.symbol, qty: risk.qty, slPrice: risk.slPrice },
            '✅ Entry executed successfully',
        );
    }
}
