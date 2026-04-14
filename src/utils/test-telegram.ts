/* eslint-disable no-console */
import { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { TelegramNotifier } from '../infra/telegram-notifier.js';
import { env } from '../config/env.js';

async function main() {
    console.log('--- Testing Telegram Notifications ---');
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        console.error('❌ Error: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID are empty in .env.');
        console.log('\nPlease follow these steps to set it up:');
        console.log('1. Open Telegram and search for @BotFather.');
        console.log('2. Send /newbot, choose a name and username.');
        console.log('3. Copy the HTTP API Token to TELEGRAM_BOT_TOKEN in .env.');
        console.log('4. Search for @userinfobot (or similar) in Telegram to get your Chat ID.');
        console.log('5. Copy the ID to TELEGRAM_CHAT_ID in .env.');
        console.log('6. Send a message like "Hello" to your new bot in Telegram (this is mandatory to allow it to message you).');
        console.log('7. Run this script again.');
        process.exit(1);
    }

    const logger = pino() as FastifyBaseLogger;
    const notifier = new TelegramNotifier(logger);

    console.log('Sending test notification...');
    await notifier.send('🤖 *Bot Trader* test notification.\nIf you see this, notifications are working properly ✅');
    
    console.log('Successfully requested Telegram to send the message!');
    process.exit(0);
}

main().catch(console.error);
