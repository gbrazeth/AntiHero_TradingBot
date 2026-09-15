import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
dotenv.config();

const prisma = new PrismaClient();

async function run() {
    try {
        console.log("=== OPERATION JULY 30th ===");
        const targetDate = new Date("2026-07-30T00:00:00.000Z");
        const nextDate = new Date("2026-07-31T00:00:00.000Z");
        
        const pos30th = await prisma.position.findMany({
            where: {
                createdAt: {
                    gte: targetDate,
                    lt: nextDate
                }
            },
            include: {
                logs: {
                    orderBy: { createdAt: 'asc' }
                }
            }
        });
        console.log(JSON.stringify(pos30th, null, 2));

        console.log("\n=== RECENT OPERATIONS (Last 10) ===");
        const recentPos = await prisma.position.findMany({
            orderBy: { createdAt: 'desc' },
            take: 10,
            include: {
                logs: {
                    orderBy: { createdAt: 'asc' }
                }
            }
        });
        
        console.log(JSON.stringify(recentPos, null, 2));

    } catch(err) {
        console.error(err);
    } finally {
        await prisma.$disconnect();
    }
}
run();
