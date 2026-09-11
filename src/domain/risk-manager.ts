import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../infra/prisma.js';
import { env } from '../config/env.js';

export interface RiskParams {
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    wma250?: number;
}

export interface RiskResult {
    allowed: boolean;
    reason?: string;
    qty: number;
    slPrice: number;
}

/**
 * RiskManager — Domain layer (Simplified for v3.0)
 *
 * Responsibilities:
 *  - Daily drawdown kill switch (DAILY_DD_LIMIT)
 *  - WMA 250 filter (1% distance check)
 *  - Position size calculation (fixed_usdt mode)
 *  - Stop loss price calculation (entry ± SL_PCT)
 */
export class RiskManager {
    constructor(private readonly logger: FastifyBaseLogger) { }

    /**
     * Evaluates whether a new trade is allowed and returns sizing + SL.
     */
    async checkEntry(params: RiskParams): Promise<RiskResult> {
        // 1. Kill switch — check daily drawdown
        const today = this.todayStr();
        const dailyPnl = await prisma.dailyPnl.findUnique({ where: { date: today } });

        if (dailyPnl?.isKillSwitchActive) {
            this.logger.warn({ date: today }, 'Kill switch active — entry blocked');
            return { allowed: false, reason: 'Kill switch active for today', qty: 0, slPrice: 0 };
        }

        if (dailyPnl) {
            const lossRatio = Math.abs(
                Math.min(dailyPnl.realizedPnl + dailyPnl.unrealizedPnl, 0),
            );
            if (lossRatio >= env.DAILY_DD_LIMIT) {
                this.logger.warn({ lossRatio }, 'Daily DD limit hit — activating kill switch');
                await prisma.dailyPnl.update({
                    where: { date: today },
                    data: { isKillSwitchActive: true },
                });
                return {
                    allowed: false,
                    reason: `Daily drawdown limit reached (${(lossRatio * 100).toFixed(2)}%)`,
                    qty: 0,
                    slPrice: 0,
                };
            }
        }

        // 2. WMA 250 Filter Check (1%)
        if (params.wma250) {
            if (params.side === 'LONG' && params.entryPrice > params.wma250 * 1.01) {
                this.logger.info(
                    { entryPrice: params.entryPrice, wma250: params.wma250 },
                    'LONG entry blocked by WMA(250) filter: price is >1% above WMA(250)',
                );
                return {
                    allowed: false,
                    reason: `LONG blocked: entry price (${params.entryPrice}) > 1% above WMA250 (${params.wma250})`,
                    qty: 0,
                    slPrice: 0,
                };
            } else if (params.side === 'SHORT' && params.entryPrice < params.wma250 * 0.99) {
                this.logger.info(
                    { entryPrice: params.entryPrice, wma250: params.wma250 },
                    'SHORT entry blocked by WMA(250) filter: price is >1% below WMA(250)',
                );
                return {
                    allowed: false,
                    reason: `SHORT blocked: entry price (${params.entryPrice}) > 1% below WMA250 (${params.wma250})`,
                    qty: 0,
                    slPrice: 0,
                };
            }
        }

        // 3. Calculate qty & SL
        const qty = this.calcQty(env.QTY_VALUE_USDT, params.entryPrice);
        const slPrice = this.calcSl(params.side, params.entryPrice);

        this.logger.info(
            { symbol: params.symbol, side: params.side, qty, slPrice },
            'Risk check passed — entry allowed',
        );

        return { allowed: true, qty, slPrice };
    }

    /**
     * Ensure today's DailyPnl row exists (upsert).
     */
    async ensureDailyPnlRow(): Promise<void> {
        const today = this.todayStr();
        await prisma.dailyPnl.upsert({
            where: { date: today },
            update: {},
            create: { date: today },
        });
    }

    // ── Private helpers ──────────────────────────────────────────────────

    /**
     * Qty in base asset for fixed-USDT mode.
     * e.g. 50 USDT at 2500 ETH = 0.020 ETH
     */
    private calcQty(usdtAmount: number, price: number): number {
        return parseFloat((usdtAmount / price).toFixed(3));
    }

    /**
     * Stop-loss price based on SL_PCT from env (e.g. 1%).
     * LONG SL = entry * (1 - SL_PCT)
     * SHORT SL = entry * (1 + SL_PCT)
     */
    private calcSl(side: 'LONG' | 'SHORT', entryPrice: number): number {
        const slDelta = entryPrice * env.SL_PCT;
        return side === 'LONG'
            ? parseFloat((entryPrice - slDelta).toFixed(2))
            : parseFloat((entryPrice + slDelta).toFixed(2));
    }

    private todayStr(): string {
        return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    }
}
