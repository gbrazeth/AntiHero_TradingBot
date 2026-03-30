-- CreateTable
CREATE TABLE "signals" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "strategy_id" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "signal_timestamp" TEXT NOT NULL,
    "bar_close" BOOLEAN NOT NULL,
    "event" TEXT NOT NULL,
    "idempotency_hash" TEXT NOT NULL,
    "processed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "orders" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "signal_id" INTEGER NOT NULL,
    "side" TEXT NOT NULL,
    "qty" REAL NOT NULL,
    "price" REAL NOT NULL,
    "order_type" TEXT NOT NULL DEFAULT 'Market',
    "bybit_order_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "orders_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "positions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entry_price" REAL NOT NULL,
    "qty" REAL NOT NULL,
    "current_qty" REAL NOT NULL,
    "sl_price" REAL,
    "be_applied" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "daily_pnl" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "date" TEXT NOT NULL,
    "realized_pnl" REAL NOT NULL DEFAULT 0,
    "unrealized_pnl" REAL NOT NULL DEFAULT 0,
    "is_kill_switch_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "signals_idempotency_hash_key" ON "signals"("idempotency_hash");

-- CreateIndex
CREATE UNIQUE INDEX "daily_pnl_date_key" ON "daily_pnl"("date");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");
