import pino from "pino";
import dotenv from "dotenv";

dotenv.config();

async function run() {
    try {
        const res = await fetch(process.env.BINANCE_BASE_URL + '/fapi/v1/exchangeInfo');
        const data = await res.json();
        const symbol = data.symbols.find((s: any) => s.symbol === 'ETHUSDT');
        console.log("Order Types:", symbol.orderTypes);
    } catch (e: any) {
        console.error("Error:", e.message);
    }
}

run();
