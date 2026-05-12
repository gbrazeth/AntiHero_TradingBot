import { FastifyBaseLogger } from 'fastify';
import { BinanceAdapter } from './src/infra/binance-adapter.js';

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
    console.log(`Current ETH Price: ${currentPrice}`);
    
    // Try to place a LONG entry order (small size to test)
    try {
        console.log('Placing entry order...');
        const orderId = await exchange.placeOrder({
            symbol: 'ETHUSDT',
            side: 'BUY',
            qty: '0.02'
        });
        console.log(`Entry Order placed: ${orderId}`);
        
        // Try to place a Take Profit Market order above current price
        const tpPrice = (currentPrice * 1.05).toFixed(2);
        console.log(`Placing TAKE_PROFIT_MARKET at ${tpPrice}...`);
        await exchange.setTakeProfit({
            symbol: 'ETHUSDT',
            side: 'BUY', // the entry side was BUY
            tpPrice: tpPrice,
            qty: '0.02'
        });
        console.log('Take profit set successfully.');
        
        // Try to close position
        await exchange.placeOrder({
            symbol: 'ETHUSDT',
            side: 'SELL',
            qty: '0.02',
            reduceOnly: true
        });
        console.log('Position closed.');
    } catch (err) {
        console.error('Test Failed:', err);
    }
}

test();
