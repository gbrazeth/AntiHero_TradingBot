import { BinanceAdapter } from './src/infra/binance-adapter.js';
import pino from 'pino';

const logger = pino() as any;
const adapter = new BinanceAdapter(logger);

async function run() {
    try {
        console.log("Placing small test order...");
        await adapter.placeOrder({ symbol: "ETHUSDT", side: "BUY", qty: "0.01" });
        console.log("Setting STOP_MARKET via setTradingStop...");
        await adapter.setTradingStop({
            symbol: "ETHUSDT",
            side: "BUY",
            qty: "0.01",
            stopLoss: "2000"
        });
        console.log("Done.");
    } catch (err) {
        console.error(err);
    }
}
run();
