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
            { level: 1, roi: env.TP1_ROI, slicePct: env.TP1_SLICE, slRoi: 0 },
            { level: 2, roi: env.TP2_ROI, slicePct: env.TP2_SLICE, slRoi: 0 },
            { level: 3, roi: env.TP3_ROI, slicePct: env.TP3_SLICE, slRoi: 0.10 },
            { level: 4, roi: env.TP4_ROI, slicePct: env.TP4_SLICE, slRoi: 0.25 },
            { level: 5, roi: env.TP5_ROI, slicePct: env.TP5_SLICE, slRoi: 1.00 },
            { level: 6, roi: env.TP6_ROI, slicePct: env.TP6_SLICE, slRoi: null },
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
                }
            }
        } catch (err) {
            this.logger.error({ err, symbol: position.symbol }, 'Error checking/executing TPs');
        }
    }

    private async executeTpLevel(
        position: PositionData, 
        tp: { level: number; roi: number; slicePct: number; slRoi: number | null }, 
        currentPrice: number,
        originalQty: number,
        currentRoi: number
    ): Promise<void> {
        this.logger.info({ symbol: position.symbol, level: tp.level, currentRoi }, `Executing TP Level ${tp.level}`);

        const rawSliceQty = originalQty * tp.slicePct;
        let sliceQty = parseFloat(rawSliceQty.toFixed(3));
        
        // If it's the last TP (level 6), close everything remaining
        if (tp.level === 6) {
            sliceQty = position.currentQty;
        }
        
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
                    details: `Hit TP${tp.level} (${(tp.roi * 100).toFixed(0)}% ROI).`,
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
                    ...(tp.slRoi === 0 ? { beApplied: true } : {})
                }
            });
            
            position.currentQty = newQty;
        }

        let newSlPriceMessage = "Finalizado";

        // Only update SL if there's remaining qty and a target SL ROI
        if (position.currentQty > 0 && tp.slRoi !== null) {
            const slPrice = this.calculateSlPrice(position.entryPrice, position.side, tp.slRoi);
            await this.updateStopLoss(position, slPrice);
            newSlPriceMessage = `Movido para ${slPrice} (${(tp.slRoi * 100).toFixed(0)}% ROI)`;
        }

        await this.telegram.send(`🎯 *TP${tp.level} Atingido!*\nPar: \`${position.symbol}\`\nPreço: \`${currentPrice}\`\nROI: \`${(currentRoi * 100).toFixed(2)}%\`\nFechado: \`${qtyToClose}\` (Restam: \`${position.currentQty}\`)\nNovo Stop Loss: ${newSlPriceMessage}`);
    }

    private calculateSlPrice(entryPrice: number, side: string, targetRoi: number): number {
        // targetRoi: 0 = BE, 0.10 = 10% profit
        // leverage = 20
        // PNL = (exit - entry) / entry * 20
        // exit = entry + (PNL * entry / 20) for LONG
        // exit = entry - (PNL * entry / 20) for SHORT
        
        const priceDelta = entryPrice * (targetRoi / env.LEVERAGE);
        
        if (side === 'BUY') {
            return parseFloat((entryPrice + priceDelta).toFixed(2));
        } else {
            return parseFloat((entryPrice - priceDelta).toFixed(2));
        }
    }

    private async updateStopLoss(position: PositionData, slPrice: number): Promise<void> {
        this.logger.info({ symbol: position.symbol, slPrice }, 'Updating Stop Loss');
        await this.exchange.cancelAllOpenOrders(position.symbol);

        if (position.currentQty > 0) {
            const exchangeSide = position.side === 'BUY' ? 'SELL' : 'BUY';
            
            try {
                await this.exchange.setTradingStop({
                    symbol: position.symbol,
                    side: exchangeSide,
                    stopLoss: String(slPrice),
                    qty: String(position.currentQty),
                });
                
                await prisma.position.update({
                    where: { id: position.id },
                    data: { slPrice: slPrice }
                });
                
                this.logger.info({ symbol: position.symbol, slPrice }, 'Stop loss updated successfully');
            } catch (err) {
                this.logger.error({ err, symbol: position.symbol }, 'CRITICAL ERROR: Failed to update stop loss! Position is unprotected.');
                await this.telegram.notifyError(
                    'EMERGENCY PANIC',
                    new Error(`FALHA CRÍTICA: Corretora recusou atualizar o Stop Loss no TP! Fechando o restante da posição ${position.symbol} a mercado para proteger o lucro.`)
                );
                
                try {
                    const panicSide = position.side === 'BUY' ? 'SELL' : 'BUY';
                    await this.exchange.placeOrder({
                        symbol: position.symbol,
                        side: panicSide,
                        qty: String(position.currentQty),
                        reduceOnly: true,
                    });
                    
                    await prisma.position.update({
                        where: { id: position.id },
                        data: { currentQty: 0, status: 'closed' }
                    });
                    position.currentQty = 0;
                    await this.telegram.notifyError('EMERGENCY PANIC', new Error(`Posição fechada com sucesso em modo de segurança.`));
                } catch (panicErr) {
                    this.logger.error({ panicErr }, 'FATAL: Could not emergency close after failed SL update!');
                }
            }
        }
    }
}
