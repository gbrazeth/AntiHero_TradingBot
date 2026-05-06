import { z } from 'zod';

/**
 * Valid webhook events as defined in spec section 3.
 */
export const VALID_EVENTS = [
    'MACD_ENTRY_LONG',
    'MACD_ENTRY_SHORT',
    'VMC_PARTIAL_25_LONG',
    'VMC_PARTIAL_50_LONG',
    'VMC_PARTIAL_25_SHORT',
    'VMC_PARTIAL_50_SHORT',
    'TARGET_PRICE_LONG',
    'TARGET_PRICE_SHORT',
] as const;

export type WebhookEvent = (typeof VALID_EVENTS)[number];

/**
 * Zod schema for TradingView webhook payload.
 * Validates all fields per spec section 4.
 */
export const webhookPayloadSchema = z.object({
    strategy_id: z.string().min(1, 'strategy_id is required'),

    exchange: z.literal('BINANCE_TESTNET', {
        message: 'exchange must be BINANCE_TESTNET',
    }),

    symbol: z.literal('ETHUSDT', {
        message: 'symbol must be ETHUSDT',
    }),

    timeframe: z.string().min(1, 'timeframe is required'),

    price: z.number().positive('price must be positive'),

    timestamp: z.string().datetime({ message: 'timestamp must be a valid ISO 8601 datetime' }),

    bar_close: z.literal(true, {
        message: 'bar_close must be true',
    }),

    event: z.enum(VALID_EVENTS, {
        message: `event must be one of: ${VALID_EVENTS.join(', ')}`,
    }),

    trend_1d: z.enum(['UP', 'DOWN', 'NONE']).optional(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
