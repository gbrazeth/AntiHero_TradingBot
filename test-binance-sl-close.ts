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
        console.log("Trying to place a STOP_MARKET order with closePosition=true...");
        const qsParams = new URLSearchParams({
            symbol: "ETHUSDT",
            side: "SELL",
            type: "STOP_MARKET",
            stopPrice: "1890.9",
            closePosition: "true"
        });
        await (adapter as any).post('/fapi/v1/order', qsParams.toString());
        console.log("Success!");
    } catch (e: any) {
        console.error("Error:", e.response?.data || e.message);
    }
}

run();
