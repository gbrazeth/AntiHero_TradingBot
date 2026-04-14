import type { FastifyBaseLogger } from 'fastify';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

import { prisma } from './prisma.js';

// ─── Binance API Types ────────────────────────────────────────────────────

export interface BinancePosition {
    symbol: string;
    positionAmt: string; // Negative for short, positive for long
    entryPrice: string;
    unRealizedProfit: string;
    positionSide: 'BOTH' | 'LONG' | 'SHORT';
}

interface BinanceBalance {
    asset: string;
    balance: string;
    crossWalletBalance: string;
    crossUnPnl: string;
    availableBalance: string;
    maxWithdrawAmount: string;
}

// ─── BinanceAdapter ─────────────────────────────────────────────────────────

export class BinanceAdapter {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly apiSecret: string;
    private readonly recvWindow = 10000;

    constructor(private readonly logger: FastifyBaseLogger) {
        this.baseUrl = env.BINANCE_BASE_URL;
        this.apiKey = env.BINANCE_API_KEY;
        this.apiSecret = env.BINANCE_API_SECRET;
    }

    // ── Public Methods ───────────────────────────────────────────────────

    async placeOrder(params: {
        symbol: string;
        side: 'BUY' | 'SELL';
        qty: string;
        reduceOnly?: boolean;
    }): Promise<string> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ params, mode: 'MOCK' }, 'MOCK: Placing order');
            return `mock_order_${Date.now()}`;
        }

        this.logger.info({ params }, 'Placing order on Binance');

        const qsParams = new URLSearchParams({
            symbol: params.symbol,
            side: params.side,
            type: 'MARKET',
            quantity: params.qty,
        });

        if (params.reduceOnly) {
            qsParams.append('reduceOnly', 'true');
        }

        const result = await this.post<{ orderId: number }>('/fapi/v1/order', qsParams.toString());
        this.logger.info({ orderId: result.orderId, ...params }, 'Order placed successfully');
        return String(result.orderId);
    }

    async getPosition(symbol: string): Promise<{
        symbol: string;
        side: 'BUY' | 'SELL' | 'None';
        size: string;
        avgPrice: string;
        unrealisedPnl: string;
        stopLoss: string;
    } | null> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ symbol, mode: 'MOCK' }, 'MOCK: Fetching position from local DB');
            const pos = await prisma.position.findFirst({
                where: { symbol, status: 'open' },
            });
            if (!pos) return null;
            return {
                symbol: pos.symbol,
                side: pos.side.toUpperCase() as 'BUY' | 'SELL',
                size: String(pos.currentQty),
                avgPrice: String(pos.entryPrice),
                unrealisedPnl: '0.00 (MOCK - Real PNL from Binance)',
                stopLoss: String(pos.slPrice ?? ''),
            };
        }

        const qsParams = new URLSearchParams({ symbol });
        const positions = await this.get<BinancePosition[]>(`/fapi/v2/positionRisk?${qsParams.toString()}`);
        
        const pos = positions.find((p) => p.symbol === symbol && p.positionSide === 'BOTH');
        
        if (!pos || Number(pos.positionAmt) === 0) {
            return null;
        }

        const amt = Number(pos.positionAmt);
        return {
            symbol: pos.symbol,
            side: amt > 0 ? 'BUY' : 'SELL',
            size: Math.abs(amt).toString(),
            avgPrice: pos.entryPrice,
            unrealisedPnl: pos.unRealizedProfit,
            stopLoss: '', // Binance doesn't return stop loss on the positionRisk endpoint directly
        };
    }

    async setTradingStop(params: {
        symbol: string;
        stopLoss: string;
        side: 'BUY' | 'SELL';
        qty: string;
    }): Promise<void> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ params, mode: 'MOCK' }, 'MOCK: Setting trading stop');
            return;
        }

        this.logger.info({ params }, 'Setting trading stop on Binance');
        
        // Binance SL logic: Close the position with a STOP_MARKET order.
        // If we are LONG ('BUY'), the SL must be a SELL.
        // If we are SHORT ('SELL'), the SL must be a BUY.
        const slSide = params.side === 'BUY' ? 'SELL' : 'BUY';

        const qsParams = new URLSearchParams({
            symbol: params.symbol,
            side: slSide,
            type: 'STOP_MARKET',
            stopPrice: params.stopLoss,
            reduceOnly: 'true',
            quantity: params.qty,
            workingType: 'MARK_PRICE',
        });

        // It might be necessary to cancel existing SL orders first using logic here, 
        // but for now we follow the adapter pattern.
        await this.post('/fapi/v1/order', qsParams.toString());
        this.logger.info({ symbol: params.symbol, stopLoss: params.stopLoss }, 'Trading stop set');
    }

    async setTakeProfit(params: {
        symbol: string;
        tpPrice: string;
        side: 'BUY' | 'SELL';
        qty: string;
    }): Promise<void> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ params, mode: 'MOCK' }, 'MOCK: Setting take profit');
            return;
        }

        this.logger.info({ params }, 'Setting take profit on Binance');
        
        const tpSide = params.side === 'BUY' ? 'SELL' : 'BUY';

        const qsParams = new URLSearchParams({
            symbol: params.symbol,
            side: tpSide,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: params.tpPrice,
            reduceOnly: 'true',
            quantity: params.qty,
            workingType: 'MARK_PRICE',
        });

        await this.post('/fapi/v1/order', qsParams.toString());
        this.logger.info({ symbol: params.symbol, tpPrice: params.tpPrice }, 'Take profit target set');
    }

    async getWalletBalance(): Promise<{ coin: string; equity: string; availableBalance: string }[]> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ mode: 'MOCK' }, 'MOCK: Fetching wallet balance');
            return [{ coin: 'USDT', equity: '10000.00', availableBalance: '10000.00' }];
        }

        const balances = await this.get<BinanceBalance[]>('/fapi/v2/balance');
        return balances
            .filter((b) => Number(b.balance) > 0 || Number(b.availableBalance) > 0)
            .map((c) => ({
                coin: c.asset,
                equity: c.crossWalletBalance,
                availableBalance: c.availableBalance,
            }));
    }

    // ── Private HTTP helpers ─────────────────────────────────────────────

    private sign(queryString: string): string {
        return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
    }

    private buildHeaders(): Record<string, string> {
        return {
            'X-MBX-APIKEY': this.apiKey,
            'Content-Type': 'application/x-www-form-urlencoded',
        };
    }

    private async post<T>(path: string, qs: string): Promise<T> {
        const timestamp = Date.now().toString();
        const baseQs = qs ? `${qs}&` : '';
        const qsWithRecv = `${baseQs}recvWindow=${this.recvWindow}&timestamp=${timestamp}`;
        const signature = this.sign(qsWithRecv);
        
        const finalQs = `${qsWithRecv}&signature=${signature}`;
        const url = `${this.baseUrl}${path}?${finalQs}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: this.buildHeaders(),
        });

        const data = await response.json() as Record<string, unknown>;
        this.assertSuccess(data, path);
        return data as unknown as T;
    }

    private async get<T>(pathWithQs: string): Promise<T> {
        const timestamp = Date.now().toString();
        
        const parts = pathWithQs.split('?');
        const path = parts[0] ?? '';
        const originalQs = parts[1] ?? '';
        const baseQs = originalQs ? `${originalQs}&` : '';
        const qsWithRecv = `${baseQs}recvWindow=${this.recvWindow}&timestamp=${timestamp}`;
        const signature = this.sign(qsWithRecv);
        
        const finalQs = `${qsWithRecv}&signature=${signature}`;
        const url = `${this.baseUrl}${path}?${finalQs}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: this.buildHeaders(),
        });

        const data = await response.json() as Record<string, unknown>;
        this.assertSuccess(data, path);
        return data as unknown as T;
    }

    private assertSuccess(data: Record<string, unknown>, path: string): void {
        if (typeof data.code === 'number' && data.code < 0) {
            throw new Error(
                `Binance API error on ${path}: [${data.code}] ${data.msg}`,
            );
        }
    }
}
