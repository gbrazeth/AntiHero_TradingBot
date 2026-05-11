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
    
    try {
        const slPrice = '2000.00';
        
        const qsParams = new URLSearchParams({
            symbol: 'ETHUSDT',
            side: 'SELL',
            algoType: 'STOP',
            type: 'STOP_MARKET',
            triggerPrice: slPrice,
            closePosition: 'true',
            workingType: 'MARK_PRICE'
        });
        
        const timestamp = Date.now().toString();
        const qsWithRecv = `${qsParams.toString()}&recvWindow=10000&timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', process.env.BINANCE_API_SECRET!).update(qsWithRecv).digest('hex');
        
        const url = `https://testnet.binancefuture.com/sapi/v1/algo/futures/newOrderAlgo?${qsWithRecv}&signature=${signature}`;
        console.log("POST", url);
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY! }
        });
        
        console.log(await response.json());
        
    } catch (err) {
        console.error('Test Failed:', err);
    }
}

test();
