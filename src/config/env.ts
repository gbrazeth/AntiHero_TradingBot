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
    BINANCE_BASE_URL: z.string().url('BINANCE_BASE_URL must be a valid URL'),
    MOCK_EXCHANGE: z
        .string()
        .default('false')
        .transform((val) => val === 'true' || val === '1'),

    // Telegram
    TELEGRAM_BOT_TOKEN: z.string().default(''),
    TELEGRAM_CHAT_ID: z.string().default(''),
    TELEGRAM_CHAT_ID_2: z.string().default(''),

    // Trading Parameters
    SL_PCT: z.coerce.number().default(0.01),
    WMA_FILTER_PCT: z.coerce.number().default(0.02),  // 2% distance filter
    DAILY_DD_LIMIT: z.coerce.number().default(0.04),
    CAP_EXPOSURE_PCT: z.coerce.number().default(0.10),
    QTY_MODE: z.enum(['fixed_usdt']).default('fixed_usdt'),
    QTY_VALUE_USDT: z.coerce.number().default(50),
    LEVERAGE: z.coerce.number().default(20),

    // Take Profit Levels (ROI fractions)
    TP1_ROI: z.coerce.number().default(0.10),   // 10% ROI
    TP2_ROI: z.coerce.number().default(0.25),   // 25% ROI
    TP3_ROI: z.coerce.number().default(0.50),   // 50% ROI
    TP4_ROI: z.coerce.number().default(1.00),   // 100% ROI
    TP5_ROI: z.coerce.number().default(2.00),   // 200% ROI

    // Take Profit Slice Percentages (of original position)
    TP1_SLICE: z.coerce.number().default(0.10),  // 10%
    TP2_SLICE: z.coerce.number().default(0.15),  // 15%
    TP3_SLICE: z.coerce.number().default(0.15),  // 15%
    TP4_SLICE: z.coerce.number().default(0.25),  // 25%
    TP5_SLICE: z.coerce.number().default(0.15),  // 15%

    // Trailing Stop (ROI distance)
    TRAILING_STOP_ROI: z.coerce.number().default(0.25),  // 25% ROI distance
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
