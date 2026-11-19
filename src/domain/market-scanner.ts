import type { FastifyBaseLogger } from 'fastify';
import { BloFinAdapter } from '../infra/blofin-adapter.js';
import { env } from '../config/env.js';
import { prisma } from '../infra/prisma.js';
import { createIdempotencyHash } from '../utils/hash.js';
import type { WebhookPayload } from '../webhook/webhook.schema.js';

export interface ScannerSnapshot {
    enabled: boolean;
    symbol: string;
    timeframe: string;
    lastCheckAt: string | null;
    currentBarTimestamp: string | null;
    closePrice: number | null;
    sma9: number | null;
    wma250: number | null;
    prevSma9: number | null;
    prevWma250: number | null;
    trend: 'BULLISH (SMA9 > WMA250)' | 'BEARISH (SMA9 < WMA250)' | 'NEUTRAL';
    distanceFromWmaPct: number | null;
    wmaFilterLimitPct: number;
    lastTriggeredBar: string | null;
    lastTriggeredEvent: string | null;
}

/**
 * MarketScanner — Built-in TradingView Replacement Engine (Setup Pedro v4.1)
 *
 * Polls BloFin 1H candles directly every 15 seconds, computes:
 *  - SMA(9)
 *  - WMA(250)
 *  - Crossover (SMA9 crosses above WMA250 -> SMA_ENTRY_LONG)
 *  - Crossunder (SMA9 crosses below WMA250 -> SMA_ENTRY_SHORT)
 *
 * Matches TradingView's `alert.freq_once_per_bar` behavior by keying idempotency
 * on the 1H candle open timestamp (`barTimestampIso`).
 */
export class MarketScanner {
    private lastSnapshot: ScannerSnapshot = {
        enabled: env.NATIVE_SCANNER_ENABLED,
        symbol: env.SCANNER_SYMBOL,
        timeframe: env.SCANNER_TIMEFRAME,
        lastCheckAt: null,
        currentBarTimestamp: null,
        closePrice: null,
        sma9: null,
        wma250: null,
        prevSma9: null,
        prevWma250: null,
        trend: 'NEUTRAL',
        distanceFromWmaPct: null,
        wmaFilterLimitPct: env.WMA_FILTER_PCT * 100,
        lastTriggeredBar: null,
        lastTriggeredEvent: null,
    };

    constructor(
        private readonly logger: FastifyBaseLogger,
        private readonly exchange: BloFinAdapter,
        private readonly onSignal: (payload: WebhookPayload, signalId: number) => Promise<void>
    ) {}

    public getSnapshot(): ScannerSnapshot {
        return this.lastSnapshot;
    }

