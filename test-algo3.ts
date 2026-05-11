import { FastifyBaseLogger } from 'fastify';
import crypto from 'node:crypto';

async function test() {
    try {
        const slPrice = '2000.00';
        
        const qsParams = new URLSearchParams({
            symbol: 'ETHUSDT',
            side: 'SELL',
            algoType: 'CONDITIONAL',
            type: 'STOP_MARKET',
            triggerPrice: slPrice,
            closePosition: 'true',
            workingType: 'MARK_PRICE'
        });
        
        const timestamp = Date.now().toString();
        const qsWithRecv = `${qsParams.toString()}&recvWindow=10000&timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', process.env.BINANCE_API_SECRET!).update(qsWithRecv).digest('hex');
        
        const url = `https://testnet.binancefuture.com/fapi/v1/algoOrder?${qsWithRecv}&signature=${signature}`;
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
