# Trader Service

Lightweight trading bot orchestrator with separated concerns for strategy, planning, execution, and data management.

## Module Structure

- **core** — Orchestrator that ties everything together
- **source** — Data boundary (WS/REST connections)
- **strategies** — Decision makers (Range strategy for skateboard)
- **planner** — Translates pseudo-orders to BitMEX orders
- **executor** — Reconciles and applies order changes

## Running

```bash
npm run build
npm run dev
npm test
```

## Skateboard Features

- Range strategy: buys and sells 1% away from mid price
- Updates orders every 30 seconds
- Executes against BitMEX testnet via REST
- Subscribes to quote data via WebSocket
