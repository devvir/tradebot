# Signal Service — Technical Documentation

## Purpose

Signal is a pure computation service. It consumes raw market data from the BitMEX WebSocket and produces technical indicators — moving averages, oscillators, volatility bands, order book metrics, and so on. It has no opinion about the market; it answers "what is EMA(20, 1h) for XBTUSD right now?" and nothing more. Interpretation belongs to downstream services.

Signal is lazy: it only computes what something is actively listening for. If no consumer has subscribed to `XBTUSD.rsi.1m.14`, no RSI is computed for XBTUSD.

---

## Data Sources

Signal talks directly to the real BitMEX API. No internal services are involved for now.

| Source | Config var | Used for |
|---|---|---|
| WebSocket | `WS_URL` | Continuous streaming — all market data after initialisation |
| REST | `REST_URL` | Historical bin backfill — one shot per `(symbol, bin_size)` at activation |

Signal needs no authenticated data. Every table it reads is public. No API key required.

Both URLs are environment variables. When the internal `ws`/`rest` services reach parity, only config changes — Signal code is unaffected.

---

## WebSocket Subscriptions

Subscriptions are managed per-symbol and opened lazily when the first indicator needing them is activated.

All channels are subscribed at startup without symbol filter — BitMEX broadcasts all symbols on each channel. No dynamic subscribe/unsubscribe.

| Channel | Stream buffer |
|---|---|
| `tradeBin1m` | `deque(maxlen=3)` per symbol |
| `tradeBin1h` | `deque(maxlen=3)` per symbol |
| `tradeBin1d` | `deque(maxlen=3)` per symbol |
| `trade` | `deque(maxlen=1000)` per symbol |
| `quote` | current snapshot per symbol |
| `instrument` | current snapshot per symbol |
| `orderBookL2_25` | delta-accumulated snapshot per symbol (top 25 levels per side) |

The stream buffers exist solely to cover the REST backfill overlap window on initialisation. They are always flowing, independent of what indicators are active.

---

## Storage Model

Signal does not buffer raw trade or quote ticks. Completed bars capture all the information indicators need. Four bin levels cover all supported timeframes and approximation of the current incomplete bar.

### Bin buffers — completed bars

Four levels, configured as a single const array. Adding a new level requires one entry:

| Buffer | Max depth | Purpose |
|---|---|---|
| 1m bins per symbol | 59 | Sub-hour indicator history; approximation of current 1h bar |
| 1h bins per symbol | 23 | Sub-day indicator history; approximation of current 1d bar |
| 1d bins per symbol | 30 | Sub-month indicator history; approximation of current 1M bar |
| 1M bins per symbol | 200 | Monthly indicator history (assembled from 1d bins — see below) |

`1M` bins are synthetic: the buffer assembles them by grouping every 30 completed `1d` bins into one `1M` bin. Indicators request `1M` bins without knowing they did not come from BitMEX directly.

Buffer depth is managed by reference counting (see Buffer Management below), not fixed high-water marks. The maximums above define the largest window any indicator of that level can request.

### Buffer Management

Each bin item in a buffer carries a `refs` counter — the number of active indicator instances that still need it.

- **Indicator activates**: `refs += 1` on all existing items in each bin level the indicator requires.
- **Indicator deactivates**: `refs -= 1` on all items not yet pruned by that instance.
- **After each `compute()` call**: the indicator returns how many oldest items it no longer needs, per buffer. The registry decrements `refs` on those items. Items reaching `refs == 0` are dropped from the front of the deque.
- Each buffer's prune history is independent — a 1m buffer shared between EMA(20) and EMA(200) will prune at different rates for each.

### Current open bar — per symbol

A single running accumulator `(open, high, low, close, volume, cum_pv)`, updated by incoming `trade` ticks. Reset when a `tradeBin1m` close event arrives. Not buffered — only the current incomplete bar is kept.

### Order book — per symbol

Current snapshot only: sorted bid/ask levels, updated by `orderBookL2` deltas. No history.

### Quote and instrument snapshots — per symbol

