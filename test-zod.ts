import { webhookPayloadSchema } from './src/webhook/webhook.schema.js';

const payloadStr = '{"strategy_id": "ANTIHERO_PHASE_3","exchange":"BINANCE_TESTNET","symbol":"ETHUSDT","timeframe":"60","price":2121.11,"timestamp":"2026-05-19T17:00:00.000+0000","bar_close":false,"event":"VMC_PARTIAL_25_SHORT"}';

try {
    const payload = JSON.parse(payloadStr);
    const parsed = webhookPayloadSchema.safeParse(payload);
    
    if (!parsed.success) {
        console.error('Validation Failed:');
        console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
    } else {
        console.log('Validation Success:', parsed.data);
    }
} catch (err) {
    console.error('Failed to parse JSON string:', err);
}
