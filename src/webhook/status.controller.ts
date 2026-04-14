import type { FastifyInstance } from 'fastify';
import { BinanceAdapter } from '../infra/binance-adapter.js';
import { prisma } from '../infra/prisma.js';

/**
 * Status routes — check Binance connection and current position.
 */
export async function statusController(app: FastifyInstance): Promise<void> {
    const exchange = new BinanceAdapter(app.log);

    /**
     * GET /status/position
     * Fetches the current ETHUSDT position from Binance Testnet.
     * Use this to verify the API keys are working.
     */
    app.get('/status/position', async (_request, reply) => {
        try {
            const position = await exchange.getPosition('ETHUSDT');

            if (!position) {
                return reply.status(200).send({
                    status: 'ok',
                    position: 'FLAT',
                    message: 'No open ETHUSDT position on Binance Testnet',
                });
            }

            return reply.status(200).send({
                status: 'ok',
                position: {
                    symbol: position.symbol,
                    side: position.side,
                    size: position.size,
                    avgPrice: position.avgPrice,
                    unrealisedPnl: position.unrealisedPnl,
                    stopLoss: position.stopLoss,
                },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            app.log.error({ err }, 'Failed to fetch position from Binance');
            return reply.status(500).send({
                status: 'error',
                message,
            });
        }
    });

    /**
     * GET /status/balance
     * Fetches wallet balance from Binance Testnet.
     */
    app.get('/status/balance', async (_request, reply) => {
        try {
            const balance = await exchange.getWalletBalance();
            return reply.status(200).send({ status: 'ok', balance });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            app.log.error({ err }, 'Failed to fetch balance from Binance');
            return reply.status(500).send({ status: 'error', message });
        }
    });
    /**
     * GET /status/history
     * Fetches the recent 20 positions history from the bot's local SQLite ledger.
     */
    app.get('/status/history', async (_request, reply) => {
        try {
            const history = await prisma.position.findMany({
                orderBy: { createdAt: 'desc' },
                take: 20,
            });
            return reply.status(200).send({ status: 'ok', history });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            app.log.error({ err }, 'Failed to fetch history from database');
            return reply.status(500).send({ status: 'error', message });
        }
    });
}
