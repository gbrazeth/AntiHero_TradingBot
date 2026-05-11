import { FastifyBaseLogger } from 'fastify';
import crypto from 'node:crypto';

async function test() {
    const slPrice = '2000.00';
    
    // Let's try /fapi/v1/algoOrder with triggerPrice! Wait, earlier it said triggerPrice missing? No, I passed stopPrice.
    // wait, I ran `https://testnet.binancefuture.com/fapi/v1/algoOrder` and it said "triggerprice was not sent"!
    // Which means `/fapi/v1/algoOrder` EXISTS and is the correct endpoint!
    // But Binance expects triggerPrice, not stopPrice!
    const qsParams = new URLSearchParams({
        symbol: 'ETHUSDT',
        side: 'SELL',
        type: 'STOP_MARKET',
        stopPrice: slPrice, // WAIT, if the endpoint is algoOrder, what are the params? Let's just pass stopPrice and triggerPrice!
        triggerPrice: slPrice,
        closePosition: 'true',
        workingType: 'MARK_PRICE'
    });
    
    const timestamp = Date.now().toString();
    const qsWithRecv = `${qsParams.toString()}&recvWindow=10000&timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', process.env.BINANCE_API_SECRET!).update(qsWithRecv).digest('hex');
    
    const url = `https://testnet.binancefuture.com/fapi/v1/order?${qsWithRecv}&signature=${signature}`; // wait, let's try /order again
    console.log("POST /order");
    const response1 = await fetch(url, { method: 'POST', headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY! }});
    console.log(await response1.text());
    
}

test();