Latest `bid`, `ask`, `lastPrice`, `markPrice`, `fundingRate`, `nextFunding`, `tickSize`, `lotSize` — updated on each `quote` and `instrument` message.

### Current incomplete bar approximation

For indicators that include the current incomplete bar in their computation:

| Target timeframe | Approximated from |
|---|---|
| `1m` | Open bar accumulator (raw `trade` ticks) |
| sub-1h (5m, 15m, …) | 1m bin buffer (up to 59 completed 1m bins) + open 1m accumulator |
| `1h` | 1m bin buffer (up to 59 completed 1m bins) + open 1m accumulator |
| sub-1d (2h, 4h, …) | 1h bin buffer (up to 23 completed 1h bins) + current incomplete 1h (as above) |
| `1d` | 1h bin buffer (up to 23 completed 1h bins) + current incomplete 1h (as above) |
| sub-1M (1w, …) | 1d bin buffer (up to 30 completed 1d bins) + current incomplete 1d (as above) |

---

## Initialisation

When a `(symbol, bin_size)` pair is first activated:

1. Subscribe to the relevant `tradeBin*` WS channel. Begin buffering incoming bins.
2. Fetch completed bins from REST: `GET /trade/bucketed?binSize={bs}&symbol={sym}&reverse=true&count={N}`, where `N` satisfies the largest active window for that pair.
3. When the response arrives, discard any buffered WS bins with timestamp ≤ the last bin timestamp in the REST response — those are already covered.
4. Merge: REST bins prepended to remaining WS buffer. Processing begins.

For OBImbalance and Market: the `orderBookL2_25` WS partial on subscription provides the initial order book snapshot. No REST call needed. Quote and instrument snapshots populate from the first incoming WS messages.

### Why Not Rely on WS Partials

Insert-only tables (`tradeBin*`, `trade`, `quote`) yield empty partials on subscription — no initial snapshot. Reconnecting to force a fresh partial does not help these tables and creates unnecessary reconnect pressure at scale.

### WS Reconnect

On disconnect, all active `(symbol, bin_size)` pairs re-initialise using the same REST backfill + WS merge process. Reconnection uses exponential backoff (start 1 s, double each attempt, cap 30 s).

### Replay Compatibility

No wall-clock time is used in REST calls. A replay service controlling exchange time will respond with historically appropriate data automatically — no code changes required.

---

## Time Rule

**All time-based decisions use data timestamps, never the wall clock.**

Buffer pruning, window boundaries, bar close detection, indicator compute throttling — everything uses exchange timestamps from WS/REST messages. Replay at any speed produces identical output.

---

## Routing Key Language

Consumers subscribe by binding a non-durable auto-delete queue to the `signal` RabbitMQ topic exchange:

```
{SYMBOL}.{indicator}[.{arg1}[.{arg2}...]]
```

For **candle-based indicators**, the first argument is always the **timeframe**. Any timeframe expressible as a whole multiple of a buffer bin level is supported — constructed by grouping and aggregating the appropriate base bins:

| Constructed timeframe | Built from | Examples |
|---|---|---|
| `5m`, `3m`, `15m`, `30m`, `45m`, … | `1m` bins | 5×1m, 3×1m, 15×1m |
| `2h`, `4h`, `6h`, `12h`, … | `1h` bins | 4×1h, 12×1h |
| `2d`, `3d`, `1w`, … | `1d` bins | 7×1d |
| `2M`, `3M`, … | `1M` bins | 3×1M |

Native buffer levels (`1m`, `1h`, `1d`, `1M`) are used directly. For constructed timeframes, the largest buffer level that divides the requested period evenly is used as the base — e.g. `15m` uses `1m` bins (15×1m), `4h` uses `1h` bins (4×1h). Each constructed bar aggregates as: open = first.open, high = max(highs), low = min(lows), close = last.close, vwap = Σ(bin.vwap × bin.volume) / Σ(volume).

Timeframes that are not whole multiples of any buffer level are rejected at binding time with a logged error.

### Examples

