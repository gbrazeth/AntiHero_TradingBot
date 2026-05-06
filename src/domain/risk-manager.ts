import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../infra/prisma.js';
import { env } from '../config/env.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface RiskParams {
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
}

export interface RiskResult {
    allowed: boolean;
    reason?: string;
    qty: number;
    slPrice: number;
    tp1Price: number;
    tp2Price: number;
    tp3Price: number;
    tp4Price: number;
    tp5Price: number;
}

export interface BreakEvenResult {
    newSl: number;
    applied: boolean;
}

// ─── RiskManager ──────────────────────────────────────────────────────────

/**
 * RiskManager — Domain layer.
 *
 * Responsibilities:
 *  - Daily drawdown kill switch (DAILY_DD_LIMIT)
 *  - Position size calculation (fixed_usdt mode)
 *  - Stop loss price calculation (entry ± SL_PCT)
 *  - Break-even logic (SL → entry + BE_BUFFER after first partial)
 *  - Exposure cap (CAP_EXPOSURE_PCT check)
 *  - Minimum remaining position check
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
            return { allowed: false, reason: 'Kill switch active for today', qty: 0, slPrice: 0, tp1Price: 0, tp2Price: 0, tp3Price: 0, tp4Price: 0, tp5Price: 0 };
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
                    tp1Price: 0,
                    tp2Price: 0,
                    tp3Price: 0,
                    tp4Price: 0,
                    tp5Price: 0,
                };
            }
        }

        // 2. Existing open position check moved to StrategyEngine for auto-reversal support

        // 3. Calculate qty (fixed_usdt mode)
        const qty = this.calcQty(env.QTY_VALUE_USDT, params.entryPrice);

        // 4. Calculate SL price & TP prices (ROI targets at 20x leverage: 1%, 2%, 3%, 4%, 5%)
        const slPrice = this.calcSl(params.side, params.entryPrice);
        const tp1Price = this.calcTp(params.side, params.entryPrice, 0.0100); // 20% ROI
        const tp2Price = this.calcTp(params.side, params.entryPrice, 0.0200); // 40% ROI
        const tp3Price = this.calcTp(params.side, params.entryPrice, 0.0300); // 60% ROI
        const tp4Price = this.calcTp(params.side, params.entryPrice, 0.0400); // 80% ROI
        const tp5Price = this.calcTp(params.side, params.entryPrice, 0.0500); // 100% ROI

        this.logger.info(
            { symbol: params.symbol, side: params.side, qty, slPrice, tp1Price, tp2Price, tp3Price, tp4Price, tp5Price },
            'Risk check passed — entry allowed',
        );

        return { allowed: true, qty, slPrice, tp1Price, tp2Price, tp3Price, tp4Price, tp5Price };
    }

    /**
     * Evaluates whether a partial exit is allowed (min remaining position check).
     * @param pct - The partial exit percentage (e.g. 0.25 or 0.50)
     * @returns qty to close as a precise string
     */
    checkPartialExit(params: {
        currentQty: number;
        pct: number;
        entryPrice: number;
    }): { allowed: boolean; qtyToClose: number; reason?: string } {
        const qtyToClose = parseFloat((params.currentQty * params.pct).toFixed(3));
        const remaining = params.currentQty - qtyToClose;
        const remainingPct = remaining / params.currentQty;

        if (remainingPct < env.MIN_REMAINING_POSITION_PCT) {
            return {
                allowed: false,
                qtyToClose: 0,
                reason: `Remaining position (${(remainingPct * 100).toFixed(1)}%) below minimum (${(env.MIN_REMAINING_POSITION_PCT * 100).toFixed(0)}%)`,
            };
        }

        return { allowed: true, qtyToClose };
    }

    /**
     * Calculates the break-even SL price.
     * For LONG: entry + BE_BUFFER
     * For SHORT: entry - BE_BUFFER
     */
    calcBreakEven(side: 'LONG' | 'SHORT', entryPrice: number): number {
        const buffer = entryPrice * env.BE_BUFFER;
        return side === 'LONG'
            ? parseFloat((entryPrice + buffer).toFixed(2))
            : parseFloat((entryPrice - buffer).toFixed(2));
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
     * e.g. 50 USDT at 1850 ETH = 0.027 ETH
     */
    private calcQty(usdtAmount: number, price: number): number {
        return parseFloat((usdtAmount / price).toFixed(3));
    }

    /**
     * Stop-loss price based on SL_PCT from env.
     * LONG SL = entry * (1 - SL_PCT)
     * SHORT SL = entry * (1 + SL_PCT)
     */
    private calcSl(side: 'LONG' | 'SHORT', entryPrice: number): number {
        const slDelta = entryPrice * env.SL_PCT;
        return side === 'LONG'
            ? parseFloat((entryPrice - slDelta).toFixed(2))
            : parseFloat((entryPrice + slDelta).toFixed(2));
    }

    /**
     * Take-profit price based on pct target.
     * LONG TP = entry * (1 + pct)
     * SHORT TP = entry * (1 - pct)
     */
    private calcTp(side: 'LONG' | 'SHORT', entryPrice: number, pct: number): number {
        const tpDelta = entryPrice * pct;
        return side === 'LONG'
            ? parseFloat((entryPrice + tpDelta).toFixed(2))
            : parseFloat((entryPrice - tpDelta).toFixed(2));
    }

    private todayStr(): string {
        return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    }
}
