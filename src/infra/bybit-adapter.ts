import type { FastifyBaseLogger } from 'fastify';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

import { prisma } from './prisma.js';

// ─── Bybit V5 API Types ────────────────────────────────────────────────────

export interface BybitPosition {
    symbol: string;
    side: 'Buy' | 'Sell' | 'None';
    size: string;         // current qty as string
    avgPrice: string;     // entry price
    unrealisedPnl: string;
    stopLoss: string;
    positionIdx: number;
}

interface BybitResponse<T> {
    retCode: number;
    retMsg: string;
    result: T;
}

interface BybitOrderResult {
    orderId: string;
    orderLinkId: string;
}

interface BybitPositionList {
    list: BybitPosition[];
}

// ─── BybitAdapter ─────────────────────────────────────────────────────────

/**
 * BybitAdapter — Infrastructure layer.
 *
 * Communicates with Bybit V5 Testnet API using HMAC-SHA256 authentication.
 * Endpoints used:
 *   POST /v5/order/create           → place market orders
 *   GET  /v5/position/list          → fetch current ETHUSDT position
 *   POST /v5/position/trading-stop  → set SL / break-even
 *
 * Always uses:
 *   - orderType: Market
 *   - category: linear (USDT perpetuals)
 *   - positionIdx: 0 (One-way mode)
 */
export class BybitAdapter {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly apiSecret: string;
    private readonly recvWindow = 10000;

    constructor(private readonly logger: FastifyBaseLogger) {
        this.baseUrl = env.BYBIT_BASE_URL;
        this.apiKey = env.BYBIT_API_KEY;
        this.apiSecret = env.BYBIT_API_SECRET;
    }

    // ── Public Methods ───────────────────────────────────────────────────

    /**
     * Place a market order on Bybit Futures Testnet.
     * @returns bybitOrderId on success
     */
    async placeOrder(params: {
        symbol: string;
        side: 'Buy' | 'Sell';
        qty: string;
        reduceOnly?: boolean;
    }): Promise<string> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ params, mode: 'MOCK' }, 'MOCK: Placing order');
            return `mock_order_${Date.now()}`;
        }

        this.logger.info({ params }, 'Placing order on Bybit');

        const body = {
            category: 'linear',
            symbol: params.symbol,
            side: params.side,
            orderType: 'Market',
            qty: params.qty,
            positionIdx: 0,
            ...(params.reduceOnly ? { reduceOnly: true } : {}),
        };

        const result = await this.post<BybitOrderResult>('/v5/order/create', body);
        this.logger.info({ orderId: result.orderId, ...params }, 'Order placed successfully');
        return result.orderId;
    }

    /**
     * Fetch the current linear (USDT perp) position for a symbol.
     * Returns null when there is no open position.
     */
    async getPosition(symbol: string): Promise<BybitPosition | null> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ symbol, mode: 'MOCK' }, 'MOCK: Fetching position from local DB');
            const pos = await prisma.position.findFirst({
                where: { symbol, status: 'open' },
            });
            if (!pos) return null;
            return {
                symbol: pos.symbol,
                side: pos.side as 'Buy' | 'Sell',
                size: String(pos.currentQty),
                avgPrice: String(pos.entryPrice),
                unrealisedPnl: '0.00 (MOCK - Real PNL from Bybit)',
                stopLoss: String(pos.slPrice ?? ''),
                positionIdx: 0,
            };
        }

        const qs = new URLSearchParams({
            category: 'linear',
            symbol,
        });

        const result = await this.get<BybitPositionList>(`/v5/position/list?${qs.toString()}`);
        const pos = result.list[0] ?? null;

        if (!pos || pos.side === 'None' || pos.size === '0') {
            return null;
        }

        return pos;
    }

    /**
     * Set or update the stop-loss (or break-even) for an open position.
     */
    async setTradingStop(params: {
        symbol: string;
        stopLoss: string;
        positionIdx?: number;
    }): Promise<void> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ params, mode: 'MOCK' }, 'MOCK: Setting trading stop');
            return;
        }

        this.logger.info({ params }, 'Setting trading stop on Bybit');

        const body = {
            category: 'linear',
            symbol: params.symbol,
            stopLoss: params.stopLoss,
            positionIdx: params.positionIdx ?? 0,
        };

        await this.post<Record<string, unknown>>('/v5/position/trading-stop', body);
        this.logger.info({ symbol: params.symbol, stopLoss: params.stopLoss }, 'Trading stop set');
    }

    /**
     * Fetch wallet balance (unified trading account).
     */
    async getWalletBalance(): Promise<{ coin: string; equity: string; availableBalance: string }[]> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ mode: 'MOCK' }, 'MOCK: Fetching wallet balance');
            return [{ coin: 'USDT', equity: '10000.00', availableBalance: '10000.00' }];
        }

        const qs = new URLSearchParams({ accountType: 'UNIFIED' });
        const result = await this.get<{ list: { coin: { coin: string; equity: string; availableToWithdraw: string }[] }[] }>(
            `/v5/account/wallet-balance?${qs.toString()}`,
        );

        const coins = result.list[0]?.coin ?? [];
        return coins.map((c) => ({
            coin: c.coin,
            equity: c.equity,
            availableBalance: c.availableToWithdraw,
        }));
    }

    // ── Private HTTP helpers ─────────────────────────────────────────────

    private sign(timestamp: string, params: string): string {
        const payload = `${timestamp}${this.apiKey}${this.recvWindow}${params}`;
        return crypto.createHmac('sha256', this.apiSecret).update(payload).digest('hex');
    }

    private buildHeaders(timestamp: string, signature: string): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'X-BAPI-API-KEY': this.apiKey,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-SIGN': signature,
            'X-BAPI-RECV-WINDOW': String(this.recvWindow),
        };
    }

    private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
        const timestamp = Date.now().toString();
        const bodyStr = JSON.stringify(body);
        const signature = this.sign(timestamp, bodyStr);

        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: this.buildHeaders(timestamp, signature),
            body: bodyStr,
        });

        const data = (await response.json()) as BybitResponse<T>;
        this.assertSuccess(data, path);
        return data.result;
    }

    private async get<T>(pathWithQuery: string): Promise<T> {
        const timestamp = Date.now().toString();
        // For GET requests, the signed payload is the query string
        const qs = pathWithQuery.includes('?') ? pathWithQuery.split('?')[1] : '';
        const signature = this.sign(timestamp, qs ?? '');

        const url = `${this.baseUrl}${pathWithQuery}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: this.buildHeaders(timestamp, signature),
        });

        const data = (await response.json()) as BybitResponse<T>;
        this.assertSuccess(data, pathWithQuery);
        return data.result;
    }

    private assertSuccess(data: BybitResponse<unknown>, path: string): void {
        if (data.retCode !== 0) {
            throw new Error(
                `Bybit API error on ${path}: [${data.retCode}] ${data.retMsg}`,
            );
        }
    }
}
