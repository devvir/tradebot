# Teller Service — Technical Reference

## What teller is

Teller is the private-exchange mock for the replay module. It gives training bots a
fully BitMEX-compatible private API — order management, position tracking, fills,
executions, and wallet — without touching a real exchange.

Digger owns the public stream (market data). Teller owns everything that is
per-account: orders, positions, fills, and margin. Together they present a complete
exchange surface to bots and the `ws` / `rest` services that sit in front of them.

```
                                          ┌──────────────────────────────────────────┐
                                          │              replay module               │
                                          │                                          │
digger ──► topic:replay ─────────────────►│──► ws.deltas@topic:deltas ──► ws ◄── bots
                                          │                            ▲             │
teller ──► topic:replay (private msgs) ──►│────────────────────────────┘             │ REST
           (x-account-id header)          │                                          │
                                          │      bots ──► rest ──► digger (public)   │
                                          │                    └──► teller (private) │
                                          └──────────────────────────────────────────┘
```

Teller does not talk to bots directly. Bots connect to `ws` and `rest` as they
always do. Teller is an internal backend that `rest` routes private calls to, and
that publishes private WS events into the same RabbitMQ stream that `ws` consumes.

---

## Module layout

```
src/
├── accounts/     Account registry — api-key → account init and lookup
├── orders/       Order lifecycle — create / amend / cancel / state machine
├── fills/        Fill simulation — market consumer, crossing detection, execution
├── positions/    Position tracking — currentQty and avgEntryPx per account/symbol
├── margin/       Wallet and margin state per account
├── publisher/    RabbitMQ publishing — format and send private WS events
├── db/           MongoDB collection accessors (one file per collection)
├── rest/         Express routes — private REST API surface
├── types.ts      All interfaces and types (no inline types elsewhere)
├── config.ts     Env loading and validation
├── service.ts    SKFactory declaration (service-kit wiring)
└── index.ts      Entry point: wires service, starts HTTP server and consumer
```

Each subfolder has a `types.ts` and an `index.ts` barrel. Cross-module imports go
through the barrel only; nothing reaches into another module's internals.

---

## Design principle: functional core, thin boundaries

Teller will grow in complexity as fill modelling, partial fills, liquidation, and
order type support are added. The only way to keep that manageable is to ensure
each piece is independently testable without standing up RabbitMQ, MongoDB, or an
HTTP server.

**The rule:** business logic is pure functions. Boundaries are thin and dumb.

```
RabbitMQ consumer ──► fills/consumer.ts ──► fills/engine.ts (pure)
                                                │
                                        orders/ positions/ margin/
                                        (all pure functions)
                                                │
                              ◄── db/writes.ts (thin) ◄──
                              ◄── publisher.ts  (thin) ◄──
```

### Functional core

The core modules (`fills/engine`, `orders`, `positions`, `margin`) are pure
functions: they receive plain data as arguments and return plain data as results.
No I/O, no side effects, no knowledge of RabbitMQ, MongoDB, or Express.

```typescript
// fills/engine.ts
findCrossings(orders: Order[], tradePrice: number): Order[]

// orders/index.ts
createOrder(state: AccountState, req: CreateRequest): { state: AccountState, order: Order }
amendOrder(state: AccountState, orderId: string, fields: AmendFields): { state: AccountState, order: Order }

// positions/index.ts
applyFill(position: Position, fill: Fill, instrument: Instrument): Position

// margin/index.ts
applyFill(margin: Margin, fill: Fill, prevPosition: Position, nextPosition: Position): Margin
applyDeposit(margin: Margin, amount: number): Margin
recomputeLiquidation(position: Position, margin: Margin, instrument: Instrument): Position
```

A test drives the fill engine by calling `findCrossings` with a hand-crafted order
list and a price. It drives order creation by calling `createOrder` with a state
object. No mocks, no stubs, no test doubles — just data in, data out.

### Thin boundaries

Boundaries are the only places that touch external systems, and they contain no
logic — only translation and sequencing:

- **`fills/consumer.ts`** — receives a raw RabbitMQ message, extracts the trade
  price and symbol, calls `fills/engine`, then calls `executeFill` for each result.
  The same `executeFill` sequence can be called directly in a test.
- **`rest/routes.ts`** — parses an HTTP request, calls the appropriate core
  function, serialises the result to JSON. No business logic lives here.
- **`db/`** — one file per collection (`order.ts`, `execution.ts`, `position.ts`,
  `margin.ts`), each accepting plain documents and writing to MongoDB. Called after
  in-memory state is already updated; never called from core functions.
