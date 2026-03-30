import crypto from 'node:crypto';

/**
 * Creates an idempotency hash from symbol + event + timestamp.
 * Used to prevent duplicate signal processing.
 */
export function createIdempotencyHash(
    symbol: string,
    event: string,
    timestamp: string,
): string {
    const payload = `${symbol}|${event}|${timestamp}`;
    return crypto.createHash('sha256').update(payload).digest('hex');
}
