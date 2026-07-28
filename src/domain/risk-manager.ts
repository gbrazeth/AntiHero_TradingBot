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
    tps: { price: number; pct: number }[];
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
     * Returns the TP and SL rules for a given scenario.
     */
    getScenarioRules(scenario: 'SCENARIO_1' | 'SCENARIO_2') {
        if (scenario === 'SCENARIO_1') {
            return [
                { tpRoi: 0.25, closePct: 0.10, slAction: 'MOVE_TO_ROI', slRoi: 0.00 }, // Break-even
                { tpRoi: 0.33, closePct: 0.10, slAction: 'NONE' },
                { tpRoi: 0.50, closePct: 0.30, slAction: 'MOVE_TO_ROI', slRoi: 0.10 },
                { tpRoi: 0.75, closePct: 0.30, slAction: 'MOVE_TO_ROI', slRoi: 0.25, activateTrailing: true },
            ];
        } else {
            return [
                { tpRoi: 0.10, closePct: 0.20, slAction: 'NONE' },
                { tpRoi: 0.20, closePct: 0.20, slAction: 'MOVE_TO_ROI', slRoi: -0.10 },
                { tpRoi: 0.33, closePct: 0.10, slAction: 'MOVE_TO_ROI', slRoi: 0.00 }, // Break-even
                { tpRoi: 0.50, closePct: 0.10, slAction: 'NONE' },
                { tpRoi: 0.75, closePct: 0.20, slAction: 'MOVE_TO_ROI', slRoi: 0.25, activateTrailing: true },
            ];
        }
    }

    /**
     * Helper to calculate TP prices for a set of rules.
     */
    calcTpsForRules(side: 'LONG' | 'SHORT', entryPrice: number, rules: ReturnType<typeof this.getScenarioRules>) {
        const leverage = env.LEVERAGE || 20;
        return rules.map(r => {
            const priceMovePct = r.tpRoi / leverage;
            return {
                price: this.calcTp(side, entryPrice, priceMovePct),
                pct: r.closePct,
                roi: r.tpRoi,
            };
        });
    }

    /**
     * Evaluates whether a new trade is allowed and returns sizing + SL.
     * By default, a new trade starts in SCENARIO_1.
     */
    async checkEntry(params: RiskParams): Promise<RiskResult> {
        // 1. Kill switch — check daily drawdown
        const today = this.todayStr();
        const dailyPnl = await prisma.dailyPnl.findUnique({ where: { date: today } });

        if (dailyPnl?.isKillSwitchActive) {
            this.logger.warn({ date: today }, 'Kill switch active — entry blocked');
            return { allowed: false, reason: 'Kill switch active for today', qty: 0, slPrice: 0, tps: [] };
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
                    tps: [],
                };
            }
        }

        // 2. Existing open position check moved to StrategyEngine for auto-reversal support

        // 3. Calculate qty (fixed_usdt mode)
        const qty = this.calcQty(env.QTY_VALUE_USDT, params.entryPrice);

        // 4. Calculate SL price & TP prices (Starting in SCENARIO_1)
        const slPrice = this.calcSl(params.side, params.entryPrice);
        
        const rules = this.getScenarioRules('SCENARIO_1');
        const tps = this.calcTpsForRules(params.side, params.entryPrice, rules);

        this.logger.info(
            { symbol: params.symbol, side: params.side, qty, slPrice, tps },
            'Risk check passed — entry allowed',
        );

        return { allowed: true, qty, slPrice, tps };
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
     * Calculates a conditional SL price based on a target ROI%.
     * Used when a TP level is hit and we want to move the SL to protect profits.
     * For example: when 20% ROI TP hits, move SL to -15% ROI level.
     * 
     * @param side - LONG or SHORT
     * @param entryPrice - Original entry price
     * @param targetRoi - Target ROI as decimal (e.g. -0.15 for -15% ROI)
     * @returns The new stop loss price
     */
    calcConditionalSl(side: 'LONG' | 'SHORT', entryPrice: number, targetRoi: number): number {
        const leverage = env.LEVERAGE || 20;
        const priceMovePct = targetRoi / leverage;
        const delta = entryPrice * priceMovePct;
        return side === 'LONG'
            ? parseFloat((entryPrice + delta).toFixed(2))
            : parseFloat((entryPrice - delta).toFixed(2));
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
