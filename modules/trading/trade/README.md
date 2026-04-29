# Trade Module

Runs the **trader** bot: connects to a BitMEX-compatible WebSocket + REST
endpoint, runs a strategy, and reconciles open orders against the strategy's
intent each tick.

## What it does

1. Subscribes to the strategy's data dependencies (e.g. `quote`, `instrument`)
   on the WS endpoint and caches the latest snapshot per table.
2. Every `TRADER_TICK_INTERVAL_MS`, calls `strategy.decide(snapshot)` to get
   the orders the strategy wants on the book.
3. Computes a minimal `amend → create → cancel` plan against the current
   managed orders (seeded from REST on startup).
4. Applies the plan via REST. Stale amends fall back to a re-create at the
   same desired-side slot.

## Default deployment

The trade module on its own only runs the `trader` service. It expects a
BitMEX-compatible WS + REST endpoint to be reachable on the shared
`tradebot-network`:

  - `ws://ws`     — our `ws` service
  - `http://rest` — our `rest` service (which forwards to `proxy` for signing)

These come from the **`exchange/live`** or **`exchange/replay`** module —
bring one of those up first, then bring up `trade`.

## Running against BitMEX directly

Set the URLs to BitMEX:

```env
TRADER_WS_URL=wss://www.bitmex.com/realtime
TRADER_REST_URL=https://www.bitmex.com
```

No other change is needed. The trader signs every REST request and the WS
connection URL using `TRADER_API_KEY` / `TRADER_API_SECRET` (BitMEX-compatible
HMAC). Our proxy detects pre-signed requests and forwards them verbatim, so
the same code path works against both endpoints.

## Environment

See `.env.example` for the full list. Required:

- `TRADER_API_KEY`     — BitMEX api-key for the account being traded
- `TRADER_API_SECRET`  — BitMEX api-secret (used for HMAC signing)

Optional (with sensible defaults):

- `TRADER_WS_URL`            — defaults to `ws://ws`
- `TRADER_REST_URL`          — defaults to `http://rest`
- `TRADER_STRATEGY`          — defaults to `range`
- `TRADER_SYMBOL`            — defaults to `XBTUSD`
- `TRADER_TICK_INTERVAL_MS`  — defaults to `30000`

## Strategies

Strategies live in `services/trader/src/strategies/` and are registered in
`registry.ts`. The bundled `range` strategy places one buy + one sell each
tick at ±1% from mid — useful for verifying the end-to-end flow, not for
making money.