| Routing key | Meaning |
|---|---|
| `XBTUSD.market` | Market snapshot — bid/ask/book/last trade/instrument, throttled to 500 ms of data-time |
| `XBTUSD.ema.1m.20` | EMA, 1m bars, window = 20 |
| `XBTUSD.ema.1h.200` | EMA, 1h bars, window = 200 |
| `XBTUSD.ema.4h.50` | EMA, 4h bars (constructed from 1h bins), window = 50 |
| `XBTUSD.sma.30m.20` | SMA, 30m bars (constructed from 1m bins), window = 20 |
| `XBTUSD.bollinger.1m.20` | Bollinger, 1m bars, window = 20, multiplier = 2.0 (default) |
| `XBTUSD.bollinger.1h.20.2.5` | Bollinger, 1h bars, window = 20, multiplier = 2.5 |
| `XBTUSD.rsi.15m` | RSI, 15m bars (constructed from 1m bins), period = 14 (default) |
| `XBTUSD.rsi.1d.21` | RSI, 1d bars, period = 21 |
| `XBTUSD.vwap` | VWAP over last 60 completed 1m bins (default) |
| `XBTUSD.vwap.240` | VWAP over last 240 completed 1m bins |
| `XBTUSD.obimbalance` | Order book imbalance, top 10 levels (default) |
| `XBTUSD.obimbalance.25` | Order book imbalance, top 25 levels |

### Lazy Activation

Signal subscribes to `amq.rabbitmq.event.exchange` at startup. A `queue.bound` event triggers activation: the routing key is parsed, the combination added to the active set with a reference count, and any needed WS subscriptions or REST initialisation are started. `queue.unbound`/`queue.deleted` decrements the count; at zero, the combination is deactivated and unused WS subscriptions are closed.

Consumers must use **non-durable, auto-delete queues** — process exit then cleans up bindings automatically.

---

## Indicators

Each indicator lives in its own directory under `src/signals/`. Every indicator module exposes:

- `ARGS` — positional argument spec: name, type, default or required
- `needs() → DataNeeds` — what data the indicator reads: which bin levels and how many, plus any live state (order book, quote, instrument, open bar)
- `interval_ms` — how often (in data-time ms) the indicator is computed and published; default 1000
- `compute(state, symbol) → (value, prune_counts)` — pure function, no side effects; `prune_counts` is a dict keyed by bin level (e.g. `{'1m': 5, '1h': 0}`) saying how many oldest items this instance no longer needs since the last call

### EMA — `ema.{timeframe}.{window}`

Exponential moving average of bar `close`.

| Arg | Position | Type | Default |
|---|---|---|---|
| timeframe | 1 | any supported timeframe | required |
| window | 2 | int | required |

Output: `{ "value": float }`
History: `window × 3` bars of the resolved base bin (warmup for EMA to stabilise).

### SMA — `sma.{timeframe}.{window}`

Simple moving average of bar `close`.

| Arg | Position | Type | Default |
|---|---|---|---|
| timeframe | 1 | any supported timeframe | required |
| window | 2 | int | required |

Output: `{ "value": float }`
History: `window` bars of the resolved base bin.

### Bollinger Bands — `bollinger.{timeframe}.{window}[.{multiplier}]`

Middle = SMA(window). Upper/lower = middle ± multiplier × rolling standard deviation of `close`.

| Arg | Position | Type | Default |
|---|---|---|---|
| timeframe | 1 | any supported timeframe | required |
| window | 2 | int | required |
| multiplier | 3 | float | 2.0 |

Output: `{ "mid": float, "upper": float, "lower": float, "bandwidth": float }`
History: `window` bars of the resolved base bin.

### RSI — `rsi.{timeframe}[.{period}]`

Relative Strength Index using Wilder's smoothed moving average of gains and losses.

| Arg | Position | Type | Default |
|---|---|---|---|
| timeframe | 1 | any supported timeframe | required |
| period | 2 | int | 14 |

Output: `{ "value": float }` — range 0–100.
History: `period × 2` bars of the resolved base bin (Wilder smoothing warmup).

### VWAP — `vwap[.{bars}]`

Volume-weighted average price over a rolling window of completed 1m bins:
`Σ(bin.vwap × bin.volume) / Σ(bin.volume)`. Mathematically exact — BitMEX bins carry both `vwap` and `volume` per bar.

