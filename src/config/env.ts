import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
    // Server
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // Auth
    WEBHOOK_TOKEN: z.string().min(1, 'WEBHOOK_TOKEN is required'),

    // Database
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // Binance
    BINANCE_API_KEY: z.string().default(''),
    BINANCE_API_SECRET: z.string().default(''),
    BINANCE_BASE_URL: z.string().url().default('https://testnet.binancefuture.com'),
    MOCK_EXCHANGE: z
        .string()
        .default('false')
        .transform((val) => val === 'true' || val === '1'),

    // Telegram
    TELEGRAM_BOT_TOKEN: z.string().default(''),
    TELEGRAM_CHAT_ID: z.string().default(''),

    // Trading Parameters
    SL_PCT: z.coerce.number().default(0.01),
    BE_BUFFER: z.coerce.number().default(0.0005),
    TP1_PCT: z.coerce.number().default(0.015),
    TP2_PCT: z.coerce.number().default(0.03),
    DAILY_DD_LIMIT: z.coerce.number().default(0.04),
    CAP_EXPOSURE_PCT: z.coerce.number().default(0.10),
    QTY_MODE: z.enum(['fixed_usdt']).default('fixed_usdt'),
    QTY_VALUE_USDT: z.coerce.number().default(50),
    MIN_REMAINING_POSITION_PCT: z.coerce.number().default(0.10),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
    const parsed = envSchema.safeParse(process.env);

    if (!parsed.success) {
        const errors = parsed.error.flatten().fieldErrors;
        const message = Object.entries(errors)
            .map(([key, msgs]) => `  ${key}: ${(msgs ?? []).join(', ')}`)
            .join('\n');

        throw new Error(`❌ Invalid environment variables:\n${message}`);
    }

    return parsed.data;
}

export const env = loadEnv();
