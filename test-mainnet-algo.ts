import pino from "pino";
import dotenv from "dotenv";

dotenv.config();

async function run() {
    try {
        console.log("Checking algo type on MAINNET...");
        const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const data = await res.json();
        const symbol = data.symbols.find((s: any) => s.symbol === 'ETHUSDT');
        console.log("Order Types:", symbol.orderTypes);
    } catch (e: any) {
        console.error("Error:", e.message);
    }
}

run();
