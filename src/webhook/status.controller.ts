import type { FastifyInstance } from 'fastify';
import { BloFinAdapter } from '../infra/blofin-adapter.js';
import { prisma } from '../infra/prisma.js';
import { env } from '../config/env.js';

/**
 * Status routes — check BloFin connection and current position.
 */
export async function statusController(app: FastifyInstance): Promise<void> {
    const exchange = new BloFinAdapter(app.log);

    // ── TEMPORARY RESET ENDPOINT ──────────────────────────────────────
    app.get('/status/reset', async (_request, reply) => {
        try {
            await prisma.position.updateMany({
                where: { status: 'open' },
                data: { status: 'closed', currentQty: 0 }
            });
            return reply.send(`
                <html>
                    <body style="background: #111; color: #0f0; font-family: monospace; padding: 50px; text-align: center;">
                        <h1>✅ TODAS AS POSICOES FORAM FECHADAS NO BANCO DE DADOS!</h1>
                        <p>Seu robo esta limpo e pronto para novos sinais.</p>
                        <a href="/" style="color: #fff;">Voltar</a>
                    </body>
                </html>
            `);
        } catch (error) {
            app.log.error(error);
            return reply.status(500).send({ error: 'Failed to reset positions' });
        }
    });

    /**
     * GET /status/position
     * Fetches the current ETHUSDT position from BloFin.
     * Use this to verify the API keys are working.
     */
    app.get('/status/position', async (_request, reply) => {
        try {
            const position = await exchange.getPosition('ETHUSDT');

            if (!position) {
                return reply.status(200).send({
                    status: 'ok',
                    position: 'FLAT',
                    message: 'No open ETHUSDT position on BloFin',
                });
            }

            // Fetch local position to get the Stop Loss
            const dbPos = await prisma.position.findFirst({
                where: { symbol: 'ETHUSDT', status: 'open' },
            });

            return reply.status(200).send({
                status: 'ok',
                position: {
                    symbol: position.symbol,
                    side: position.side,
                    size: position.size,
                    avgPrice: position.avgPrice,
                    markPrice: position.markPrice,
                    leverage: position.leverage,
                    unrealisedPnl: position.unrealisedPnl,
                    stopLoss: dbPos?.slPrice ? String(dbPos.slPrice) : 'N/A',
                },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            app.log.error({ err }, 'Failed to fetch position from BloFin');
            return reply.status(500).send({
                status: 'error',
                message,
            });
        }
    });

    /**
     * GET /status/balance
     * Fetches wallet balance from BloFin.
     */
    app.get('/status/balance', async (_request, reply) => {
        try {
            const balance = await exchange.getWalletBalance();
            return reply.status(200).send({ status: 'ok', balance });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            app.log.error({ err }, 'Failed to fetch balance from BloFin');
            return reply.status(500).send({ status: 'error', message });
        }
    });
    /**
     * GET /status/history
     * Fetches the recent 200 positions history from the bot's local SQLite ledger.
     */
    app.get('/status/history', async (_request, reply) => {
        try {
            const history = await prisma.position.findMany({
                orderBy: { createdAt: 'desc' },
                take: 200,
            });
            return reply.status(200).send({ status: 'ok', history });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            app.log.error({ err }, 'Failed to fetch history from database');
            return reply.status(500).send({ status: 'error', message });
        }
    });

    /**
     * GET /status/trade-logs
     * Fetches recent trade log events (entries, partial TPs, SL hits, etc.)
     * Optional query: ?positionId=X to filter by position
     */
    app.get('/status/trade-logs', async (request, reply) => {
        try {
            const query = request.query as { positionId?: string };
            const where = query.positionId
                ? { positionId: parseInt(query.positionId, 10) }
                : {};

            const logs = await prisma.tradeLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: 200,
            });
            return reply.status(200).send({ status: 'ok', logs });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            app.log.error({ err }, 'Failed to fetch trade logs');
            return reply.status(500).send({ status: 'error', message });
        }
    });

    /**
     * GET /status/pnl-summary
     * Returns a breakdown of realized and unrealized PnL.
     */
    app.get('/status/pnl-summary', async (_request, reply) => {
        try {
            // Total realized PnL from all closed positions
            const closedPositions = await prisma.position.findMany({
                where: { status: 'closed' },
                select: { realizedPnl: true },
            });
            const totalRealizedPnl = closedPositions.reduce(
                (sum, p) => sum + (p.realizedPnl ?? 0), 0
            );

            // Today's PnL from trade logs
            const startOfToday = new Date();
            startOfToday.setUTCHours(0, 0, 0, 0);

            const todaysLogs = await prisma.tradeLog.findMany({
                where: {
                    createdAt: {
                        gte: startOfToday,
                    },
                },
                select: { pnl: true },
            });
            const todayRealizedPnl = todaysLogs.reduce(
                (sum, l) => sum + (l.pnl ?? 0), 0
            );

            // Partial profits from current open position's trade logs
            const openPosition = await prisma.position.findFirst({
                where: { status: 'open' },
            });
            let partialProfitsTaken = 0;
            if (openPosition) {
                const partialLogs = await prisma.tradeLog.findMany({
                    where: {
                        positionId: openPosition.id,
                        event: { in: ['PARTIAL_TP', 'PARTIAL_EXIT'] },
                    },
                    select: { pnl: true },
                });
                partialProfitsTaken = partialLogs.reduce(
                    (sum, l) => sum + (l.pnl ?? 0), 0
                );
            }

            return reply.status(200).send({
                status: 'ok',
                summary: {
                    totalRealizedPnl: parseFloat(totalRealizedPnl.toFixed(4)),
                    todayRealizedPnl: parseFloat(todayRealizedPnl.toFixed(4)),
                    todayUnrealizedPnl: 0, // Not needed
                    partialProfitsTaken: parseFloat(partialProfitsTaken.toFixed(4)),
                },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            app.log.error({ err }, 'Failed to fetch PnL summary');
            return reply.status(500).send({ status: 'error', message });
        }
    });

    /**
     * GET /status/network
     * Returns whether the bot is connected to testnet or mainnet.
     */
    app.get('/status/network', async (_request, reply) => {
        const isMainnet = !env.BLOFIN_BASE_URL.includes('demo');
        return reply.send({
            exchange: 'BLOFIN',
            network: isMainnet ? 'mainnet' : 'testnet',
            baseUrl: env.BLOFIN_BASE_URL,
            authConfigured: {
                keyLen: env.BLOFIN_API_KEY.trim().length,
                secretLen: (env.BLOFIN_API_SECRET || env.BLOFIN_API_SEC).trim().length,
                passLen: env.BLOFIN_PASSPHRASE.trim().length,
            },
        });
    });
}