- **`publisher.ts`** — accepts plain WS message payloads and publishes to
  RabbitMQ. Called after DB writes succeed; never called from core functions.

### Indirection is an advantage here

The fill engine does not know or care whether the trade that triggered it came from
a RabbitMQ message, a test fixture, or a future HTTP endpoint for injecting synthetic
trades. The deposit handler does not know whether it was called from a REST route or
an orchestrator script. This indirection is intentional: it means each piece can be
tested, replaced, or extended independently.

### Subfolder responsibilities

**accounts/** — Pure functions for initialising new account state (seed `margin`,
empty `orders` and `positions`). No I/O; the boundary layer calls these and then
writes to MongoDB.

**orders/** — Pure functions for all order state transitions: `createOrder`,
`amendOrder`, `cancelOrder`. Each takes the current `AccountState` and a request,
returns the new `AccountState` and the resulting order document. No I/O.

**fills/** — Split into two files:
- `engine.ts` — pure: `findCrossings(orders, tradePrice)` → crossed orders. No
  knowledge of RabbitMQ or the store.
- `consumer.ts` — boundary: receives raw RabbitMQ trade messages, extracts price
  and symbol, calls `engine.ts`, runs `executeFill` for each crossing.

**positions/** — Pure functions: `applyFill(position, fill, instrument)` → updated
position. `recomputeUnrealisedPnl(position, markPrice)` → updated position. No I/O.

**margin/** — Pure functions: `applyFill`, `applyDeposit`, `recomputeLiquidation`,
`applyOrderMargin` (debit/credit on create/cancel). Each takes current state and
returns new state. No I/O.

**publisher/** — Boundary only. Accepts plain WS message payloads and routing keys,
publishes to `topic:replay` with the correct headers. Contains no business logic.

**db/** — Boundary only. One file per collection (`order.ts`, `execution.ts`,
`position.ts`, `margin.ts`) plus `bootstrap.ts`, which ensures indexes and loads
all existing account state into the in-memory store on startup. No business logic —
only find/insertOne/replaceOne/updateOne wrappers with typed signatures.

**rest/** — Boundary only. Express router mounted at `/api/v1`. Parses request,
resolves account from `api-key` header, calls the appropriate pure core function,
serialises result to JSON. No business logic lives here.

---

## Account model

An account is identified by its **api-key** — the same string the bot puts in
`api-key` headers. There is no separate account table. The api-key is used directly
as the accountId in every collection, in RabbitMQ headers, and in WS routing keys.

**Account creation**: on the first REST request from an unknown api-key, teller
creates seed documents in MongoDB:

- one `margin` record (configured starting wallet balance, zero PnL)
- no `order` records (empty)
- no `position` records (created on first fill)

`TELLER_INITIAL_BALANCE` sets the starting wallet for all new accounts.

There is no explicit registration step. Accounts materialise on first use. For a
clean reset (new training run), delete the account's documents from all collections
— a future `POST /reset/:accountId` command will automate this.

---

## In-memory state

Teller runs as a single instance. All live account state is kept in memory and is
the primary read path during normal operation. MongoDB is the write path (durability)
and the load source on startup.

```
store: Map<accountId, AccountState>

AccountState {
  margin:    MarginDoc                    // one per account
  positions: Map<symbol, PositionDoc>    // one per open or recently closed position
  orders:    Map<orderID, OrderDoc>      // open orders only (Filled/Canceled are evicted)
}
```

**Startup sequence:**

1. `db/bootstrap.ts` ensures indexes and loads all `margin`, non-terminal `order`,
   and `position` documents into the in-memory store.
2. Teller calls digger's subscribe endpoints (`POST {DIGGER_URL}/subscribe/trade`,
   `POST {DIGGER_URL}/subscribe/instrument`) to start the data streams it needs.
   Digger starts no subscriptions on its own — teller must request them. Subscriptions
   are unfiltered (whole table, all symbols); teller handles any per-symbol logic
   internally. This is intentional: filtering by symbol adds complexity for minimal
   gain, since dominant symbols (e.g. XBTUSD) make up the vast majority of traffic
   regardless.
3. HTTP server and RabbitMQ consumer start. The consumer begins receiving trade and
   instrument messages from digger.

This ordering ensures the fill scan and REST reads are immediately consistent with
the last persisted state before any new market data arrives.

**Write ordering:** on any state change (fill, order create/amend/cancel, mark price
update), teller follows this sequence:

1. Update in-memory state — other concurrent operations immediately see the new
   state, preventing double-fills.
2. Write to MongoDB — awaited before publishing WS events, so a crash before this
   completes leaves the DB consistent with the pre-event state.
3. Publish WS events.

**Execution history** is write-only to MongoDB during normal operation. The
`GET /api/v1/execution` REST endpoint queries MongoDB directly — execution history
is never needed by the fill loop, so there is no reason to hold it in memory.

**On restart:** state is fully restored from MongoDB. No in-flight state is lost
because WS events are only published after the DB write succeeds.

---

## Order lifecycle

### State machine

```
New ──► PartiallyFilled ──► Filled
    └──► Canceled
         (PartiallyFilled can also cancel to Canceled)
```

Orders enter as `New`. Each fill advances `cumQty` and decrements `leavesQty`. When
`leavesQty` reaches zero the order becomes `Filled`. A cancel sets `ordStatus` to
`Canceled` regardless of `cumQty`.

### Order document shape

Stored in the `order` collection. Fields follow the BitMEX `order` table schema:

| Field | Type | Notes |
|-------|------|-------|
| `orderID` | string | UUID generated by teller on create |
| `clOrdID` | string | Client-assigned; unique per account |
| `accountId` | string | api-key |
| `symbol` | string | e.g. `XBTUSD` |
| `side` | `Buy` \| `Sell` | |
| `ordType` | `Limit` \| `Market` | v1 only |
| `price` | number | Null for Market orders |
| `orderQty` | number | Original quantity (contracts) |
| `leavesQty` | number | Remaining quantity |
| `cumQty` | number | Filled quantity so far |
| `avgPx` | number | Volume-weighted average fill price |
| `ordStatus` | string | `New`, `PartiallyFilled`, `Filled`, `Canceled` |
| `timestamp` | ISO-8601 | Set from the replay clock on create |
| `text` | string | Human reason for last status change |

### Amend rules

Only `price` and `orderQty` can be amended. Amending `orderQty` to a value ≤
`cumQty` cancels the order (same as BitMEX behaviour). `leavesQty` is recomputed
as `orderQty - cumQty` after an amend. Amending a `Filled` or `Canceled` order
returns `400`.

### clOrdID uniqueness

Teller enforces uniqueness per account at the collection level (unique index on
`{accountId, clOrdID}`). A duplicate returns `400` with the BitMEX error shape.

---

## Fill simulation

Fill simulation is the core of teller's runtime behaviour. It runs as an event loop
driven by the inbound RabbitMQ consumer, not on a fixed timer.

### Trigger: trade messages

Teller binds a queue to the `topic:replay` exchange with routing key `trade.insert`.
Every trade batch digger publishes flows through here.

Trade is the correct trigger because a trade represents a real intention that was
executed. A quote moving to 98 with no trade means someone was willing to sell at 98
but nobody actually did — if the price then recovered to 102 without a trade, the
real order book may never have filled at that level either. Using quote as the trigger
would overstate fills in low-liquidity gaps. Only an actual trade through our level
gives reasonable confidence our order would have been filled.

### Price guard

`fills/` maintains a per-symbol price guard in memory:

```
guards: Map<symbol, { highestBid: number | null, lowestAsk: number | null }>
```

`highestBid` is the most aggressive buy limit price resting across all accounts for
that symbol; `lowestAsk` is the most aggressive sell limit price. Both are `null`
when no orders exist on that side.

**Guard check (O(1)):** a trade at price T can only cross orders if
`T ≤ highestBid` (crosses a buy) or `T ≥ lowestAsk` (crosses a sell). If neither
condition holds, the trade is in a dead zone — no looping occurs.

**Guard maintenance:** updated on every order create, fill, and cancel. When the
order that set the guard is removed, the new guard is recomputed from the remaining
orders for that symbol and side. Given the expected number of open orders (dozens of
bots × a handful of orders each), this recompute is trivially fast.

### Crossing scan (only when guard triggers)

On each trade batch for symbol S with trade price T:

1. Check guard — if no crossing possible, return immediately.
2. Collect all open limit orders for S from all accounts' in-memory maps.
3. Identify crossings:
   - **Buy limits**: sort descending by price, iterate; collect orders with
     `price >= T`, stop at first `price < T`.
   - **Sell limits**: sort ascending by price, iterate; collect orders with
     `price <= T`, stop at first `price > T`.
4. For each crossed order, run `executeFill(order, fillPx, fillQty)`.

### Fill price

Fill price is the **order's own limit price**, regardless of the trade price that
triggered the crossing. A buy limit at 100 crossed by a trade at 98 fills at 100.

This is a v1 simplification. The real fill price depends on where in the spread the
order would have matched — somewhere between the limit price and the crossing trade
price — which in turn depends on queue position, order book depth at each level, and
whether other resting orders at the same price would have absorbed the trade first.
These factors are not modelled in v1. The limit price is a conservative, unambiguous
baseline: the bot always gets at least what it asked for, never better, never worse.

> **Needs further thought:** this model rests on the assumption that our orders are
> small enough relative to market depth that they would not have influenced price
> dynamics had they been in the real book. Under that assumption, filling at limit
> price when a trade crosses it is correct. The assumption breaks down when order
> size is large relative to typical volume at that level — in that case the order
> itself would have changed the book, and the crossing trade may not have reached
> our price at all, or may have only partially filled. Revisit together with
> partial-fill modelling: both problems reduce to the same question of order size
> relative to market depth at the level.

### Fill quantity (v1 simplification)

**Full fills only**: `fillQty = leavesQty`. The entire remaining quantity fills in
one execution. The fill decision point is cleanly isolated to `fills/engine.ts` so
it can be upgraded without touching the rest of the pipeline.

The eventual model is:
- **Full fill** when the trade price moved past the order's level (e.g. the trade
  that crossed us was at a price more aggressive than our limit) — the level was
  fully consumed.
- **Partial fill** when the trade size at our level is smaller than our order. Even
  then, fill size ≤ trade size because other orders at the same level compete for
  the same volume. A reasonable heuristic can use the L2 depth at the level
  (subscribed via `orderBookL2`) to estimate our share proportionally.

Upgrading to partial fills requires: subscribing to `orderBookL2`, maintaining a
per-symbol depth cache in `fills/`, and replacing the `fillQty` calculation in
`fills/engine.ts` with the size-at-price logic. The rest of `executeFill`,
`positions`, `margin`, and `publisher` are quantity-agnostic and need no changes.

### Market orders

Market orders bypass the fill loop. When a bot creates a `Market` order, teller
fills it synchronously within the create-order handler using the last known trade
price for the symbol (cached from the most recent `trade.insert` message). If no
trade price is cached yet, teller returns `400 No market price available`.

### executeFill sequence

For each fill:

1. Compute `fillPx`, `fillQty`, `newCumQty`, `newLeavesQty`, `newAvgPx`.
2. Update order in-memory store (status → `Filled` or `PartiallyFilled`); evict from
   store if `Filled`.
3. Update position in-memory store via `positions.applyFill`.
4. Update margin in-memory store via `margin.applyFill`.
5. Write updated order, new execution record, updated position, and updated margin to
   MongoDB (awaited — WS events only fire after this succeeds).
6. **[liquidation check]** — after updating margin, check whether `marginBalance`
   has dropped below the maintenance margin threshold for any open position.
   In v1 this is a no-op stub; the hook is here so the check can be filled in
   without restructuring the pipeline. When implemented: generate a forced-cancel
   of all open orders, generate a liquidation execution, close the position at the
   bankruptcy price, and publish the relevant WS events.
7. Publish WS events via `publisher`:
   - `execution.insert` — the execution record
   - `order.update` — the updated order
   - `position.update` — updated position snapshot
   - `margin.update` — updated margin snapshot

All steps are awaited in sequence per fill. Fills across accounts for the same
trade batch are processed concurrently (one `Promise.all` per batch).

### Why liquidation matters

Liquidation is the primary negative training signal. Without it a bot can lever up
indefinitely and never face a margin call — making almost any strategy appear
profitable. Liquidation forces the bot to manage leverage, choose sensible stop
levels, and balance risk against expected return. It is what makes finding a good
strategy hard and valuable.

### Instrument messages

Teller binds `instrument.partial` and `instrument.update` to maintain a local cache
of `markPrice` and contract metadata (multiplier, `initMarginReq`, `maintMarginReq`,
`tickSize`, `lotSize`) per symbol. `markPrice` is the value BitMEX publishes directly
on the instrument stream — it is the authoritative mark price for PnL and liquidation
calculations. Teller reads it from here; no index reconstruction or compositeIndex
subscription is needed.

On every `markPrice` update, teller runs a lightweight liquidation check across all
open positions for that symbol (see Liquidation below).

### Summary: what teller subscribes to

| Routing key pattern | Purpose |
|---------------------|---------|
| `trade.insert` | Fill detection — guard check + crossing scan; last-trade-price cache for market orders |
| `instrument.partial` | Seed mark price and contract metadata cache on startup |
| `instrument.update` | Keep mark price and metadata current; trigger liquidation check |

`quote` and `orderBookL2` are candidates for future partial-fill size estimation
(see Fill quantity above) but are not consumed in v1.

---

## Position tracking

### One-way vs hedge mode

BitMEX's swagger reveals that the Position schema has three required key fields:
`account`, `symbol`, and `strategy`. The `strategy` field is what distinguishes
positions in **hedge mode** — the same account and symbol can hold a separate long
and short simultaneously, each under a different `strategy` value. In one-way mode
`strategy` is an empty string.

`positionMode` on the Account schema is the account-level switch between the two
modes.

**v1 supports one-way mode only** (`strategy: ''` on all positions). However, the
unique index on the `position` collection is `{accountId, symbol, strategy}` from
the start so that hedge mode can be added later without a schema migration. The
`strategy` field is included in every position document even if it is always `''`
in v1.

### Cross-margin vs isolated margin

The Position schema has a `crossMargin: boolean` field — margin mode is **per
position**, not per account. In cross-margin mode all positions share the full wallet
balance for margining; in isolated margin mode each position has its own dedicated
margin, losses capped at that allocation.

**v1 supports cross-margin only** (`crossMargin: true` on all positions). Isolated
margin would require tracking `posMargin` (the dedicated allocation) per position
and adjusting the `availableMargin` calculation in the `margin` module accordingly.
This is noted as a future addition.

### Collection

The `position` collection stores one document per `{accountId, symbol, strategy}`.

| Field | Type | Notes |
|-------|------|-------|
| `accountId` | string | api-key |
| `symbol` | string | |
| `currentQty` | number | Net contracts (positive = long, negative = short) |
| `avgEntryPx` | number | Volume-weighted entry price |
| `realisedPnl` | number | Cumulative realised PnL in XBT satoshis |
| `unrealisedPnl` | number | Computed from currentQty, avgEntryPx, markPrice |
| `markPrice` | number | Last seen mark price from instrument stream |
| `liquidationPrice` | number | Estimated; not enforced in v1 |
| `timestamp` | ISO-8601 | Last update time |

### `applyFill(position, fill, instrument)`

If no position document exists, creates one with `currentQty = 0`.

**Long-side accounting (inverse perpetual, e.g. XBTUSD):**

- Buy fill: `currentQty += qty`. `avgEntryPx` is updated as a quantity-weighted mean.
- Sell fill that reduces a long:
  - `realisedPnl += qty × (1/avgEntryPx - 1/fillPx) × multiplier`
  - `currentQty -= qty`. If `currentQty` goes negative, the position flipped sides;
    `avgEntryPx` resets to `fillPx` for the new short portion.
- Sell fill that increases a short: analogous to buy increasing a long.

For non-inverse symbols (if ever added), PnL is `qty × (fillPx - avgEntryPx) × multiplier`.

The symbol multiplier is read from the instrument cache maintained by `fills/`.

---

## Margin and wallet accounting

The `margin` collection stores one document per account (one currency — XBT).

| Field | Type | Notes |
|-------|------|-------|
| `accountId` | string | api-key |
| `currency` | string | `XBt` (satoshis) |
| `walletBalance` | number | Starting balance ± realised PnL, in satoshis |
| `realisedPnl` | number | Sum of realised PnL this session |
| `unrealisedPnl` | number | Sum of unrealised PnL across all open positions |
| `marginBalance` | number | `walletBalance + unrealisedPnl` |
| `availableMargin` | number | `marginBalance - initialisedMargin` (for open orders) |
| `initMargin` | number | Sum of initial margin held for open orders |
| `timestamp` | ISO-8601 | Last update time |

### Initial margin on order create

On order create: debit initial margin from `availableMargin`. For Limit orders the
margin is estimated as `orderQty × price × initialMarginReq` where `initialMarginReq`
is read from the instrument cache. On cancel: credit the margin back.

### `applyFill`

Credits `realisedPnl` from the position calculation to `walletBalance`. Recomputes
`marginBalance` and `availableMargin`. Releases the initial margin held for the
filled portion.

### Mark price updates

When an `instrument.update` arrives with a new `markPrice`, teller recomputes
`unrealisedPnl` for every open position for that symbol and publishes `margin.update`
events. This is the only path that changes `marginBalance` without a fill.

---

## Liquidation

Liquidation is the most critical negative training signal: it forces bots to manage
leverage and risk, and is the primary reason finding a good strategy is hard. Without
it, any levered strategy looks profitable in hindsight.

### Two-phase model

Liquidation is split into two separate, cheap operations:

**Phase 1 — recompute `liquidationPrice`** (triggered by sparse events only):

Liquidation price changes when the position changes (fill) or when margin changes
(order create / amend / cancel / fill / deposit / withdrawal). Teller recomputes
`liquidationPrice` and `bankruptcyPrice` after each of these events and stores the
updated values in the `position` document. This is the expensive phase but runs rarely.

**Phase 2 — mark price crossing check** (triggered by every instrument update):

On each `markPrice` update, teller fetches all open `position` documents for the
symbol and compares `markPrice` against each `liquidationPrice`. This is a single
MongoDB read and a numeric comparison per account — very cheap regardless of how
frequently the mark price updates.

If the crossing condition is met for a position, teller fires the liquidation
sequence: cancel all open orders for the account, close the position at the
bankruptcy price, credit/debit the insurance fund, and publish the relevant WS events
(`order.update`, `execution.insert` with `execType: 'Liquidation'`, `position.update`,
`margin.update`).

### Precise formulas required

**The liquidation and bankruptcy price formulas must be taken verbatim from the
official BitMEX API documentation.** They vary by contract type (inverse perpetual,
quanto, linear), margin mode (isolated vs cross), and leverage settings. Implementing
approximations would produce systematically wrong liquidation signals, which
invalidates training.

Reference: `https://www.bitmex.com/app/liquidation` and the BitMEX API docs for
margin calculations. Cross-reference with real position data from the Bouncer accounts
shown in dev tools to validate the formulas before shipping.

### v1 stub

In v1, both phases are present in code but the liquidation sequence is a no-op.
`liquidationPrice` and `bankruptcyPrice` in the `position` document are `null` until
the formulas are implemented. The mark price crossing check in `fills/execute.ts`
calls `checkLiquidation(position, markPrice)` which returns immediately. When
liquidation is implemented, only that function changes — the two-phase architecture
and the call sites are already in place.

---

## WS publishing

Teller publishes to the **`topic:replay`** exchange (the same exchange digger uses).
The existing `replay-pipe` in the module compose already binds this exchange to
`ws.deltas@topic:deltas`, so teller's events reach the `ws` service with no wiring
change.

### Message format

```
Exchange:    topic:replay
Routing key: {table}.{action}    e.g. "order.update", "execution.insert"
Body:        JSON — { table, action, data: [...] }
```

### Headers

| Header | Value |
|--------|-------|
| `x-account-id` | api-key of the affected account |
| `x-worker-uuid` | teller instance UUID (static per process) |
| `x-message-count` | incrementing counter (separate counter per account) |
| `x-bitmex-published-at` | ISO-8601 replay-clock timestamp of the event that triggered this message (e.g. the trade's own timestamp) |

Using the triggering event's replay timestamp keeps all messages in the stream on a
single consistent clock. Using wall time would mix two clocks — some messages
timestamped in historical replay time, others in real processing time — making the
stream incoherent for any consumer that reasons about event order or timing.

The `x-account-id` header is what the `ws` service uses to route private messages to
the correct authenticated client. Without it, the message would be treated as public.

### Tables published

| Table | Actions | Trigger |
|-------|---------|---------|
| `order` | `partial`, `insert`, `update` | REST order create/amend/cancel; fill |
| `execution` | `partial`, `insert` | Fill or cancel |
| `position` | `partial`, `update` | Fill or mark price change |
| `margin` | `partial`, `update` | Fill, order create/cancel, mark price change, deposit/withdrawal |

`partial` messages are published once per table when a bot subscribes (the `ws`
service calls `POST /subscribed/:accountId/:table` on teller — see REST API). This
gives the bot its initial snapshot the same way digger gives a partial on public
subscribe.

---

## REST API

HTTP server on port 80 (configurable via `TELLER_PORT`).

Account is identified from the `api-key` request header. No `api-signature`
validation is performed — teller trusts that `rest` has already authenticated the
request (or that only internal services reach teller). If `api-key` is missing,
teller returns `401`.

### Private bot-facing endpoints (proxied by `rest`)

```
GET    /api/v1/order            list orders for account
POST   /api/v1/order            create an order
PUT    /api/v1/order            amend an order
DELETE /api/v1/order            cancel one or more orders (orderID or clOrdID)
DELETE /api/v1/order/all        cancel all open orders for account/symbol

GET    /api/v1/position         list positions for account
GET    /api/v1/user/margin      account margin summary
GET    /api/v1/user/wallet      wallet balance
GET    /api/v1/execution        execution history

POST   /api/v1/user/deposit     simulated deposit or withdrawal (teller-only, not on BitMEX)
```

Query parameters on `GET /api/v1/order`: `symbol`, `filter` (JSON), `count`, `start`,
`reverse` — same as BitMEX.

Response shapes are verbatim BitMEX shapes for each table. Teller never invents
fields; it omits fields it does not track (e.g. `commission` is omitted in v1).

### `POST /api/v1/user/deposit`

Simulates a deposit or withdrawal. Not a real BitMEX endpoint — exists only in
teller to let orchestrators and bots configure the account balance before placing
orders.

**Request body:**
```json
{ "amount": 100000000 }
```

`amount` is in satoshis (XBt). Positive = deposit, negative = withdrawal. A
withdrawal that would take `walletBalance` below zero is rejected with `400` — you
cannot withdraw margin that doesn't exist, even in a simulated account.

**Effects (in order):**

1. Update `walletBalance` in memory and MongoDB.
2. Recompute `marginBalance`, `availableMargin` from the new balance.
3. Recompute `liquidationPrice` and `bankruptcyPrice` for every open position —
   a larger balance pushes liquidation further away; a smaller balance brings it
   closer. This is a required step, not optional.
4. Write updated `margin` and all affected `position` documents to MongoDB.
5. Publish `margin.update` and `position.update` WS events for each changed position.

**Response:** the updated `margin` document (same shape as `GET /api/v1/user/margin`).

### Internal control endpoints (not proxied by `rest`)

```
POST /subscribed/:accountId/:table    called by ws when a bot subscribes to a private table
POST /reset/:accountId                wipe all state for account (wallet, orders, positions)
GET  /health                          service-kit health check
```

`POST /subscribed/:accountId/:table` causes teller to immediately publish a `partial`
for that table to `topic:replay` for the given account. The `ws` service calls this
instead of its normal "resubscribe" path (which goes to broadcast/digger for public
tables). Teller returns `201` on success, `400` for unknown tables.

---

## Integration with `rest` service

The `rest` service is extended with a second env var: `REST_PRIVATE_URL`. When set,
a second proxy middleware runs before the public proxy and catches a fixed set of
private path prefixes:

```
/api/v1/order
/api/v1/position
/api/v1/execution
/api/v1/user/margin
/api/v1/user/wallet
/api/v1/user/deposit
```

Requests to these paths are forwarded to `REST_PRIVATE_URL` (teller) with all
headers passed through verbatim. The `api-key` and `api-signature` headers travel
with the request so teller can identify the account. Requests to all other paths
fall through to `REST_DATA_URL` (digger) as before.

No authentication validation occurs in `rest` — it is a passthrough in the replay
module (there is no Bouncer in replay).

The `ws` service gains one new env var: `WS_PRIVATE_URL`. When a bot subscribes to
a private table, the ws service calls `POST {WS_PRIVATE_URL}/subscribed/:accountId/:table`
instead of the normal resubscribe path. If `WS_PRIVATE_URL` is unset, private
subscriptions are rejected with `Unknown table`.

---

## MongoDB collections

Teller uses its own database (`TELLER_DATABASE`, default `teller`). This keeps
teller's account state isolated from the market data in the main platform database
and makes a full account wipe (`DROP DATABASE teller`) safe and surgical.

Indexes are created by `db/bootstrap.ts` on every startup (`createIndex` with
`{ background: false }` — blocking on first run, instant no-op on subsequent runs
when indexes already exist).

### `order`

```javascript
{
  _id:        ObjectId,
  orderID:    string,         // UUID
  clOrdID:    string,
  accountId:  string,         // api-key
  symbol:     string,
  side:       'Buy' | 'Sell',
  ordType:    'Limit' | 'Market',
  price:      number | null,
  orderQty:   number,
  leavesQty:  number,
  cumQty:     number,
  avgPx:      number | null,
  ordStatus:  string,
  timestamp:  string,         // ISO-8601
  text:       string,
}
```

Indexes:
- `{ accountId: 1, clOrdID: 1 }` — unique
- `{ accountId: 1, symbol: 1, ordStatus: 1 }` — fill scan

### `execution`

```javascript
{
  _id:             ObjectId,
  execID:          string,         // UUID
  orderID:         string,
  clOrdID:         string,
  accountId:       string,
  symbol:          string,
  side:            'Buy' | 'Sell',
  price:           number,
  lastQty:         number,
  lastPx:          number,
  cumQty:          number,
  leavesQty:       number,
  ordStatus:       string,
  execType:        'New' | 'Trade' | 'Canceled' | 'Liquidation',
  timestamp:       string,         // replay clock — when this happened in historical time
  wallTimestamp:   string,         // wall clock — when teller processed it during replay
}
```

Both timestamps are stored: `timestamp` aligns the execution with other replay data
(e.g. the trade that triggered it); `wallTimestamp` records real processing time for
auditing and performance analysis.

Index: `{ accountId: 1, timestamp: -1 }` — history queries.

### `position`

```javascript
{
  _id:                ObjectId,
  accountId:          string,
  symbol:             string,
  strategy:           string,      // '' in one-way mode; identifies leg in hedge mode
  crossMargin:        boolean,     // true in v1 (cross-margin only)
  currentQty:         number,
  avgEntryPx:         number | null,
  realisedPnl:        number,     // satoshis
  unrealisedPnl:      number,     // satoshis; recomputed on mark price change
  markPrice:          number | null,
  liquidationPrice:   number | null,   // estimated; used by liquidation check
  bankruptcyPrice:    number | null,   // price at which margin is fully exhausted
  timestamp:          string,
}
```

Index: `{ accountId: 1, symbol: 1, strategy: 1 }` — unique. The `strategy` field is
always `''` in v1 (one-way mode) but is part of the key from the start so hedge mode
can be added without a schema migration.

### `margin`

```javascript
{
  _id:             ObjectId,
  accountId:       string,
  currency:        'XBt',
  walletBalance:   number,      // satoshis
  realisedPnl:     number,
  unrealisedPnl:   number,
  marginBalance:   number,
  availableMargin: number,
  initMargin:      number,
  maintMargin:     number,      // maintenance margin; liquidation triggers when marginBalance < maintMargin
  timestamp:       string,
}
```

Index: `{ accountId: 1 }` — unique.

---

## Configuration

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DIGGER_URL` | yes | — | Digger commands API base URL — teller calls `/subscribe/*` on startup |
| `TELLER_DATABASE` | no | `teller` | MongoDB database name for teller state |
| `TELLER_INITIAL_BALANCE` | no | `XBt:100000000` | Starting balance for new accounts — format `currency:amount` where amount is in the currency's base unit. Only `XBt` (satoshis) is supported in v1. Default is 1 XBT (100 000 000 satoshis). |
| `TELLER_PORT` | no | `80` | HTTP server port inside the container |
| `TELLER_EXCHANGE` | no | `replay` | RabbitMQ topic exchange to publish to |

Standard platform env vars (`QUEUE_URL`, `DB_URL`) are inherited from service-kit
via `SKFactory`.

---

## Limits and known simplifications (v1)

**Full fills only.** A single trade, regardless of size, fills the entire resting
order quantity. This will overstate fills in thin markets but is correct in direction.
Partial fills require tracking size-at-price, which is a future improvement.

**Limit and Market orders only.** Stop, StopLimit, and other conditional order types
are not supported. Teller returns `400` for unsupported `ordType`.

**Liquidation stub (v1).** The two-phase architecture is in place (`checkLiquidation`
called from both `executeFill` and the mark-price handler) but executes as a no-op.
`liquidationPrice` and `bankruptcyPrice` in the `position` document are `null` until
the formulas are implemented from the official BitMEX docs. Until then, a bot can go
negative wallet balance without forced position closure. See the Liquidation section
for the implementation path.

**Mark-price PnL only.** `unrealisedPnl` uses the mark price from the instrument
stream. If no instrument subscription is active, `unrealisedPnl` stays at zero.
A strategy that needs accurate unrealised PnL should subscribe `instrument` in its
`dependencies`.

**No isolated margin.** All positions use cross-margin (`crossMargin: true`), sharing
the full wallet balance. Per-position isolated margin allocation is not implemented.

**Single currency (XBt).** All accounting is in Bitcoin satoshis. Multi-currency
support (e.g. USDT margined contracts) is not in scope for v1.

**No signature validation.** Teller trusts the `api-key` header at face value. It
is an internal service, not exposed on a public port. Placing it behind `rest`
provides the only access control layer in replay mode.

**Sweep fill ordering.** When a trade batch crosses multiple accounts' orders, fills
are processed concurrently. The order in which accounts receive fills within a single
batch is non-deterministic. This is acceptable for isolated account training.
