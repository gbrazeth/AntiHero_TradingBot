/* eslint-disable no-console */
import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const adapter = new PrismaBetterSqlite3({ url: 'file:./dev.db' });
const prisma = new PrismaClient({ adapter });

async function resetAll() {
  const delPos = await prisma.position.deleteMany({});
  const delOrd = await prisma.order.deleteMany({});
  const delSig = await prisma.signal.deleteMany({});
  const delPnl = await prisma.dailyPnl.deleteMany({});
  
  console.log(`✅ Cleaned: ${delPos.count} positions, ${delOrd.count} orders, ${delSig.count} signals, ${delPnl.count} dailyPnl`);
  console.log('Database is now clean for real trading.');
  await prisma.$disconnect();
}

resetAll();
