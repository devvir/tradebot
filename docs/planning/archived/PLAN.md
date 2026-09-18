# Bot App — Architecture Overview

The bot app is a trading layer built on top of the exchange app. Three services work together to go from raw market data to live orders on the exchange.

Services connect exclusively to our own `ws` and `rest` services — never directly to BitMEX or any other exchange. Whether those services are backed by testnet, mainnet, or replay is a module configuration concern, not a bot concern.

---

## Services

### `signal` — Market data processor
Subscribes to public WS streams, accumulates order book and trade state, and publishes `MarketState` messages to RabbitMQ at a configurable minimum interval.

→ [SIGNALS.md](SIGNALS.md)

### `executor` — Order abstraction layer
The bot's interface to order management. The bot publishes a list of desired orders; the executor computes the diff against live state and performs the minimum set of REST calls (amend, create, cancel) to make reality match intent. All WS private streams, REST API details, and order CRUD complexity live here — the bot knows none of it.

→ [EXECUTOR.md](EXECUTOR.md)

### `bot` — Strategy framework
Consumes `MarketState` from RabbitMQ and account state from private WS streams, runs a pluggable strategy, and publishes `DesiredState` to RabbitMQ. The bot knows what orders it wants, not how to create them.

→ [BOT.md](BOT.md)

---

## Message Interfaces

```
MarketState {
  symbol:     string
  timestamp:  string
  bid:        number
  ask:        number
  mid:        number
  spread:     number
  book:       { bids: [price, size][], asks: [price, size][] }   // top N levels
  lastPrice:  number
  ema:        Record<string, number>    // keyed by window, e.g. { "20": 49500 }
  instrument: { tickSize, lotSize, multiplier, fundingRate, ... }
}

AccountState {
  positions: Record<symbol, { currentQty, avgEntryPrice, unrealisedPnl, liquidationPrice }>
  margin:    { walletBalance, availableMargin, marginBalance }
}

DesiredState {
  symbol:    string
  orders:    DesiredOrder[]            // sorted closest-to-mid first
  timestamp: string
}

DesiredOrder {
  side:        'Buy' | 'Sell'
  orderQty:    number
  price:       number
  ordType:     'Limit'
  timeInForce: 'GoodTillCancel'
  execInst?:   'ParticipateDoNotInitiate'   // post-only
}
```

---

## Data Flow

```
Our ws service + rest service
        │
        ├─[public WS]──────→ signal ──[MarketState]──→ bot
        │
        ├─[private WS]─────────────────────────────→ bot  (position, margin)
        │
        └─[private WS + REST]──────────────────────→ executor  (orders, execution, REST)
                ↑
                └──────────────────────────────────── bot  [DesiredState]
```

RabbitMQ queues (names configured via env vars):
- `signal.{symbol}` — MarketState: signal → bot
- `desired.{symbol}` — DesiredState: bot → executor

---

## Module

The first deployable module is `modules/bot/testnet/`:
- Spins up: signal + bot + executor + rabbitmq + ws + rest services
- `WS_URL` → our ws service, `REST_URL` → our rest service
- ws and rest services configured to back against BitMEX testnet

---

## Design Principles

**Services are input-boundary agnostic.** A service is done when it behaves correctly given valid input at its boundary. It does not need to know or care what produces that input.

**No bidirectional dependency.** The executor does not publish anything back to the bot. Information flows one way: market data in, desired state out, orders executed.

**Multi-symbol.** All three services handle N configured symbols simultaneously. Position data covers all symbols (needed for cross-margin awareness).

**Pluggable strategy.** The bot framework is separate from any particular strategy. Swapping strategies requires no changes to the framework.
