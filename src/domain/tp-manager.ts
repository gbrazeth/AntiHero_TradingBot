import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../infra/prisma.js';
import { BinanceAdapter } from '../infra/binance-adapter.js';
import { TelegramNotifier } from '../infra/telegram-notifier.js';
import { env } from '../config/env.js';

interface PositionData {
    id: number;
    symbol: string;
    side: string;
    entryPrice: number;
    currentQty: number;
    originalQty: number | null;
    slPrice: number | null;
    lastTpHit: number;
    trailingActive: boolean;
    beApplied: boolean;
}

export class TpManager {
    private get TpLevels() {
        return [
            { level: 1, roi: env.TP1_ROI, slicePct: env.TP1_SLICE, action: 'BREAK_EVEN' },
            { level: 2, roi: env.TP2_ROI, slicePct: env.TP2_SLICE, action: 'ACTIVATE_TRAILING' },
            { level: 3, roi: env.TP3_ROI, slicePct: env.TP3_SLICE, action: 'TRAILING_CONTINUES' },
            { level: 4, roi: env.TP4_ROI, slicePct: env.TP4_SLICE, action: 'TRAILING_CONTINUES' },
            { level: 5, roi: env.TP5_ROI, slicePct: env.TP5_SLICE, action: 'TRAILING_CONTINUES' },
        ];
    }

    constructor(
        private readonly logger: FastifyBaseLogger,
        private readonly exchange: BinanceAdapter,
        private readonly telegram: TelegramNotifier
    ) {}

    async checkAndExecuteTPs(position: PositionData): Promise<void> {
        if (position.currentQty <= 0) return;

        try {
            const realPos = await this.exchange.getPosition(position.symbol);
            if (!realPos) {
                this.logger.debug({ symbol: position.symbol }, 'Position not found on Binance during TP check');
                return;
            }

            const markPrice = Number(realPos.markPrice);
            const entryPrice = position.entryPrice;
            const originalQty = position.originalQty || position.currentQty;

            const pnl = position.side === 'BUY' 
                ? (markPrice - entryPrice) / entryPrice 
                : (entryPrice - markPrice) / entryPrice;
            const currentRoi = pnl * env.LEVERAGE;

            const tps = this.TpLevels;
            let highestHitLevel = position.lastTpHit;

            for (const tp of tps) {
                if (tp.level > position.lastTpHit && currentRoi >= tp.roi) {
                    highestHitLevel = tp.level;
                }
            }

            for (let i = position.lastTpHit + 1; i <= highestHitLevel; i++) {
                const tpToExecute = tps.find(t => t.level === i);
                if (tpToExecute) {
                    await this.executeTpLevel(position, tpToExecute, markPrice, originalQty, currentRoi);
                    position.lastTpHit = tpToExecute.level;
                    if (tpToExecute.action === 'BREAK_EVEN') position.beApplied = true;
                    if (tpToExecute.action === 'ACTIVATE_TRAILING') position.trailingActive = true;
                }
            }
        } catch (err) {
            this.logger.error({ err, symbol: position.symbol }, 'Error checking/executing TPs');
        }
    }

