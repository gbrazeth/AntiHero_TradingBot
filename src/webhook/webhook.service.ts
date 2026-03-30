import type { FastifyBaseLogger } from 'fastify';
import type { WebhookPayload } from './webhook.schema.js';
import { prisma } from '../infra/prisma.js';
import { createIdempotencyHash } from '../utils/hash.js';
import { StrategyEngine } from '../domain/strategy-engine.js';

export class WebhookService {
    private readonly strategy: StrategyEngine;

    constructor(private readonly logger: FastifyBaseLogger) {
        this.strategy = new StrategyEngine(logger);
    }

    /**
     * Process an incoming webhook signal.
     *
     * Pipeline:
     *  1. Idempotency check (hash = symbol|event|timestamp)
     *  2. Persist signal record
     *  3. Hand off to StrategyEngine for execution
     *
     * @returns { id, isNew } — isNew=false means duplicate, return 409
     */
    async processSignal(payload: WebhookPayload): Promise<{ id: number; isNew: boolean }> {
        const hash = createIdempotencyHash(payload.symbol, payload.event, payload.timestamp);

        // ── 1. Idempotency ───────────────────────────────────────────────
        const existing = await prisma.signal.findUnique({
            where: { idempotencyHash: hash },
        });

        if (existing) {
            this.logger.warn(
                { hash, event: payload.event },
                'Duplicate signal detected — skipping',
            );
            return { id: existing.id, isNew: false };
        }

        // ── 2. Persist signal ────────────────────────────────────────────
        const signal = await prisma.signal.create({
            data: {
                strategyId: payload.strategy_id,
                exchange: payload.exchange,
                symbol: payload.symbol,
                timeframe: payload.timeframe,
                price: payload.price,
                signalTimestamp: payload.timestamp,
                barClose: payload.bar_close,
                event: payload.event,
                idempotencyHash: hash,
            },
        });

        this.logger.info(
            { signalId: signal.id, event: payload.event, price: payload.price },
            'Signal persisted — passing to StrategyEngine',
        );

        // ── 3. Execute via StrategyEngine (non-blocking for HTTP response) ─
        // We fire-and-forget so the webhook returns fast (< 1 s to TradingView).
        // Errors are caught and logged inside StrategyEngine.
        void this.strategy.handleSignal(payload, signal.id).catch((err: unknown) => {
            this.logger.error(
                { err, signalId: signal.id, event: payload.event },
                'StrategyEngine threw an unhandled error',
            );
        });

        return { id: signal.id, isNew: true };
    }
}
