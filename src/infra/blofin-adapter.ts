import type { FastifyBaseLogger } from 'fastify';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';

// ─── BloFin API Types ────────────────────────────────────────────────────────

interface BloFinResponse<T> {
    code: string;
    msg: string;
    data: T;
}

interface BloFinInstrument {
    instId: string;
    contractValue: string; // e.g., "0.01" for ETH-USDT
    minSize: string;       // e.g., "0.1"
    lotSize: string;       // e.g., "0.1"
}

interface BloFinPosition {
    instId: string;
    marginMode: 'cross' | 'isolated';
    positionSide: 'net' | 'long' | 'short';
    leverage: string;
    positions: string;          // Signed in net mode (+ for long, - for short)
    availablePositions: string;
    averagePrice: string;
    markPrice: string;
    unrealizedPnl: string;
}

interface BloFinBalanceDetail {
    currency: string;
    equity: string;
    available: string;
    balance: string;
}

interface BloFinBalanceData {
    totalEquity: string;
    details: BloFinBalanceDetail[];
}

interface BloFinPendingTpsl {
    tpslId: string;
    instId: string;
    clientOrderId?: string;
}

interface BloFinPendingOrder {
    orderId: string;
    instId: string;
    clientOrderId?: string;
}

// ─── BloFinAdapter ───────────────────────────────────────────────────────────

export class BloFinAdapter {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly apiSecret: string;
    private readonly passphrase: string;
    private readonly contractValueCache = new Map<string, number>();
    private readonly configuredInstruments = new Set<string>();

    constructor(private readonly logger: FastifyBaseLogger) {
        this.baseUrl = env.BLOFIN_BASE_URL.trim();
        this.apiKey = env.BLOFIN_API_KEY.trim();
        this.apiSecret = (env.BLOFIN_API_SECRET || env.BLOFIN_API_SEC).trim();
        this.passphrase = env.BLOFIN_PASSPHRASE.trim();
    }

    // ── Symbol & Contract Conversion Helpers ─────────────────────────────

    /**
     * Converts TradingView symbol (e.g. "ETHUSDT") to BloFin instId ("ETH-USDT").
     */
    private toInstId(symbol: string): string {
        if (symbol.includes('-')) return symbol;
        if (symbol.endsWith('USDT')) {
            return `${symbol.slice(0, -4)}-USDT`;
        }
        return symbol;
    }

    /**
     * Fetches the contractValue (e.g. 0.01 ETH per contract for ETH-USDT) and caches it.
     */
    private async getContractValue(instId: string): Promise<number> {
        const cached = this.contractValueCache.get(instId);
        if (cached) return cached;

        try {
            const url = `${this.baseUrl}/api/v1/market/instruments?instId=${encodeURIComponent(instId)}`;
            const res = await fetch(url);
            const json = (await res.json()) as BloFinResponse<BloFinInstrument[]>;
            const inst = json.data?.[0];
            if (inst && Number(inst.contractValue) > 0) {
                const ctVal = Number(inst.contractValue);
                this.contractValueCache.set(instId, ctVal);
                return ctVal;
            }
        } catch (err) {
            this.logger.warn({ err, instId }, 'Failed to fetch BloFin contractValue, falling back to default');
        }

        // Default ETH-USDT contractValue on BloFin is 0.01 ETH
        return instId.startsWith('ETH-') ? 0.01 : 1;
    }

    /**
     * Converts base asset quantity (e.g. 0.743 ETH) to BloFin contract size (e.g. "74.3").
     * BloFin ETH-USDT has contractValue = 0.01 and lotSize = 0.1 (which is 0.001 ETH).
     */
    private async coinQtyToContracts(instId: string, coinQty: string | number): Promise<string> {
        const ctVal = await this.getContractValue(instId);
        const rawContracts = Number(coinQty) / ctVal;
        // Round to 1 decimal place (since lotSize = 0.1 contracts = 0.001 ETH)
        const rounded = Math.max(0.1, Math.round(rawContracts * 10) / 10);
        return parseFloat(rounded.toFixed(1)).toString();
    }

