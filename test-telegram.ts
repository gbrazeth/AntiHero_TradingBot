import { TelegramNotifier } from './src/infra/telegram-notifier.js';
import pino from 'pino';

const logger = pino() as any;
const notifier = new TelegramNotifier(logger);

async function run() {
    console.log('Sending test message...');
    await notifier.send('🧪 *Test Message* from local bot');
    console.log('Done');
}
run().catch(console.error);
