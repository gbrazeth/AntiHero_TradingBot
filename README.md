# BOT Trader MVP V1

> Bot automatizado que recebe sinais do TradingView via webhook e executa operações robustas em **Binance Futures Testnet / Demo** para **ETHUSDT** e altcoins. Inclui sistema de Dashboard Full-Stack e suporte para Auto-Reversão, e Take Profits Múltiplos (TP1/TP2).

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
# Edite .env com seus valores (WEBHOOK_TOKEN e chaves da Binance são obrigatórios)
```

### 3. Criar o banco de dados (SQLite)

```bash
npx prisma db push && npx prisma generate
```

### 4. Rodar o Backend (API)

```bash
npm run dev
# O servidor iniciará em http://localhost:3333.
```

### 5. Rodar o Frontend (Painel Dashboard)

```bash
cd frontend
npm install
npm run dev
# O Painel Dashboard iniciará de forma independente em http://localhost:3002.
```

## Setup com Docker

```bash
# Edite .env primeiro
docker compose up --build -d
```

## Endpoints da API

### `GET /health`

Verificador de pulso e saúde da aplicação.

```bash
curl http://localhost:3333/health
```

### `POST /webhook/tradingview`

Recebe os sinais oficiais e agnósticos a Timeframe do TradingView.

**Headers:**
- `Content-Type: application/json`
- `X-WEBHOOK-TOKEN: <seu-token>`

**Payload Base:**
```json
{
  "strategy_id": "PEDRO_MVP_V1",
  "exchange": "BINANCE_TESTNET",
  "symbol": "ETHUSDT",
  "timeframe": "60",
  "price": 2845.5,
  "timestamp": "2026-02-25T12:00:00Z",
  "bar_close": true,
  "event": "MACD_ENTRY_LONG",
  "trend_1d": "UP"
}
```

## Eventos Válidos

| Evento | Descrição |
|--------|-----------|
| `MACD_ENTRY_LONG` | Abertura de operação Comprada (e reversão automática de eventuais Shorts) |
| `MACD_ENTRY_SHORT` | Abertura de operação Vendida (e reversão automática de eventuais Longs) |
| `VMC_PARTIAL_25_LONG` | Recolhimento (Take Profit virtual) de 25% da posição comprada |
| `VMC_PARTIAL_50_LONG` | Recolhimento (Take Profit virtual) de 50% da posição comprada |
| `VMC_PARTIAL_25_SHORT` | Recolhimento de 25% da posição vendida |
| `VMC_PARTIAL_50_SHORT` | Recolhimento de 50% da posição vendida |

## Estrutura Desacoplada e Governança Clean Architecture

A pasta `src` foi moldada com excelência. 

```
src/
├── index.ts                    # Bootstrap Fastify Integrado
├── config/
│   └── env.ts                  # Validação rigorosa de ambiente via Zod
├── domain/
│   ├── strategy-engine.ts      # Máquina de estados (Auto-Reversões e Cálculos de PNL)
│   └── risk-manager.ts         # Oráculo de Risco (Limites diários)
├── infra/
│   ├── binance-adapter.ts      # Adapter para a Binance via Rest API / FAPI (Substituível agnosticamente)
│   ├── telegram-notifier.ts    # Transmissão assíncrona ao Telegram do Contratante
│   └── prisma.ts               # Instância SQLite unificada
├── webhook/
│   ├── webhook.controller.ts   # Rotas de recepção, health e Status UI
│   ├── webhook.schema.ts       # Restrições matemáticas Zod
│   └── webhook.service.ts      # Filtro de repetições (Idempotência Hash)
└── utils/
    └── hash.ts                 # Algoritmo de Hashing criptográfico
```

A arquitetura foi projetada de forma a isolar completamente as decisões lógicas do `strategy-engine` do servidor financeiro. Migrar deste Testnet Binance para Bybit ou Kucoin no futuro exigirá apenas a adesão de um novo Adapter.
