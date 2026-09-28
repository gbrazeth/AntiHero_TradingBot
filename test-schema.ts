import { webhookPayloadSchema } from './src/webhook/webhook.schema.js';

const payload = {"strategy_id":"PEDRO_MVP_V1","exchange":"BINANCE_TESTNET","symbol":"ETHUSDT","timeframe":"60","price":2480,"timestamp":"2026-09-15T07:12:46Z","bar_close":false,"event":"SMA_ENTRY_SHORT","wma_250":2501.31};

const parsed = webhookPayloadSchema.safeParse(payload);
if (!parsed.success) {
    console.log("FAIL:", parsed.error.flatten().fieldErrors);
} else {
    console.log("SUCCESS");
}