| Arg | Position | Type | Default |
|---|---|---|---|
| bars | 1 | int | 60 |

Output: `{ "value": float, "volume": float }`
History: `bars` completed 1m bins.

### Order Book Imbalance — `obimbalance[.{levels}]`

`(bid_vol − ask_vol) / (bid_vol + ask_vol)` across the top N levels. Range −1 to +1.

| Arg | Position | Type | Default |
|---|---|---|---|
| levels | 1 | int | 10 |

Output: `{ "value": float, "bid_volume": float, "ask_volume": float }`
History: none — instantaneous from current order book snapshot.
`interval_ms`: 500.

### Market — `market`

Current market snapshot. No args. Treated as an indicator like any other — only computed and published when something is subscribed to `{SYMBOL}.market`.

Output:

```json
{
  "symbol":    "XBTUSD",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "bid":       50000,
  "ask":       50010,
  "mid":       50005,
  "spread":    10,
  "lastPrice": 50008,
  "book": {
    "bids": [[50000, 1200], [49990, 800]],
    "asks": [[50010,  900], [50020, 1100]]
  },
  "instrument": {
    "tickSize":    0.5,
    "lotSize":     1,
    "markPrice":   50003,
    "fundingRate": 0.0001,
    "nextFunding": "2026-01-01T08:00:00.000Z"
  }
}
```

History: none — instantaneous from live snapshots.
`interval_ms`: 500.

---

## Infrastructure Modules

Isolated so that lifting any of them into a standalone package requires zero changes to the code inside — only import paths in consuming files change.

| Module | Wraps | Confined responsibility |
|---|---|---|
| `infrastructure/mq/` | `aio-pika` | Connect, publish, consume, binding events |
| `infrastructure/ws/` | `websockets` | Connect, subscribe, delta accumulation, reconnect |
| `infrastructure/rest/` | `aiohttp` | Paginated GET, response parsing |
| `infrastructure/health/` | stdlib `asyncio` | HTTP :3000 `/health` |

---

## File Structure

```
services/signal/
  src/
    infrastructure/
      mq/
        broker.py       # connect, publish, consume
        events.py       # binding event watcher
        types.py
      ws/
        client.py       # connect, subscribe, delta accumulation, reconnect
        types.py
      rest/
        client.py       # paginated GET
        types.py
      health/
        server.py

    signals/
      base.py           # Indicator ABC + DataNeeds + arg parsing helpers
      registry.py       # active (symbol, indicator, args) refcounts + WS/REST coordination
      ema/        __init__.py
      sma/        __init__.py
      bollinger/  __init__.py
      rsi/        __init__.py
      vwap/       __init__.py
      obimbalance/__init__.py
      market/     __init__.py

    market.py           # WS stream → per-symbol MarketState (bins + open bar + book + snapshots)
    config.py           # Pydantic Settings
    main.py             # health → mq → ws → market → registry → run

  tests/
    test_ema.py
    test_sma.py
    test_bollinger.py
    test_rsi.py
    test_vwap.py
    test_obimbalance.py
    test_routing.py          # routing key parse + validate
    test_market.py           # WS delta → MarketState accumulation
    test_initialization.py   # REST backfill + WS merge

  docker/
    compose.yml

  pyproject.toml
  README.md
```

---

## Docker / Tooling

**Language**: Python 3.12
**Package manager**: `uv`
**Base images**: `docker/dev.python.Dockerfile` and `docker/prod.python.Dockerfile` (alongside existing Node pair)
**Health check**: `GET http://localhost:3000/health`

Dev compose mounts:
- `services/signal/` — service source and venv
- `packages/` — future shared Python packages (unused now, zero cost to mount)

---

## Environment Variables

Requires RabbitMQ — see [infra packs](../../modules/infra/README.md).

| Variable | Required | Description |
|---|---|---|
| `WS_URL` | yes | BitMEX WebSocket URL, e.g. `wss://testnet.bitmex.com/realtime` |
| `REST_URL` | yes | BitMEX REST base URL, e.g. `https://testnet.bitmex.com/api/v1` |
