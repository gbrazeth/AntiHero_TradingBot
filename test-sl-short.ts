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
        console.log("Testing SL for SHORT ENTRY (SL side = BUY)...");
        const qsParams = new URLSearchParams({
            symbol: "ETHUSDT",
            side: "BUY", // To close a short, we BUY
            type: "STOP_MARKET",
            triggerPrice: "1909.1", 
            reduceOnly: "true",
            quantity: "1.058",
            workingType: "MARK_PRICE",
            algoType: "CONDITIONAL"
        });
        const res = await (adapter as any).post('/fapi/v1/algoOrder', qsParams.toString());
        console.log("Success!", res);
    } catch (e: any) {
        console.error("Error:", e.response?.data || e.message);
    }
}

run();