    private async executeTpLevel(
        position: PositionData, 
        tp: { level: number; roi: number; slicePct: number; action: string }, 
        currentPrice: number,
        originalQty: number,
        currentRoi: number
    ): Promise<void> {
        this.logger.info({ symbol: position.symbol, level: tp.level, currentRoi }, `Executing TP Level ${tp.level}`);

        const rawSliceQty = originalQty * tp.slicePct;
        const sliceQty = parseFloat(rawSliceQty.toFixed(3));
        const qtyToClose = Math.min(sliceQty, position.currentQty);
        
        if (qtyToClose > 0) {
            const exchangeSide = position.side === 'BUY' ? 'SELL' : 'BUY';
            
            await this.exchange.placeOrder({
                symbol: position.symbol,
                side: exchangeSide,
                qty: String(qtyToClose),
                reduceOnly: true,
            });

            const realizedPnl = position.side === 'BUY'
                ? (currentPrice - position.entryPrice) * qtyToClose
                : (position.entryPrice - currentPrice) * qtyToClose;

            await prisma.tradeLog.create({
                data: {
                    positionId: position.id,
                    event: `TP${tp.level}_HIT`,
                    side: position.side,
                    symbol: position.symbol,
                    qty: qtyToClose,
                    price: currentPrice,
                    pnl: parseFloat(realizedPnl.toFixed(4)),
                    roiPct: parseFloat((currentRoi * 100).toFixed(2)),
                    details: `Hit TP${tp.level} (${(tp.roi * 100).toFixed(0)}% ROI). Action: ${tp.action}`,
                }
            });

            const newQty = parseFloat((position.currentQty - qtyToClose).toFixed(3));
            
            const dbPos = await prisma.position.findUnique({ where: { id: position.id }});
            const currentRealized = dbPos?.realizedPnl || 0;

            await prisma.position.update({
                where: { id: position.id },
                data: {
                    currentQty: newQty,
                    lastTpHit: tp.level,
                    realizedPnl: currentRealized + realizedPnl,
                    ...(tp.action === 'BREAK_EVEN' ? { beApplied: true } : {}),
                    ...(tp.action === 'ACTIVATE_TRAILING' ? { trailingActive: true } : {})
                }
            });
            
            position.currentQty = newQty;
        }

        if (tp.action === 'BREAK_EVEN') {
            await this.applyBreakEven(position);
        } else if (tp.action === 'ACTIVATE_TRAILING') {
            await this.activateTrailingStop(position, currentPrice);
        }

        await this.telegram.sendMessage(`🎯 <b>TP${tp.level} Atingido!</b>\nPar: ${position.symbol}\nPreço: ${currentPrice}\nROI: ${(currentRoi * 100).toFixed(2)}%\nFechado: ${qtyToClose} (Ficou: ${position.currentQty})\nAção: ${tp.action}`);
    }

    private async applyBreakEven(position: PositionData): Promise<void> {
        this.logger.info({ symbol: position.symbol }, 'Applying Break-Even');
        const bePrice = position.entryPrice;
        await this.exchange.cancelAllOpenOrders(position.symbol);
        const exchangeSide = position.side === 'BUY' ? 'SELL' : 'BUY';
        
        if (position.currentQty > 0) {
            try {
                await this.exchange.setTradingStop({
                    symbol: position.symbol,
                    side: exchangeSide,
                    stopLoss: String(bePrice),
                    qty: String(position.currentQty),
                });
                await prisma.position.update({
                    where: { id: position.id },
                    data: { slPrice: bePrice }
                });
                this.logger.info({ symbol: position.symbol, bePrice }, 'Break-Even SL set successfully');
            } catch (err) {
                this.logger.error({ err, symbol: position.symbol }, 'Failed to set Break-Even SL');
            }
        }
    }

    private async activateTrailingStop(position: PositionData, markPrice: number): Promise<void> {
        this.logger.info({ symbol: position.symbol }, 'Activating Trailing Stop');
        await this.exchange.cancelAllOpenOrders(position.symbol);

        if (position.currentQty > 0) {
            const exchangeSide = position.side === 'BUY' ? 'SELL' : 'BUY';
            const cbRate = env.TRAILING_STOP_ROI;
            const priceDistancePct = (cbRate / env.LEVERAGE) * 100;
            
            try {
                let callbackRateStr = priceDistancePct.toFixed(1);
                if (parseFloat(callbackRateStr) < 0.1) callbackRateStr = '0.1'; // min Binance limit

                await this.exchange.setTrailingStop({
                    symbol: position.symbol,
                    side: exchangeSide,
                    qty: String(position.currentQty),
                    activationPrice: String(markPrice),
                    callbackRate: callbackRateStr,
                });
                this.logger.info({ symbol: position.symbol, rate: callbackRateStr }, 'Trailing Stop activated successfully');
            } catch (err) {
                this.logger.error({ err, symbol: position.symbol }, 'Failed to activate Trailing Stop');
                await this.applyBreakEven(position);
            }
        }
    }
}
