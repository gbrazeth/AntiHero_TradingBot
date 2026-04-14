import { BinanceAdapter } from './src/infra/binance-adapter.js';

const logger = {
    info: console.log,
    error: console.error,
    warn: console.warn,
} as any;

const adapter = new BinanceAdapter(logger);

async function run() {
    try {
        console.log('Fetching wallet balance...');
        const balance = await adapter.getWalletBalance();
        console.log('Balance:', balance);
    } catch (err) {
        console.error('Error:', err);
    }
}

run();
