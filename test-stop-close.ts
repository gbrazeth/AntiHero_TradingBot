import { FastifyBaseLogger } from 'fastify';
import { BinanceAdapter } from './src/infra/binance-adapter.js';
import crypto from 'node:crypto';

const logger = {
    info: console.log,
    warn: console.log,
    error: console.error,
} as unknown as FastifyBaseLogger;

async function test() {
    const exchange = new BinanceAdapter(logger);
    
    // Test current price
    const tickerRes = await fetch('https://testnet.binancefuture.com/fapi/v1/ticker/price?symbol=ETHUSDT');
    const ticker = await tickerRes.json();
    const currentPrice = parseFloat(ticker.price);
    
    try {
        await exchange.placeOrder({
            symbol: 'ETHUSDT',
            side: 'BUY',
            qty: '0.02'
        });
        
        await new Promise(r => setTimeout(r, 2000));
        
        const slPrice = (currentPrice * 0.95).toFixed(2);
        console.log(`Placing STOP_MARKET SELL order at ${slPrice}...`);
        
        const qsParams = new URLSearchParams({
            symbol: 'ETHUSDT',
            side: 'SELL',
            type: 'STOP_MARKET',
            stopPrice: slPrice,
            closePosition: 'true',
            workingType: 'MARK_PRICE'
        });
        
        const timestamp = Date.now().toString();
        const qsWithRecv = `${qsParams.toString()}&recvWindow=10000&timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', process.env.BINANCE_API_SECRET!).update(qsWithRecv).digest('hex');
        
        const url = `https://testnet.binancefuture.com/fapi/v1/order?${qsWithRecv}&signature=${signature}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY! }
        });
        
        console.log(await response.json());
        
        // Clean up
        const delSig = crypto.createHmac('sha256', process.env.BINANCE_API_SECRET!).update(`symbol=ETHUSDT&recvWindow=10000&timestamp=${Date.now()}`).digest('hex');
        await fetch(`https://testnet.binancefuture.com/fapi/v1/allOpenOrders?symbol=ETHUSDT&recvWindow=10000&timestamp=${Date.now()}&signature=${delSig}`, { method: 'DELETE', headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY! } });
        
        await exchange.placeOrder({
            symbol: 'ETHUSDT',
            side: 'SELL',
            qty: '0.02',
            reduceOnly: true
        });
    } catch (err) {
        console.error('Test Failed:', err);
    }
}

test();