    /**
     * Converts BloFin contract size (e.g. "74.3") back to base asset quantity (e.g. 0.743 ETH).
     */
    private async contractsToCoinQty(instId: string, contracts: string | number): Promise<number> {
        const ctVal = await this.getContractValue(instId);
        return parseFloat((Number(contracts) * ctVal).toFixed(4));
    }

    /**
     * Ensures account is in One-Way (net_mode) and desired leverage is set on BloFin.
     */
    private async ensureInstrumentConfig(instId: string): Promise<void> {
        if (this.configuredInstruments.has(instId)) return;

        try {
            await this.post('/api/v1/account/set-position-mode', {
                positionMode: 'net_mode',
            });
        } catch (err) {
            // Ignore if already in net_mode or position is open
            this.logger.debug({ err }, 'set-position-mode net_mode notice');
        }

        try {
            await this.post('/api/v1/account/set-leverage', {
                instId,
                leverage: String(env.LEVERAGE || 20),
                marginMode: 'cross',
            });
            this.configuredInstruments.add(instId);
        } catch (err) {
            this.logger.warn({ err, instId }, 'Failed to auto-set leverage on BloFin');
        }
    }

    // ── Public Methods ───────────────────────────────────────────────────

    async placeOrder(params: {
        symbol: string;
        side: 'BUY' | 'SELL';
        qty: string;
        reduceOnly?: boolean;
    }): Promise<string> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ params, mode: 'MOCK' }, 'MOCK: Placing order on BloFin');
            return `mock_blofin_order_${Date.now()}`;
        }

        const instId = this.toInstId(params.symbol);
        if (!params.reduceOnly) {
            await this.ensureInstrumentConfig(instId);
        }

        const contractSize = await this.coinQtyToContracts(instId, params.qty);
        this.logger.info({ params, instId, contractSize }, 'Placing order on BloFin');

        const body: Record<string, string> = {
            instId,
            marginMode: 'cross',
            positionSide: 'net',
            side: params.side.toLowerCase(),
            orderType: 'market',
            size: contractSize,
        };

        if (params.reduceOnly) {
            body.reduceOnly = 'true';
        }

        const result = await this.post<{ orderId: string } | Array<{ orderId: string }>>(
            '/api/v1/trade/order',
            body
        );

        const orderId = Array.isArray(result) ? result[0]?.orderId : result?.orderId;
        this.logger.info({ orderId, instId, contractSize, ...params }, 'Order placed successfully on BloFin');
        return String(orderId ?? `blofin_${Date.now()}`);
    }

    async getPosition(symbol: string): Promise<{
        symbol: string;
        side: 'BUY' | 'SELL' | 'None';
        size: string;
        avgPrice: string;
        unrealisedPnl: string;
        stopLoss: string;
        markPrice: string;
        leverage: string;
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
                unrealisedPnl: '0.00',
                stopLoss: String(pos.slPrice ?? ''),
                markPrice: String(pos.entryPrice),
                leverage: String(env.LEVERAGE || 20),
            };
        }

        const instId = this.toInstId(symbol);
        const positions = await this.get<BloFinPosition[]>(
            `/api/v1/account/positions?instId=${encodeURIComponent(instId)}`
        );

        const pos = positions?.find((p) => p.instId === instId && Number(p.positions) !== 0);
        if (!pos) {
            return null;
        }

        const rawContracts = Number(pos.positions);
        const absCoinQty = await this.contractsToCoinQty(instId, Math.abs(rawContracts));

        let side: 'BUY' | 'SELL' = 'BUY';
        if (pos.positionSide === 'short') {
            side = 'SELL';
        } else if (pos.positionSide === 'long') {
            side = 'BUY';
        } else {
            side = rawContracts > 0 ? 'BUY' : 'SELL';
        }

        return {
            symbol,
            side,
            size: String(absCoinQty),
            avgPrice: pos.averagePrice,
            unrealisedPnl: pos.unrealizedPnl,
            stopLoss: '',
            markPrice: pos.markPrice,
            leverage: pos.leverage,
        };
    }

    async setTradingStop(params: {
        symbol: string;
        stopLoss: string;
        side: 'BUY' | 'SELL';
        qty: string;
    }): Promise<void> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ params, mode: 'MOCK' }, 'MOCK: Setting trading stop on BloFin');
            return;
        }

        const instId = this.toInstId(params.symbol);
        // If we are LONG ('BUY'), the SL order must SELL to close.
        // If we are SHORT ('SELL'), the SL order must BUY to close.
        const slSide = params.side === 'BUY' ? 'sell' : 'buy';

        this.logger.info({ params, instId, slSide }, 'Setting trading stop on BloFin');

        // Use size: "-1" so BloFin automatically protects 100% of the remaining open position
        const body = {
            instId,
            marginMode: 'cross',
            positionSide: 'net',
            side: slSide,
            slTriggerPrice: params.stopLoss,
            slOrderPrice: '-1', // Market execution when triggered
            slTriggerPriceType: 'mark',
            size: '-1',         // Entire remaining position
            reduceOnly: 'true',
        };

        await this.post('/api/v1/trade/order-tpsl', body);
        this.logger.info({ symbol: params.symbol, instId, stopLoss: params.stopLoss }, 'Trading stop set on BloFin');
    }

    async cancelAllOpenOrders(symbol: string): Promise<void> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ symbol, mode: 'MOCK' }, 'MOCK: Cancelling all open orders on BloFin');
            return;
        }

        const instId = this.toInstId(symbol);
        this.logger.info({ symbol, instId }, 'Cancelling all open orders on BloFin');

        // 1. Cancel pending TP/SL orders
        try {
            const pendingTpsl = await this.get<BloFinPendingTpsl[]>(
                `/api/v1/trade/orders-tpsl-pending?instId=${encodeURIComponent(instId)}`
            );

            if (Array.isArray(pendingTpsl) && pendingTpsl.length > 0) {
                const cancelPayload = pendingTpsl.map((item) => ({
                    instId,
                    tpslId: item.tpslId,
                }));
                await this.post('/api/v1/trade/cancel-tpsl', cancelPayload);
                this.logger.info({ instId, count: cancelPayload.length }, 'Cancelled open TP/SL orders on BloFin');
            }
        } catch (err) {
            this.logger.warn({ err, instId }, 'Failed to cancel pending TP/SL orders on BloFin');
        }

        // 2. Cancel pending standard limit/conditional orders
        try {
            const pendingOrders = await this.get<BloFinPendingOrder[]>(
                `/api/v1/trade/orders-pending?instId=${encodeURIComponent(instId)}`
            );

            if (Array.isArray(pendingOrders) && pendingOrders.length > 0) {
                const cancelPayload = pendingOrders.map((item) => ({
                    instId,
                    orderId: item.orderId,
                }));
                await this.post('/api/v1/trade/cancel-batch-orders', cancelPayload);
                this.logger.info({ instId, count: cancelPayload.length }, 'Cancelled open standard orders on BloFin');
            }
        } catch (err) {
            this.logger.warn({ err, instId }, 'Failed to cancel pending standard orders on BloFin');
        }
    }

    async getWalletBalance(): Promise<{ coin: string; equity: string; availableBalance: string }[]> {
        if (env.MOCK_EXCHANGE) {
            this.logger.info({ mode: 'MOCK' }, 'MOCK: Fetching wallet balance');
            return [{ coin: 'USDT', equity: '10000.00', availableBalance: '10000.00' }];
        }

        const balanceData = await this.get<BloFinBalanceData>('/api/v1/account/balance');
        const details = balanceData?.details ?? [];

        return details
            .filter((b) => Number(b.equity) > 0 || Number(b.available) > 0)
            .map((c) => ({
                coin: c.currency,
                equity: c.equity,
                availableBalance: c.available,
            }));
    }

    // ── Private HTTP & Auth Helpers ──────────────────────────────────────

    /**
     * BloFin v1 Signature:
     * prehash = `${requestPath}${method}${timestamp}${nonce}${bodyString}`
     * hex = HMAC_SHA256(secretKey, prehash).digest('hex')
     * sign = Base64(hex)
     */
    private buildHeaders(method: 'GET' | 'POST', requestPath: string, bodyString = ''): Record<string, string> {
        const timestamp = Date.now().toString();
        const nonce = timestamp;
        const prehash = `${requestPath}${method}${timestamp}${nonce}${bodyString}`;

        const hexSignature = crypto
            .createHmac('sha256', this.apiSecret)
            .update(prehash)
            .digest('hex');

        const accessSign = Buffer.from(hexSignature, 'utf-8').toString('base64');

        const headers: Record<string, string> = {
            'ACCESS-KEY': this.apiKey,
            'ACCESS-SIGN': accessSign,
            'ACCESS-TIMESTAMP': timestamp,
            'ACCESS-NONCE': nonce,
            'ACCESS-PASSPHRASE': this.passphrase,
        };

        if (method === 'POST') {
            headers['Content-Type'] = 'application/json';
        }

        return headers;
    }

    private async post<T>(path: string, bodyObj: unknown, attempt = 1): Promise<T> {
        const bodyString = JSON.stringify(bodyObj);
        const headers = this.buildHeaders('POST', path, bodyString);
        const url = `${this.baseUrl}${path}`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: bodyString,
            });

            const json = (await response.json()) as BloFinResponse<T>;
            if (!response.ok) {
                this.logger.error({ status: response.status, json, path }, 'BloFin API HTTP Error');
                throw new Error(`BloFin HTTP ${response.status}: ${JSON.stringify(json)}`);
            }
            this.assertSuccess(json, path);
            return json.data;
        } catch (err) {
            if (this.shouldRetry(err, attempt)) {
                this.logger.warn({ err, attempt, path }, 'BloFin API error, retrying...');
                await this.delay(500 * attempt);
                return this.post<T>(path, bodyObj, attempt + 1);
            }
            throw err;
        }
    }

    private async get<T>(pathWithQs: string, attempt = 1): Promise<T> {
        const headers = this.buildHeaders('GET', pathWithQs, '');
        const url = `${this.baseUrl}${pathWithQs}`;

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers,
            });

            const json = (await response.json()) as BloFinResponse<T>;
            if (!response.ok) {
                this.logger.error({ status: response.status, json, pathWithQs }, 'BloFin API HTTP Error');
                throw new Error(`BloFin HTTP ${response.status}: ${JSON.stringify(json)}`);
            }
            this.assertSuccess(json, pathWithQs);
            return json.data;
        } catch (err) {
            if (this.shouldRetry(err, attempt)) {
                this.logger.warn({ err, attempt, pathWithQs }, 'BloFin API error, retrying...');
                await this.delay(500 * attempt);
                return this.get<T>(pathWithQs, attempt + 1);
            }
            throw err;
        }
    }

    private assertSuccess<T>(json: BloFinResponse<T>, path: string): void {
        if (json.code !== undefined && String(json.code) !== '0') {
            throw new Error(
                `BloFin API error on ${path}: [${json.code}] ${json.msg} | data=${JSON.stringify(json.data)}`
            );
        }
    }

    private shouldRetry(err: unknown, attempt: number): boolean {
        const maxRetries = 3;
        if (attempt >= maxRetries) return false;

        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('fetch') || msg.includes('network') || msg.includes('ECONNRESET')) return true;
        if (msg.includes('502') || msg.includes('504') || msg.includes('429')) return true;

        return false;
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
