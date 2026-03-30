import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { webhookController } from './webhook/webhook.controller.js';
import { statusController } from './webhook/status.controller.js';
import { prisma } from './infra/prisma.js';

const app = Fastify({
    logger: {
        level: env.NODE_ENV === 'development' ? 'debug' : 'info',
        transport:
            env.NODE_ENV === 'development'
                ? { target: 'pino-pretty', options: { colorize: true } }
                : undefined,
    },
});

await app.register(cors, {
    origin: '*', // Allow Next.js during dev MVP
});

// ── Health check ─────────────────────────────────
app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: env.NODE_ENV,
}));

// ── Routes ───────────────────────────────────────
await app.register(webhookController);
await app.register(statusController);

// ── Graceful shutdown ────────────────────────────
const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal} — shutting down gracefully`);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ── Start ────────────────────────────────────────
try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`🚀 Bot Trader running on port ${env.PORT} (${env.NODE_ENV})`);
} catch (err) {
    app.log.fatal(err, 'Failed to start server');
    await prisma.$disconnect();
    process.exit(1);
}
