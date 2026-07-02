import { PrismaClient } from '@prisma/client';

process.env.DATABASE_URL = "postgresql://antihero_db_user:3rVf6bRagKCoZg4rcwORYId58ja1Q7iW@dpg-d7knc7mgvqtc7382oid0-a.oregon-postgres.render.com/antihero_db";

const prisma = new PrismaClient();

async function main() {
    console.log("Connecting to production database...");
    
    // Wipe tables in correct order to avoid foreign key constraints
    console.log("Deleting TradeLogs...");
    await prisma.tradeLog.deleteMany({});
    
    console.log("Deleting Orders...");
    await prisma.order.deleteMany({});
    
    console.log("Deleting Positions...");
    await prisma.position.deleteMany({});
    
    console.log("✅ All testnet data wiped successfully!");
}

main()
    .catch(e => {
        console.error("Connection failed. The hostname might be wrong:", e.message);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
