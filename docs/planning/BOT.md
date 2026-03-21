# Bot Service

The bot framework consumes market state and account state, runs a pluggable strategy, and publishes desired order state. It knows what orders it wants — not how to create them.

---

## Responsibility Split

The bot handles:
- Consuming `MarketState` from RabbitMQ
- Maintaining account state from private WS streams
- Running the hybrid trigger loop
- Calling the strategy
- Sanity-checking the output
- Publishing `DesiredState`

The bot does **not** handle:
- Order creation, amendment, cancellation — that's the executor
- WS order streams — that's the executor
- REST order API — that's the executor
- Market data accumulation — that's the signal service

---

## Inputs

### RabbitMQ — `signal.{symbol}`
Consumes `MarketState` from the signal service, one queue per symbol.

### Private WS streams (`WS_URL` env var)
Connects to our ws service for account state:

| Table | Purpose |
|---|---|
| `position` | Per-symbol position (currentQty, avgEntryPrice, unrealisedPnl, liquidationPrice) |
| `margin` | Account margin (walletBalance, availableMargin, marginBalance) |
| `execution` | Fill events (for bookkeeping / logging) |

Delta accumulation maintains live account state in memory.

---

## Account State

```
AccountState {
  positions: Record<symbol, {
    currentQty:       number
    avgEntryPrice:    number
    unrealisedPnl:    number
    liquidationPrice: number
  }>
  margin: {
    walletBalance:    number
    availableMargin:  number
    marginBalance:    number
  }
}
```

Position data covers all symbols simultaneously — needed for cross-margin awareness across a multi-symbol strategy.

---

## Hybrid Trigger Loop

The bot does not tick on every incoming market update. Instead:

1. `MarketState` messages are buffered as they arrive
2. A minimum interval timer fires (e.g. every 5 seconds)
3. On tick: take the latest buffered state for each symbol, call the strategy, publish `DesiredState`

This decouples the bot's decision rate from signal emission rate, and avoids thrashing the executor with high-frequency order updates.

---

## Strategy Interface

```typescript
interface Strategy {
  name: string
  decide(
    market:  MarketState[],       // latest state for all configured symbols
    account: AccountState,
    config:  StrategyConfig,
  ): DesiredState[]               // one DesiredState per symbol
}
```

Strategies are pluggable — swap a strategy without changing the framework. Config (levels, spacing, size, limits) is passed in and sourced from env vars.

---

## Initial Strategy: Market Maker

Places N limit orders on each side of the mid price, symmetrically spaced.

**Logic:**
1. Compute mid from `MarketState.mid`
2. Place N bid orders below mid: `mid - spacing * i` for i in [1..N]
3. Place N ask orders above mid: `mid + spacing * i` for i in [1..N]
4. Respect position limits: suppress new buys if `currentQty >= MAX_POSITION`, suppress new sells if `currentQty <= -MAX_POSITION`
5. Orders use `execInst: ParticipateDoNotInitiate` (post-only)

**Config:**
- `N` — number of levels per side
- `SPACING` — price distance between levels (in ticks)
- `ORDER_SIZE` — quantity per order
- `MAX_POSITION` — absolute position limit per symbol

---

## Sanity Checks

Before publishing `DesiredState`, the bot verifies:
- Market is open (instrument state is not `Settled` or `Closed`)
- Order book is healthy (bid < ask, spread within bounds)
- Position limits are not exceeded
- Available margin is sufficient

If a check fails, the bot publishes an empty `DesiredState` (zero orders), causing the executor to cancel all open orders.

---

## Outputs

### RabbitMQ — `desired.{symbol}`
Publishes `DesiredState` per symbol after each tick.

```
DesiredState {
  symbol:    string
  orders:    DesiredOrder[]    // sorted closest-to-mid first
  timestamp: string
}
```

---

## Configuration

| Env var | Description |
|---|---|
| `WS_URL` | Our ws service URL |
| `REST_URL` | Our rest service URL (for startup queries) |
| `API_KEY` | Exchange API key (private WS auth) |
| `API_SECRET` | Exchange API secret |
| `SYMBOLS` | Comma-separated symbols (e.g. `XBTUSD`) |
| `TICK_INTERVAL_MS` | Strategy tick interval (default: 5000) |
| `STRATEGY` | Strategy name to load (e.g. `market-maker`) |
| `INPUT_QUEUE_PREFIX` | MarketState input queue prefix (default: `signal`) |
| `OUTPUT_QUEUE_PREFIX` | DesiredState output queue prefix (default: `desired`) |
| `RABBITMQ_URL` | RabbitMQ connection URL |
| Strategy-specific vars | N, SPACING, ORDER_SIZE, MAX_POSITION, etc. |

---

## Testing Approach (M3)

Connect to a live or replayed signal queue. A stub subscriber logs `DesiredState` output. Verify:
- Framework consumes market state and accumulates account state
- Strategy produces well-formed desired orders
- Sanity checks trigger correctly on bad market state
- Empty `DesiredState` is published when checks fail
