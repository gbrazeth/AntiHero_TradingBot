import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';

/**
 * TelegramNotifier — Infrastructure layer.
 *
 * Sends formatted notifications via Telegram Bot API.
 * Gracefully silences errors when token/chatId are not configured.
 */
export class TelegramNotifier {
    private readonly token: string;
    private readonly chatIds: string[];
    private readonly configured: boolean;

    constructor(private readonly logger: FastifyBaseLogger) {
        this.token = env.TELEGRAM_BOT_TOKEN;
        
        // Collect all available chat IDs
        this.chatIds = [env.TELEGRAM_CHAT_ID, env.TELEGRAM_CHAT_ID_2]
            .filter((id) => id !== '');

        this.configured = Boolean(this.token && this.chatIds.length > 0);

        if (!this.configured) {
            this.logger.warn('TelegramNotifier: token/chatIds not set — notifications disabled');
        }
    }

    /** Send a message to all configured chat IDs. */
    async send(message: string): Promise<void> {
        if (!this.configured) return;

        // Use Promise.all to send to all IDs in parallel
        await Promise.all(
            this.chatIds.map(async (chatId) => {
                try {
                    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
                    const body = {
                        chat_id: chatId,
                        text: message,
                        parse_mode: 'Markdown',
                    };

                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });

                    if (!res.ok) {
                        const err = await res.text();
                        this.logger.error({ err, chatId }, 'Telegram API error');
                    }
                } catch (err) {
                    this.logger.error({ err, chatId }, 'Failed to send Telegram notification');
                }
            }),
        );
    }

    // ── Convenience helpers ──────────────────────────────────────────────

    async notifyEntry(params: {
        side: 'LONG' | 'SHORT';
        symbol: string;
        price: number;
        qty: number;
        slPrice: number;
        event: string;
    }): Promise<void> {
        const emoji = params.side === 'LONG' ? '🟢' : '🔴';
        const baseAsset = params.symbol.replace('USDT', '');
        await this.send(
            `${emoji} *${params.side} ENTRY*\n` +
            `📊 Symbol: \`${params.symbol}\`\n` +
            `💰 Price: \`${params.price}\`\n` +
            `📦 Qty: \`${params.qty} ${baseAsset}\`\n` +
            `🛡 SL: \`${params.slPrice}\`\n` +
            `📡 Signal: \`${params.event}\``,
        );
    }

    async notifyPartialExit(params: {
        symbol: string;
        pct: number;
        price: number;
        closedQty: string;
        event: string;
    }): Promise<void> {
        await this.send(
            `🔶 *PARTIAL EXIT ${params.pct}%*\n` +
            `📊 Symbol: \`${params.symbol}\`\n` +
            `💰 Price: \`${params.price}\`\n` +
            `📦 Closed: \`${params.closedQty}\`\n` +
            `📡 Signal: \`${params.event}\``,
        );
    }

    async notifyBreakEven(params: {
        symbol: string;
        newSl: number;
    }): Promise<void> {
        await this.send(
            `⚡ *BREAK-EVEN APPLIED*\n` +
            `📊 Symbol: \`${params.symbol}\`\n` +
            `🛡 New SL: \`${params.newSl}\``,
        );
    }

    async notifyKillSwitch(dailyLoss: number): Promise<void> {
        await this.send(
            `🚨 *KILL SWITCH ACTIVATED*\n` +
            `Daily loss limit reached: \`${(dailyLoss * 100).toFixed(2)}%\`\n` +
            `No more trades will be executed today.`,
        );
    }

    async notifyError(context: string, err: unknown): Promise<void> {
        const msg = err instanceof Error ? err.message : String(err);
        await this.send(`❌ *ERROR* [${context}]\n\`${msg}\``);
    }
}
