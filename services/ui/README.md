# ui

React SPA (Vite) — graphical interface for trading bot monitoring, historical data exploration, and bot training visualization.

The UI is a "time machine": it can display both live market data and replay historical data at variable speed, letting you observe how the market evolved and how bots behaved at any point in time. Widgets are pure consumers of data — they know nothing about connections, time, or replay state. A central data layer handles all of that.

## Env vars

| Variable               | Default                            | Description          |
| ---------------------- | ---------------------------------- | -------------------- |
| `UI_PORT`              | `3000`                             | Browser-facing port  |
| `VITE_BITMEX_REST_URL` | `https://www.bitmex.com/api/v1`    | BitMEX REST base URL |
| `VITE_BITMEX_WS_URL`   | `wss://ws.bitmex.com/realtime`     | BitMEX WebSocket URL |

## tb commands

```sh
tb up gui/bitmex --build          # start
tb down gui/bitmex
tb logs gui/bitmex
```

## Technical reference

[docs/services/UI.md](../../docs/services/UI.md)
