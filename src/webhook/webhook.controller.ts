import type { FastifyInstance } from 'fastify';
import { webhookPayloadSchema } from './webhook.schema.js';
import { WebhookService } from './webhook.service.js';
import { env } from '../config/env.js';

/**
 * Registers the webhook routes on the Fastify instance.
 */
export async function webhookController(app: FastifyInstance): Promise<void> {
    const service = new WebhookService(app.log);

    app.post('/webhook/tradingview', async (request, reply) => {
        // ── 1. Authentication ───────────────────────────
        const query = request.query as { token?: string };
        const token = query.token || request.headers['x-webhook-token'];

        if (!token || token !== env.WEBHOOK_TOKEN) {
            app.log.warn({ ip: request.ip }, 'Unauthorized webhook request');
            return reply.status(401).send({
                error: 'Unauthorized',
                message: 'Invalid or missing Token',
            });
        }

        // ── 2. Payload Validation ───────────────────────
        const parsed = webhookPayloadSchema.safeParse(request.body);

        if (!parsed.success) {
            const errors = parsed.error.flatten().fieldErrors;
            app.log.warn({ errors }, 'Webhook payload validation failed');
            return reply.status(400).send({
                error: 'Validation Error',
                details: errors,
            });
        }

        // ── 3. Process Signal ───────────────────────────
        const result = await service.processSignal(parsed.data);

        if (!result.isNew) {
            return reply.status(409).send({
                error: 'Duplicate',
                message: 'Signal already processed',
                signalId: result.id,
            });
        }

        return reply.status(200).send({
            received: true,
            signalId: result.id,
        });
    });
}
