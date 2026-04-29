# Trader Service — Technical Reference

## Overview

A trading bot orchestrator. It connects to a BitMEX-compatible WebSocket
endpoint for market data, runs a strategy on a fixed tick, and reconciles the
strategy's intent against the live order book via a BitMEX-compatible REST
endpoint.

```
WS endpoint ──► source/ws ──► dispatch ──► cache
                                              │
                                              ▼
                                      strategy.decide()
                                              │
                                              ▼
                                      planner.translate()
                                              │
                                              ▼
                                       executor.converge() ──► amend → create → cancel
                                              │                          │
                                              ▼                          ▼
                                       managed-orders        rest/client (signed REST)
```

Both the WS and the REST endpoint can be our own services (`ws`, `rest` →
`proxy`) or BitMEX directly (`wss://www.bitmex.com/realtime`,
`https://www.bitmex.com`). Every request is signed BitMEX-compatible, our
proxy forwards pre-signed requests verbatim, and there is no logical branch
on which endpoint is in use anywhere in the code.

## Module Layout

```
src/
├── auth/        BitMEX-compatible HMAC signing (REST + WS)
├── source/      Inbound: WS lifecycle, table → cache dispatch, in-memory cache
├── rest/        Outbound: signed REST client (create / amend / cancel / get)
├── strategies/  Decision makers — registry + base class
├── planner/     PseudoOrder → BitMEX OrderPlan (rounding, lot/tick)
├── executor/    Converge algorithm + applier (amend → create → cancel)
└── core/        Orchestrator + managed-orders bookkeeping
```

Each module has a `types.ts` and a barrel `index.ts`. Imports cross module
boundaries only through the barrel; everything else is private.

## Tick Loop

Every `tickIntervalMs` (per-strategy, default 30s):

1. Read the current snapshot from the cache.
2. Call `strategy.decide(snapshot)` → `PseudoOrder[]` (intent).
3. Translate to fully-specified `OrderPlan[]` using cached instrument
   metadata to round price to tick and quantity to lot.
4. Filter the locally-tracked managed orders to active ones for the symbol.
5. Run `converge(desired, live, amendThreshold)` to compute the minimum set
   of `amend` / `create` / `cancel` ops that makes live match desired.
6. Apply the ops via REST (amend → create → cancel ordering — see below).
7. Update the managed-orders list from the apply result.

Ticks are self-rescheduling: the next tick is queued only after the current
one resolves. A slow tick (REST retries) can never overlap with itself.

## Strategies

A strategy is a pure decision-maker:

```typescript
interface Strategy {
  name: string;
  decide(data: StrategyInput): PseudoOrder[];
}

interface PseudoOrder {
  side:      'buy' | 'sell';
  price:     number;
  quantity?: number;
}

interface StrategyInput {
  quote:      Quote      | null;
  orders:     Order[];                  // currently always [] — managed locally
  position:   Position   | null;
  instrument: Instrument | null;
}
```

Strategies are registered in `strategies/registry.ts`:

```typescript
const STRATEGIES = {
  range: {
    factory:  () => new RangeStrategy(),
    defaults: {
      name:           'range',
      dependencies:   ['quote', 'instrument'],
      tickIntervalMs: 30_000,
      amendThreshold: 0,
    },
  },
};
```

`dependencies` is a list of `DataDependency` values — `quote`, `instrument`,
`orders`, `position`, `trades` — which the source layer translates into
BitMEX WS table subscriptions on connect.

The bundled `range` strategy places one buy + one sell at ±1% from mid each
tick.

## Source — WebSocket

`source/ws.ts` owns the connection lifecycle:

- **Auth.** Connection URL is signed via `auth.signWsUrl()` —
  `?api-key=&api-expires=&api-signature=` query params. BitMEX validates;
  our `ws` service reads `api-key` for routing and ignores the signature.
- **Subscribe.** On connect, subscriptions are sent as
  `{ op: 'subscribe', args: ['table:symbol', ...] }` per the BitMEX WS
  protocol. Subscriptions are remembered and re-sent on reconnect.
- **Reconnect.** On `close`, reconnect with capped exponential backoff
  (1s → 30s, doubling). Disabled after explicit `disconnect()`.

`source/dispatch.ts` is a table-keyed dispatch map: `{ quote, instrument,
position }` → cache update handler. Adding a table is one entry. Updates are
merged onto the cached snapshot since BitMEX sends sparse `update` messages.
Unknown tables are silently dropped (BitMEX sends control frames and tables
the trader never asked for).

`source/cache.ts` is the synchronous, in-memory snapshot store the
orchestrator reads each tick.

## Rest — Outbound Client

`rest/client.ts` (`HttpRestClient`) is the only outbound surface. It implements
the `RestClient` interface used by the orchestrator (for `getOrders` on
startup) and the applier (for `createOrder`, `amendOrder`, `cancelOrders`).

- **Signing.** Every request carries `api-key`, `api-expires`, and
  `api-signature` headers. The signature is `HMAC_SHA256(secret, verb + path
  + expires + body)`.