    /**
     * Evaluates the latest 300 1H candles from BloFin and triggers a signal if a crossover occurs.
     */
    public async scanOnce(): Promise<ScannerSnapshot> {
        if (!env.NATIVE_SCANNER_ENABLED) {
            return this.lastSnapshot;
        }

        const symbol = env.SCANNER_SYMBOL;
        const bar = env.SCANNER_TIMEFRAME;
        const candles = await this.exchange.getCandles(symbol, bar, 300);

        if (candles.length < 252) {
            this.logger.warn({ count: candles.length }, 'Not enough candles to compute WMA(250)');
            return this.lastSnapshot;
        }

        const closes = candles.map((c) => c.close);
        const currIdx = closes.length - 1;
        const prevIdx = closes.length - 2;

        const currBar = candles[currIdx]!;
        const currBarIso = new Date(currBar.timestamp).toISOString();

        const sma9 = this.computeSma(closes, 9, currIdx);
        const wma250 = this.computeWma(closes, 250, currIdx);

        const prevSma9 = this.computeSma(closes, 9, prevIdx);
        const prevWma250 = this.computeWma(closes, 250, prevIdx);

        const closePrice = currBar.close;
        const distPct = ((closePrice - wma250) / wma250) * 100;

        this.lastSnapshot = {
            enabled: env.NATIVE_SCANNER_ENABLED,
            symbol,
            timeframe: bar,
            lastCheckAt: new Date().toISOString(),
            currentBarTimestamp: currBarIso,
            closePrice,
            sma9: parseFloat(sma9.toFixed(2)),
            wma250: parseFloat(wma250.toFixed(2)),
            prevSma9: parseFloat(prevSma9.toFixed(2)),
            prevWma250: parseFloat(prevWma250.toFixed(2)),
            trend: sma9 > wma250 ? 'BULLISH (SMA9 > WMA250)' : sma9 < wma250 ? 'BEARISH (SMA9 < WMA250)' : 'NEUTRAL',
            distanceFromWmaPct: parseFloat(distPct.toFixed(2)),
            wmaFilterLimitPct: env.WMA_FILTER_PCT * 100,
            lastTriggeredBar: this.lastSnapshot.lastTriggeredBar,
            lastTriggeredEvent: this.lastSnapshot.lastTriggeredEvent,
        };

        // Pine Script ta.crossover(sma_9, wma_250): prevSma9 <= prevWma250 && sma9 > wma250
        const crossUp = prevSma9 <= prevWma250 && sma9 > wma250;
        // Pine Script ta.crossunder(sma_9, wma_250): prevSma9 >= prevWma250 && sma9 < wma250
        const crossDown = prevSma9 >= prevWma250 && sma9 < wma250;

        if (!crossUp && !crossDown) {
            return this.lastSnapshot;
        }

        const event = crossUp ? 'SMA_ENTRY_LONG' : 'SMA_ENTRY_SHORT';

        // Check WMA 2% filter (same rule as Pine Script & RiskManager)
        const wmaThreshold = env.WMA_FILTER_PCT;
        const isWmaOkLong = closePrice <= wma250 * (1 + wmaThreshold);
        const isWmaOkShort = closePrice >= wma250 * (1 - wmaThreshold);

        if ((crossUp && !isWmaOkLong) || (crossDown && !isWmaOkShort)) {
            this.logger.info(
                { event, closePrice, wma250, distPct: distPct.toFixed(2) },
                'Native Scanner detected SMA9xWMA250 crossover, but blocked by WMA distance filter'
            );
            return this.lastSnapshot;
        }

        // Enforce once_per_bar idempotency using the candle's opening timestamp
        const hash = createIdempotencyHash(symbol, event, currBarIso);
        const existing = await prisma.signal.findUnique({
            where: { idempotencyHash: hash },
        });

        if (existing) {
            return this.lastSnapshot;
        }

        const payload: WebhookPayload = {
            strategy_id: 'PEDRO_NATIVE_V41',
            exchange: 'BLOFIN',
            symbol,
            timeframe: '60',
            price: closePrice,
            timestamp: currBarIso,
            bar_close: false,
            event,
            wma_250: parseFloat(wma250.toFixed(2)),
        };

        const signal = await prisma.signal.create({
            data: {
                strategyId: payload.strategy_id,
                exchange: payload.exchange,
                symbol: payload.symbol,
                timeframe: payload.timeframe,
                price: payload.price,
                signalTimestamp: payload.timestamp,
                barClose: false,
                event: payload.event,
                idempotencyHash: hash,
            },
        });

        this.lastSnapshot.lastTriggeredBar = currBarIso;
        this.lastSnapshot.lastTriggeredEvent = event;

        this.logger.info(
            { signalId: signal.id, event, closePrice, sma9, wma250, bar: currBarIso },
            '🚀 Native MarketScanner triggered SMA9 x WMA250 signal!'
        );

        await this.onSignal(payload, signal.id);
        return this.lastSnapshot;
    }

    private computeSma(values: number[], length: number, endIndex: number): number {
        let sum = 0;
        for (let i = 0; i < length; i++) {
            sum += values[endIndex - i]!;
        }
        return sum / length;
    }

    private computeWma(values: number[], length: number, endIndex: number): number {
        let norm = 0;
        let sum = 0;
        for (let i = 0; i < length; i++) {
            const weight = length - i;
            norm += weight;
            sum += values[endIndex - i]! * weight;
        }
        return sum / norm;
    }
}
