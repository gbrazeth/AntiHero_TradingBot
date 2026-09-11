import { z } from 'zod';

/**
 * Valid webhook events - Setup Pedro (Clean)
 */
export const VALID_EVENTS = [
    'SMA_ENTRY_LONG',
    'SMA_ENTRY_SHORT',
] as const;

export type WebhookEvent = (typeof VALID_EVENTS)[number];

/**
 * Zod schema for TradingView webhook payload.
 */
export const webhookPayloadSchema = z.object({
    strategy_id: z.string().min(1, 'strategy_id is required'),
    exchange: z.string().min(1, 'exchange is required'),
    symbol: z.string().min(1, 'symbol is required'),
    timeframe: z.string().min(1, 'timeframe is required'),
    price: z.number().positive('price must be positive'),
    timestamp: z.string().min(1, 'timestamp is required'),
    bar_close: z.boolean().optional(),
    event: z.enum(VALID_EVENTS, {
        message: `event must be one of: ${VALID_EVENTS.join(', ')}`,
    }),
    wma_250: z.number().optional(),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
