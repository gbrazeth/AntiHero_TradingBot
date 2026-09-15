import { BinanceAdapter } from "./src/infra/binance-adapter.js";
import pino from "pino";
import dotenv from "dotenv";

dotenv.config();

const logger = pino();
const adapter = new BinanceAdapter(
    logger,
    process.env.BINANCE_API_KEY!,
    process.env.BINANCE_API_SECRET!,
    process.env.BINANCE_BASE_URL!
);

async function run() {
    try {
        console.log("Trying to place a STOP_MARKET order...");
        await adapter.setTradingStop({
            symbol: "ETHUSDT",
            stopLoss: "1890.9",
            side: "BUY", // Long position, so SL will be SELL
            qty: "1.047"
        });
        console.log("Success!");
    } catch (e: any) {
        console.error("Error:", e.response?.data || e.message);
    }
}

run();
