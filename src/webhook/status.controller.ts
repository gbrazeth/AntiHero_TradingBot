import type { FastifyInstance } from 'fastify';
import { BybitAdapter } from '../infra/bybit-adapter.js';

/**
 * Status routes — check Bybit connection and current position.
 */
export async function statusController(app: FastifyInstance): Promise<void> {
    const bybit = new BybitAdapter(app.log);

    /**
     * GET /status/position
     * Fetches the current ETHUSDT position from Bybit Testnet.
     * Use this to verify the API keys are working.
     */
    app.get('/status/position', async (_request, reply) => {
        try {
            const position = await bybit.getPosition('ETHUSDT');

            if (!position) {
                return reply.status(200).send({
                    status: 'ok',
                    position: 'FLAT',
                    message: 'No open ETHUSDT position on Bybit Testnet',
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
            app.log.error({ err }, 'Failed to fetch position from Bybit');
            return reply.status(500).send({
                status: 'error',
                message,
            });
        }
    });

    /**
     * GET /status/balance
     * Fetches wallet balance from Bybit Testnet.
     */
    app.get('/status/balance', async (_request, reply) => {
        try {
            const balance = await bybit.getWalletBalance();
            return reply.status(200).send({ status: 'ok', balance });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            app.log.error({ err }, 'Failed to fetch balance from Bybit');
            return reply.status(500).send({ status: 'error', message });
        }
    });
}
