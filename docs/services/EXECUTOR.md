# Executor Service

Receives a desired order state from a bot via HTTP, reconciles it against live orders tracked through the exchange WS, and fires the minimum set of REST calls needed to make them match. It knows nothing about strategy, market state, or why any order exists.

---

## Responsibility

The executor is the bot's abstraction layer for order management. The bot says "I want these orders to exist." The executor makes it happen — handling all the complexity of order CRUD, partial fills, amend thresholds, and error recovery. Information flows one way: bot → executor → exchange. The executor publishes nothing back.

The executor is **multi-account**: it maintains a WS connection pool keyed by `accountId`. Connections are opened lazily on the first plan for each account and reused for all subsequent plans.

---

## Input

### HTTP — `POST /plan`

Listens on port `3001` (mapped to host via `EXECUTOR_HTTP_PORT`). Accepts a JSON body describing the complete desired order state for one account + symbol. Returns `200` on success.

There is no queue, no backlog. If the executor is unavailable when the bot ticks, the HTTP call fails, the tick is skipped, and fresh state arrives on the next tick. Stale desired states are never processed.

```typescript
interface DesiredState {
  accountId:       string          // account to operate on (resolved via Bouncer)
  symbol:          string
  orders:          DesiredOrder[]  // sorted closest-to-mid first
  timestamp:       string          // ISO 8601
  amendThreshold?: number          // absolute price delta; 0 = any change triggers amend (default: 0)
}

interface DesiredOrder {
  side:            'Buy' | 'Sell'
  ordType:         'Limit' | 'Market' | 'Stop' | 'StopLimit' | 'MarketIfTouched' | 'LimitIfTouched' | 'Pegged'
  orderQty?:       number
  price?:          number
  stopPx?:         number
  pegOffsetValue?: number
  pegPriceType?:   'TrailingStopPeg' | 'PrimaryPeg' | 'MarketPeg'
  timeInForce?:    'GoodTillCancel' | 'ImmediateOrCancel' | 'FillOrKill' | 'Day'
  execInst?:       string
  displayQty?:     number
}
```

An empty `orders` array is valid — the executor will cancel all open orders it owns for that symbol.

---

## Output

REST calls to `EXECUTOR_REST_URL` (BitMEX-compatible API), authenticated via Bouncer:

| Method | Endpoint | Purpose |
|---|---|---|
| `PUT` | `/api/v1/order` | Amend price and/or quantity |
| `POST` | `/api/v1/order` | Create a new order |
| `DELETE` | `/api/v1/order` | Cancel an order |

All created orders carry a `clOrdID` prefixed with `tb_<symbol>_`. This scopes the executor's view to orders it owns for that symbol, allowing multiple accounts and symbols to coexist without interference.

---

## Authentication

The executor has no API keys of its own. All credentials are resolved at runtime through **Bouncer**:

- **WS auth**: `GET /accounts/{accountId}?expires={ts}` — Bouncer returns `{ type, apiKey, signature }`, which the executor uses to send a pre-signed `authKeyExpires` message to the exchange WS.
- **REST auth**: `POST /sign/rest` — Bouncer signs each REST request body and returns `{ apiKey, expires, signature }`, which are passed as `api-key` / `api-expires` / `api-signature` headers.

The WS URL is derived from the account type (`live` → mainnet, `testnet` → testnet, `replay` → exchange app WS).

---

## State Management

### WS Connection Pool

Each account gets one WS connection, opened lazily on the first `/plan` request for that account. Connections are pooled and reused. If the WS closes, it is removed from the pool; the next `/plan` will re-open it.

### Live Order State

The executor subscribes to the `order` table on the private WS stream. Delta accumulation uses `@devvir/bitmex-database`:

1. A `partial` message initialises the snapshot. Preceding deltas are discarded.
2. Subsequent `insert`, `update`, `delete` messages are applied using `orderID` as the key.
3. The in-memory snapshot is always the current live order state.

Before converging, the snapshot is filtered to orders that are:
- For the requested `symbol`
- Owned by this executor (`clOrdID` starts with `tb_<symbol>_`)
- Active (`ordStatus` is `New` or `PartiallyFilled`)

### WS Not Ready

If a `/plan` arrives before the WS is authenticated and the order snapshot initialised, the executor returns `503 Service Unavailable`. The bot retries on the next tick with fresh state.

---

## Converge Orders Algorithm

Triggered on every `POST /plan`. Computes the minimum diff between desired and live, then executes changes.

### Matching

Desired and live orders are matched **per side** independently:

- Bids: sort both lists descending by price (highest = closest to mid)
- Asks: sort both lists ascending by price (lowest = closest to mid)

Match by index within each side: `desired[0]` ↔ `live[0]`, `desired[1]` ↔ `live[1]`, etc.

### Decision per matched pair

**Amend** if:
- `|desired.price - live.price| > amendThreshold`, **or**
- `desired.orderQty !== live.leavesQty`

Amended quantity targets `leavesQty` directly — already accounts for partial fills.

**Leave alone** if both price and quantity are within threshold.

### Unmatched

- Desired orders with no matching live order → **create**
- Live orders with no matching desired order → **cancel**

### Execution order

1. Amend first — keeps existing orders active and in-book during the transition
2. Create — fills any gaps
3. Cancel last — avoids being momentarily unhedged

### Stale amend fallback

If an amend returns a "not found" response (order filled between the live snapshot and the REST call), the executor creates a new order at the desired price/quantity.

---

## Error Handling

**Transient errors** (network failures, 5xx): retry up to 3 times with linear backoff (`500ms × attempt`).

**Rate limits**: respects `x-ratelimit-remaining` response header. Pauses when remaining < 10. Retries after the reset timestamp on `429`.

**WS disconnection**: connection removed from pool. Next `/plan` will re-establish.

---

## Configuration

| Env var | Required | Default | Description |
|---|---|---|---|
| `BOUNCER_URL` | yes | — | Bouncer base URL (e.g. `http://bouncer:80`) |
| `BOUNCER_TOKEN` | yes | — | Bearer token for Bouncer authentication |
| `EXECUTOR_REST_URL` | yes | — | BitMEX-compatible REST base URL (e.g. `https://www.bitmex.com`) |
| `EXECUTOR_HTTP_PORT` | no | — | Host port mapped to the internal HTTP server (port `3001`) |
| `EXECUTOR_HEALTH_PORT` | no | — | Host port mapped to the health check server (port `3000`) |
| `EXECUTOR_RESTART_POLICY` | no | `unless-stopped` | Docker restart policy |

