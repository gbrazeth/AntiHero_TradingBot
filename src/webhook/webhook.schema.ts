import { z } from 'zod';

/**
 * Valid webhook events as defined in spec section 3.
 */
export const VALID_EVENTS = [
    'MACD_ENTRY_LONG',
    'MACD_ENTRY_SHORT',
    'RSI_ENTRY_LONG',
    'RSI_ENTRY_SHORT',
    'TREND_ENTRY_LONG',
    'TREND_ENTRY_SHORT',
    'MACD_PARTIAL_LONG',
    'MACD_PARTIAL_SHORT',
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

    exchange: z.string().min(1, 'exchange is required'),

    symbol: z.string().min(1, 'symbol is required'),

    timeframe: z.string().min(1, 'timeframe is required'),

    price: z.number().positive('price must be positive'),

    timestamp: z.string().min(1, 'timestamp is required'),

    bar_close: z.boolean({
        message: 'bar_close must be a boolean',
    }).optional(),

    event: z.enum(VALID_EVENTS, {
        message: `event must be one of: ${VALID_EVENTS.join(', ')}`,
    }),

    trend_1d: z.enum(['UP', 'DOWN', 'NONE']).optional(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
