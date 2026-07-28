import { BinanceAdapter } from './src/infra/binance-adapter.js';
import { env } from './src/config/env.js';
import pino from 'pino';

async function main() {
    const logger = pino({ level: 'silent' });
    const adapter = new BinanceAdapter(logger as any);
    const balances = await adapter['get']('/fapi/v2/balance');
    console.log(JSON.stringify(balances.filter((b: any) => Number(b.balance) > 0 || Number(b.availableBalance) > 0), null, 2));
}
main().catch(console.error);