- **Rate limiting.** When the response's `x-ratelimit-remaining` falls below
  10, the client sleeps until the reset time before issuing more requests.
- **Retry.** Network errors and 5xx responses retry up to 3 times with
  linear backoff (500ms × attempt).
- **Stale amend.** Amends return `null` on 404 and on 400 with body
  containing `Not Found` (BitMEX returns 400 for some not-found cases). The
  applier detects null and falls back to a fresh create.
- **Bulk cancel.** A single ID is sent as a string; multiple IDs are
  JSON-encoded into an array, matching BitMEX's bulk-cancel quirk.

## Executor — Converge & Apply

### Converge Algorithm

Matching is positional within each side. Bids are sorted descending by price
(closest-to-mid first), asks ascending. `desired[i]` pairs with `live[i]`
within each side independently:

- Both present → amend if `|priceDelta| > amendThreshold` or
  `desired.orderQty ≠ live.leavesQty`.
- Desired only → create.
- Live only → cancel.

`amendThreshold` is an absolute price delta; `0` means any change triggers
an amend. `leavesQty` is set to the desired `orderQty` regardless of any
partial fills, which automatically replenishes a partially-filled order.

### Apply Order

1. **Amend** first — keeps existing orders active during the transition.
2. **Create** — fills any gaps the converge plan identified.
3. **Cancel** last — the book is never briefly unhedged.

### Stale Amend Fallback

If `amendOrder` returns `null` (the order filled or vanished between the
snapshot and the REST call), the applier finds the matching desired order
by re-running the same positional sort, and issues a `createOrder` at that
price/qty. Only when no desired counterpart exists does the order get
removed from the managed list.

## Core — Managed Orders

The orchestrator manages orders locally rather than subscribing to the
private `order` WS stream. On startup it calls `getOrders(symbol)`,
filters to active orders owned by this trader (`clOrdID` starts with
`tb_<symbol>_`), and keeps the result up to date from each apply result.

### clOrdID Format

`tb_<SYMBOL>_<6-digit-zero-padded-sequence>`, e.g. `tb_XBTUSD_000042`.

The numeric sequence keeps clOrdIDs unique within one process run. On
startup, the sequence is seeded from the highest existing managed order so
a quick restart resumes past the last known number. Without this seeding,
the next ID after a restart would be `_000001` and collide with any
still-resting order.

### Ownership Scope

`clOrdID` prefix `tb_<symbol>_` scopes a trader instance to its own orders
only. Multiple symbols and multiple accounts coexist on the same exchange
without interfering — the converge algorithm only sees orders this instance
owns.

## Authentication Model

The trader signs every REST request and the WS connection URL itself. There
is no `accountId` header, no bouncer call from the trader, and no
configuration branch that distinguishes "ours" from "live":

| Endpoint | What happens |
|---|---|
| `wss://www.bitmex.com/realtime` + `https://www.bitmex.com` | BitMEX validates signatures directly. |
| `ws://ws` + `http://rest` (our services) | `rest` forwards to `proxy`. The proxy detects a pre-signed request (api-key + api-signature present) and forwards it verbatim to BitMEX. `ws` reads `api-key` for routing and ignores the signature. |

The same code path works in both deployments. Switching is a URL change.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TRADER_WS_URL`            | yes | `ws://ws`   | WS endpoint |
| `TRADER_REST_URL`          | yes | `http://rest` | REST endpoint |
| `TRADER_API_KEY`           | yes | — | BitMEX api-key |
| `TRADER_API_SECRET`        | yes | — | BitMEX api-secret |
| `TRADER_STRATEGY`          | no  | `range`  | Strategy name in the registry |
| `TRADER_SYMBOL`            | no  | `XBTUSD` | Symbol to trade |
| `TRADER_TICK_INTERVAL_MS`  | no  | `30000`  | Tick cadence |

Single symbol per process. Multiple symbols means multiple trader
containers, each with its own credentials.

## Limits

- One symbol per process.
- One strategy per process.
- The `order` and `position` WS streams are not currently subscribed to —
  orders are managed via REST, and `position` arrives in the cache only if
  a strategy declares `position` in its dependencies.
- Recovering a strategy's internal state across restarts is the strategy's
  responsibility. The orchestrator only reseeds the managed-order list and
  the clOrdID sequence.

## Tests

Test files under `services/trader/tests/`:

| File | Covers |
|---|---|
| `auth.test.ts` | HMAC signing for REST headers and WS query params |
| `config.test.ts` | env loading, validation of required fields |
| `converge.test.ts` | converge: no-op / amend / create / cancel / positional matching |
| `dispatch.test.ts` | quote / instrument / position dispatch and merge behaviour |
| `flow.integration.test.ts` | strategy → planner → cache → orchestrator end-to-end |
| `managed-orders.test.ts` | `applyToOrderList`, `buildClOrdID`, `seedSequence` |
| `registry.test.ts` | strategy registry lookup and error reporting |
| `rest-client.test.ts` | signed headers, stale amends, batch cancel encoding |
| `ws.test.ts` | WS message parsing |
