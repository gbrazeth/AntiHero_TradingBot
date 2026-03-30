# BOT Trader MVP V1

> Bot automatizado que recebe sinais do TradingView via webhook e executa operações em **Bybit Futures Testnet** para **ETHUSDT**.

## Requisitos

- Node.js 20+
- npm

## Setup Local

### 1. Instalar dependências

```bash
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
# Edite .env com seus valores (WEBHOOK_TOKEN obrigatório)
```

### 3. Criar o banco de dados (SQLite)

```bash
npx prisma migrate dev --name init
```

### 4. Rodar em desenvolvimento

```bash
npm run dev
```

O servidor iniciará em `http://localhost:3000`.

## Setup com Docker

```bash
# Edite .env primeiro
docker compose up --build -d
```

## Endpoints

### `GET /health`

Health check.

```bash
curl http://localhost:3000/health
```

### `POST /webhook/tradingview`

Recebe sinais do TradingView.

**Headers:**
- `Content-Type: application/json`
- `X-WEBHOOK-TOKEN: <seu-token>`

**Payload:**
```json
{
  "strategy_id": "PEDRO_MVP_V1",
  "exchange": "BYBIT_TESTNET",
  "symbol": "ETHUSDT",
  "timeframe": "60",
  "price": 2845.5,
  "timestamp": "2026-02-25T12:00:00Z",
  "bar_close": true,
  "event": "MACD_ENTRY_LONG"
}
```

**Exemplo:**
```bash
curl -X POST http://localhost:3000/webhook/tradingview \
  -H "Content-Type: application/json" \
  -H "X-WEBHOOK-TOKEN: dev-token-change-me" \
  -d '{
    "strategy_id": "PEDRO_MVP_V1",
    "exchange": "BYBIT_TESTNET",
    "symbol": "ETHUSDT",
    "timeframe": "60",
    "price": 2845.5,
    "timestamp": "2026-02-25T12:00:00Z",
    "bar_close": true,
    "event": "MACD_ENTRY_LONG"
  }'
```

## Eventos Válidos

| Evento | Descrição |
|--------|-----------|
| `MACD_ENTRY_LONG` | Entrada comprada |
| `MACD_ENTRY_SHORT` | Entrada vendida |
| `VMC_PARTIAL_25_LONG` | Parcial 25% da posição long |
| `VMC_PARTIAL_50_LONG` | Parcial 50% da posição long |
| `VMC_PARTIAL_25_SHORT` | Parcial 25% da posição short |
| `VMC_PARTIAL_50_SHORT` | Parcial 50% da posição short |

## Scripts

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | Inicia em modo desenvolvimento (hot reload) |
| `npm run build` | Compila TypeScript para JavaScript |
| `npm start` | Roda a versão compilada |
| `npm run lint` | Roda ESLint |
| `npm run prisma:migrate` | Cria/aplica migrações |
| `npm run prisma:studio` | Abre o Prisma Studio (UI do banco) |

## Estrutura do Projeto

```
src/
├── index.ts                    # Bootstrap Fastify
├── config/
│   └── env.ts                  # Validação de env com Zod
├── domain/
│   ├── strategy-engine.ts      # Máquina de estados (placeholder)
│   └── risk-manager.ts         # Controle de risco (placeholder)
├── infra/
│   ├── bybit-adapter.ts        # Integração Bybit (placeholder)
│   ├── telegram-notifier.ts    # Notificações Telegram (placeholder)
│   └── prisma.ts               # PrismaClient singleton
├── webhook/
│   ├── webhook.controller.ts   # Rota + auth + idempotência
│   ├── webhook.schema.ts       # Schemas Zod
│   └── webhook.service.ts      # Processamento de sinais
└── utils/
    └── hash.ts                 # Hash de idempotência
```

## Spec Completo

Consulte [`docs/spec.md`](docs/spec.md) para a especificação completa do projeto.
