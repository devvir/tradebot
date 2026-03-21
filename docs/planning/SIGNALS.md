# Signal Service

Subscribes to public WS streams, accumulates market state, and publishes `MarketState` messages to RabbitMQ at a configurable minimum interval. One instance handles N configured symbols.

---

## Inputs

### WS public streams (`WS_URL` env var)

Connects to our ws service. Subscribes per configured symbol:

| Table | Purpose |
|---|---|
| `orderBookL2` | Level-2 order book (bid/ask by price level) |
| `trade` | Recent trades (price, size, side, timestamp) |
| `instrument` | Instrument metadata (tickSize, lotSize, multiplier, fundingRate, markPrice, etc.) |
| `quote` | Best bid/ask quotes |
| `funding` | Funding rate and next funding time |

Delta accumulation follows the BitMEX pattern: `partial` initializes state, then `insert`/`update`/`delete` messages are applied using key indexing. Same pattern as the snapshots service.

Reference: `/data/Development/Repos/NM/BitMEX/api-connectors/official-ws/nodejs` — `deltaParser.js` implements the accumulation logic.

---

## Outputs

### RabbitMQ — `signal.{symbol}`

Publishes `MarketState` per symbol after each meaningful update, subject to a minimum emission interval (configurable, e.g. 100ms) to avoid flooding downstream.

```
MarketState {
  symbol:     string
  timestamp:  string

  // Best quotes
  bid:        number
  ask:        number
  mid:        number        // (bid + ask) / 2
  spread:     number        // ask - bid

  // Order book snapshot
  book: {
    bids: [price, size][]   // top N levels, descending price
    asks: [price, size][]   // top N levels, ascending price
  }

  // Last trade
  lastPrice:  number

  // Indicators
  ema: Record<string, number>   // keyed by window size, e.g. { "20": 49500.5 }

  // Instrument metadata (from instrument table)
  instrument: {
    tickSize:    number
    lotSize:     number
    multiplier:  number
    fundingRate: number
    markPrice:   number
    // ... other fields as needed
  }
}
```

---

## Indicators

**EMA of last price** — computed on each trade update, configurable window(s).

The indicator framework is designed to be extended. EMA is the PoC. Additional indicators (order book imbalance, VWAP, momentum) are future work.

---

## Emit Rate

A configurable minimum interval (e.g. 100ms) gates publication. If multiple updates arrive within the window, only the latest state is published when the window expires. This prevents downstream flooding while keeping latency low.

---

## Configuration

| Env var | Description |
|---|---|
| `WS_URL` | Our ws service URL |
| `SYMBOLS` | Comma-separated list of symbols (e.g. `XBTUSD,ETHUSD`) |
| `BOOK_DEPTH` | Number of order book levels to include (default: 10) |
| `EMIT_INTERVAL_MS` | Minimum ms between MarketState publications (default: 100) |
| `EMA_WINDOWS` | Comma-separated EMA window sizes (e.g. `20,50`) |
| `OUTPUT_QUEUE_PREFIX` | Queue name prefix for MarketState output (default: `signal`) |
| `RABBITMQ_URL` | RabbitMQ connection URL |

---

## Testing Approach (M2)

Connect to our ws service (backed by testnet or replay). A stub subscriber script logs incoming `MarketState` messages. Verify:
- Order book state is correct after a sequence of deltas
- EMA values are sensible and update on each trade
- Emission rate is respected (no burst)
