
# BOT TRADER — MVP V1 (Pedro) — Spec

> Fonte da verdade do projeto.  
> Qualquer mudança de regra/escopo deve ser registrada aqui antes de alterar o código.

---

## 1) Objetivo

Construir um bot trader automatizado que receba sinais do TradingView via webhook e execute operações em **Binance Futures Testnet** para **ETHUSDT**, em **One-way**, **Cross**, usando **Market orders** sempre.

O MVP deve ter:
- execução confiável e determinística
- controle de risco básico (SL, BE, kill switch diário, cap de exposição)
- logs/auditoria
- notificações via Telegram
- rodar primeiro em Testnet

---

## 2) Configuração do MVP

- Exchange: Binance Futures Testnet
- Symbol: ETHUSDT
- Timeframe (inicial): 1h
- Position mode: One-way (positionIdx = 0)
- Margin mode: Cross
- Order type: Market (sempre)
- TradingView Alerts: Once per bar close (obrigatório)

### Parâmetros (.env)

SL_PCT = 0.01
BE_BUFFER = 0.0005
DAILY_DD_LIMIT = 0.04
CAP_EXPOSURE_PCT = 0.10
QTY_MODE = fixed_usdt
QTY_VALUE_USDT = 50
MIN_REMAINING_POSITION_PCT = 0.10

---

## 3) Eventos de Webhook

- MACD_ENTRY_LONG
- MACD_ENTRY_SHORT
- VMC_PARTIAL_25_LONG
- VMC_PARTIAL_50_LONG
- VMC_PARTIAL_25_SHORT
- VMC_PARTIAL_50_SHORT

---

## 4) Payload

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

Validações:
- bar_close deve ser true
- symbol deve ser ETHUSDT
- exchange deve ser BYBIT_TESTNET
- event deve ser válido

---

## 5) Máquina de Estados

Estados:
- FLAT
- LONG
- SHORT

Entrada:
- FLAT + MACD_ENTRY_LONG → abre LONG
- FLAT + MACD_ENTRY_SHORT → abre SHORT
- Se já houver posição → ignora entradas

Parciais:
- LONG + VMC_PARTIAL_25_LONG → reduz 25%
- LONG + VMC_PARTIAL_50_LONG → reduz 50%
- SHORT + VMC_PARTIAL_25_SHORT → reduz 25%
- SHORT + VMC_PARTIAL_50_SHORT → reduz 50%

Break-even:
- Após primeira parcial → mover SL para BE + buffer

Stop Loss:
- LONG: entry * (1 - SL_PCT)
- SHORT: entry * (1 + SL_PCT)

Kill Switch:
- Se perda diária >= DAILY_DD_LIMIT → pausar execuções

---

## 6) Integração Binance (FAPI Testnet)

Endpoints:
- /v5/order/create
- /v5/position/list
- /v5/position/trading-stop

Sempre usar:
- Market order
- positionIdx = 0

---

## 7) Persistência

Tabelas:
- signals
- orders
- positions
- daily_pnl
- settings

---

## 8) Notificações Telegram

Enviar notificação para:
- Entry
- Parcial
- Break-even
- Stop
- Kill switch
- Erros críticos

---

## 9) Critérios de Aceite

- Webhook validado
- Idempotência funcionando
- Entry executa corretamente
- SL configurado
- Parcial reduz posição
- BE aplicado após primeira parcial
- Kill switch bloqueia novas entradas
- Logs persistidos

---

## 10) Roadmap Futuro

- Target Price (TP1/TP2)
- Filtro 1D
- Reversão automática
- Painel Web
- Multi-par
- Conta real

