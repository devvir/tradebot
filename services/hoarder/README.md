# Hoarder Service

Connects to trading venues' market-data WebSockets and publishes every message to RabbitMQ, verbatim.

One instance can collect one venue, several, or all of them — selected with `HOARDER_VENUES`, so deployments can be split per venue or consolidated without code changes.

"Venue" means a trading exchange (BitMEX, Binance, …) everywhere in this service. "Exchange" unqualified means the AMQP exchange, and nothing else.

## Core Functionality

- **Multi-venue WebSocket connections** — one socket per (venue, endpoint, socket key), created on demand
- **Verbatim relay** — payloads are published exactly as received; normalising across venues is a downstream concern, and a byte-faithful archive is what makes it possible later
- **Venue routing keys** — the routing key is the venue name (`bitmex`). Anything finer is venue-local vocabulary a binding cannot express portably, and it is already in the payload
- **Automatic reconnection** with exponential backoff, and resubscription of tracked channels
- **Backpressure** — a paused publisher pauses every socket across every venue
- **Health monitoring** and graceful shutdown

**Public market data only.** Private streams need one pipeline per account and belong to a separate service, so hoarder carries no credential handling of any kind.

## Adding a venue

Each venue is one file under [src/venues/](src/venues/) implementing the `Venue` interface — endpoints, which endpoint carries a channel, subscribe/unsubscribe frames, ack matching, and whether a frame is market data. Add its subscriptions to [src/venues/channels.ts](src/venues/channels.ts) and register it in [src/venues/index.ts](src/venues/index.ts). The core never learns a venue's name.

Currently implemented:

| Venue | Endpoint | Channel syntax | Ack correlates on |
|---|---|---|---|
| `bitmex` | realtime + platform | `table` / `table::Pool` | echoed channel (+ pool) |
| `binance` | spot | raw stream name — `btcusdt@aggTrade` | request id only |
| `bybit` | v5 linear | raw topic — `publicTrade.BTCUSDT` | `req_id` only |
| `okx` | v5 public | `channel:instId` — `trades:BTC-USDT` | echoed arg |
| `kraken` | v2 public | `channel:symbol` — `trade:BTC/USD` | echoed channel + symbol |

Every adapter was written from traffic captured against the live endpoint, and the frames in `tests/venues-protocols.test.ts` are those captures.

Two protocol traps worth knowing before adding a venue:

- **Binance does not validate a subscription.** `btcusdt@nonsense` is answered `{"result":null,"id":…}`, identically to a real stream. A typo in the channel list produces silence, not an error. OKX, Bybit and Kraken all reject unknown channels explicitly.
- **Binance and Bybit acks do not name the channel.** Correlation is by request id, so both adapters derive that id deterministically from the channel and recompute it when matching — no state between send and ack. Binance additionally constrains the id to `^[a-zA-Z0-9-_]{1,36}$`, which the raw channel violates.

Binance **futures** (`fstream.binance.com`) is not implemented: it accepts a subscribe and then delivers nothing from our network, on both the `/ws` and combined-stream paths, while spot streams normally and the futures REST API answers. It needs verifying from wherever hoarder actually runs before being added.

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

## Configuration

Requires RabbitMQ — see [infra packs](../../modules/infra/README.md).

| Variable | Required | Default | Description |
|---|---|---|---|
| `HOARDER_VENUES` | No | _(all known)_ | Comma-separated venues to collect — `bitmex`, `binance`, `bybit`, `kraken`, `okx`. Unknown names fail at startup |
| `QUEUE_URL` | Yes | — | RabbitMQ connection URL |

**What each venue subscribes to is not configurable** — the lists live in [src/venues/channels.ts](src/venues/channels.ts). They change rarely and never per host, so a rebuild is the right cost for changing them, and the collected set stays legible in one file instead of spread across deployment envs.

## Message Envelope

| Header | Meaning |
|---|---|
| `x-venue` | Which venue the frame arrived from |
| `x-hoarder-uuid` | Collector instance, so several collectors can share one AMQP exchange |
| `x-collected-at` | When the collector received it |
