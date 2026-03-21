# Executor Service

Receives a desired order state from the bot via HTTP, reconciles it against live orders tracked through the exchange WS, and fires the minimum set of REST calls needed to make them match. It knows nothing about strategy, market state, or why any order exists.

---

## Responsibility

The executor is the bot's abstraction layer for order management. The bot says "I want these orders to exist." The executor makes it happen — handling all the complexity of order CRUD, partial fills, amend thresholds, and error recovery. Information flows one way: bot → executor → exchange. The executor publishes nothing back.

---

## Input

### HTTP — `POST /desired-state`

Listens on `HTTP_PORT` (default: `3001`). Accepts a JSON body describing the complete desired order state for one symbol. Processes immediately and returns `200` on success or an error code if the request is malformed.

There is no queue, no backlog. If the executor is unavailable when the bot ticks, the bot's HTTP call fails, the tick is skipped, and fresh state arrives on the next tick. Stale desired states are never processed.

```typescript
interface DesiredState {
  symbol:    string
  orders:    DesiredOrder[]   // sorted closest-to-mid first
  timestamp: string           // ISO 8601
}

interface DesiredOrder {
  side:        'Buy' | 'Sell'
  orderQty:    number
  price:       number
  ordType:     'Limit'
  timeInForce: 'GoodTillCancel'
  execInst?:   string         // e.g. 'ParticipateDoNotInitiate'
}
```

An empty `orders` array is valid — the executor will cancel all open orders it owns for that symbol.

---

## Output

REST calls to `REST_URL` (BitMEX-compatible API):

| Method | Endpoint | Purpose |
|---|---|---|
| `PUT` | `/order` | Amend price and/or quantity |
| `POST` | `/order` | Create a new order |
| `DELETE` | `/order` | Cancel an order |

All created orders carry a `clOrdID` prefixed with `ORDERID_PREFIX`. This scopes the executor's view to orders it owns, allowing multiple executor instances to share an exchange account without interfering.

---

## State Management

### Live Order State via WS

The executor maintains in-memory state of its live orders by subscribing to the `order` table on the private WS stream (`WS_URL`). It does not query REST for order state at runtime — the WS stream is the authoritative source.

Delta accumulation follows the BitMEX pattern:

1. A `partial` message initialises the table snapshot. The executor discards any preceding `insert`/`update`/`delete` messages until a `partial` arrives.
2. Subsequent `insert`, `update`, and `delete` messages are applied using key indexing (`orderID` as key).
3. The resulting in-memory map is always the current live order state.

This logic is provided by the `@devvir/bitmex-deltas` package (shared with signal and other consumers), not duplicated here.

The executor filters the accumulated snapshot to orders whose `clOrdID` starts with `ORDERID_PREFIX`. Orders placed by other bots or manually are invisible to it.

### WS Authentication

Private streams require a signed authentication message sent immediately after the WS connection opens:

```
{ op: 'authKeyExpires', args: [apiKey, expires, signature] }
```

Where `expires` is a Unix timestamp (seconds) in the near future, and `signature` is `HMAC-SHA256(apiSecret, 'GET/realtime' + expires)`.

The executor subscribes to `order` after receiving the auth acknowledgement.

---

## Converge Orders Algorithm

Triggered on every incoming `POST /desired-state`. Computes the minimum diff between desired and live, then executes changes.

### Matching

Desired and live orders are matched **per side** independently:

- Bids: sort both lists descending by price (highest = closest to mid)
- Asks: sort both lists ascending by price (lowest = closest to mid)

Match by index within each side: `desired[0]` ↔ `live[0]`, `desired[1]` ↔ `live[1]`, etc.

### Decision per matched pair

**Amend** if:
- Price delta exceeds `AMEND_THRESHOLD_TICKS` (in tick units), **or**
- Desired quantity differs from effective remaining quantity

Amended quantity = `order.cumQty + desiredOrder.orderQty`. This accounts for partial fills: if an order is 30% filled, the amendment targets the remaining 70% of the desired size, not the full size.

**Leave alone** if price and quantity are within threshold.

### Unmatched

- Desired orders with no matching live order → **create**
- Live orders with no matching desired order → **cancel**

### Execution order

1. Amend first — keeps existing orders active and in-book during the transition
2. Create — fills any gaps
3. Cancel last — avoids being momentarily unhedged

---

## Error Handling

**Transient errors** (network failures, 503, timeouts): retry with exponential backoff, up to a configurable limit.

**Stale amend** (order already filled by the time the amend arrives, exchange returns 404 or "order not found"): treat as a create — place a new order at the desired price/quantity.

**Rate limits**: `REST_URL` is expected to be our rest service, which imposes no rate limits in exchange-app mode. Direct BitMEX testnet access (used during M1 verification) has rate limits; the executor respects `x-ratelimit-remaining` response headers and backs off accordingly.

**WS disconnection**: reconnect with exponential backoff. Discard accumulated order state and wait for a fresh `partial` before resuming converge cycles. During the reconnection window, incoming `POST /desired-state` requests return `503 Service Unavailable` — the bot will retry on the next tick with fresh state.

---

## Configuration

| Env var | Required | Default | Description |
|---|---|---|---|
| `WS_URL` | yes | — | WS endpoint (`wss://...`). BitMEX-compatible API. |
| `REST_URL` | yes | — | REST base URL (`https://...`). BitMEX-compatible API. |
| `API_KEY` | yes | — | Exchange API key (used for WS auth and REST auth). |
| `API_SECRET` | yes | — | Exchange API secret (used for HMAC signing). |
| `ORDERID_PREFIX` | yes | — | Prefix applied to all `clOrdID` values. Scopes this executor's orders. Must be unique per executor instance sharing an account. |
| `SYMBOLS` | yes | — | Comma-separated symbols this executor manages (e.g. `XBTUSD,ETHUSD`). |
| `HTTP_PORT` | no | `3001` | Port for the incoming DesiredState HTTP server. |
| `AMEND_THRESHOLD_TICKS` | no | `0.5` | Minimum price movement (in ticks) before an order is amended. Below this, the order is left alone. |

---

## Pre-task: `@devvir/bitmex-deltas`

Before implementing the executor, the delta accumulation logic from `services/snapshots/src/accumulator.ts` is extracted into a standalone package at `packages/bitmex-deltas`. This package will be used by the executor (for the `order` table), the signal service (for `orderBookL2`, `trade`, `instrument`, etc.), and any future service that needs to maintain live state from a BitMEX-compatible WS stream.

The package exports two pure functions:

```typescript
// Initialise a new snapshot from a 'partial' message
newSnapshot(message: BitmexPartial): Snapshot

// Apply a delta (insert/update/delete) to an existing snapshot
applyDelta(snapshot: Snapshot, message: BitmexDelta): void
```

The executor uses it for the `order` table only. It is responsible for filtering the resulting snapshot to its own `ORDERID_PREFIX` — that concern belongs to the executor, not to the delta package.

---

## Testing Approach (M1)

The executor is fully testable without a running bot. A stub script sends a hardcoded `DesiredState` to `POST /desired-state`. The executor picks it up, reads live orders from its WS-accumulated state, runs converge, and fires REST calls.

Target: verified end-to-end against BitMEX testnet (direct `WS_URL` + `REST_URL` pointing to `testnet.bitmex.com`). Once the exchange app's WS and REST services are complete, no code changes are needed — only env var changes.
