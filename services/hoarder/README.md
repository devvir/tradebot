# Hoarder Service

Connects to trading venues' public market-data WebSockets and publishes every market-data frame to
RabbitMQ exactly as it was received.

Deployed by: no module.

One instance can collect one venue, several, or all of them — selected with `HOARDER_VENUES`, so deployments can be split per venue or consolidated without code changes.

"Venue" means a trading exchange (Binance, OKX, …) everywhere in this service. "Exchange" unqualified means the AMQP exchange, and nothing else.

**Status: parked.** [src/venues/channels.ts](src/venues/channels.ts) lists two symbols per venue
(BTC and ETH), each with a trade channel and a book channel.

## Core Functionality

- **Multi-venue WebSocket connections** — one socket per (venue, endpoint, socket key), opened when its first channel is subscribed
- **Byte-faithful relay** — a frame is parsed only to ask its venue whether it is market data; what is published is the received buffer, so number text, escapes and whitespace stay as the venue sent them. Control frames (acks, heartbeats, status) are logged, not published; a frame that is not JSON is logged and dropped
- **Venue routing keys** — the routing key is the venue name (`okx`). Anything finer is venue-local vocabulary a binding cannot express portably, and it is already in the payload
- **Subscriptions** — each socket sends one subscribe at a time and waits for its ack (5 s, not counting time the socket is paused). An unconfirmed subscribe is retried on the same socket, from 1 s doubling to 60 s; a channel the venue refuses is logged and dropped. Every socket that opens, a reconnected replacement included, subscribes every channel assigned to it that has not been refused
- **Reconnection** — only a socket's close schedules its replacement, after a backoff from 200 ms doubling to 15 s (±20% jitter), reset once a socket has stayed open for 30 s; a handshake refused with HTTP 418 or 429 backs off at 15 s at once. A handshake must complete within 10 s, and an open socket that sends nothing in the 30 s after a ping is terminated (a paused socket is not judged)
- **Backpressure** — while the AMQP channel's write buffer is full, every socket stops reading, including one that opens meanwhile, and resumes when it drains. A paused socket answers no ping from its venue; a pause lasting over 30 s is logged as a warning
- **Shutdown** — on SIGTERM or SIGINT every socket is paused and terminated and no socket is made or replaced; frames already read may still be published. A publish failing because the broker channel or connection is closed shuts the service down; the compose file's `restart: unless-stopped` starts it again
- **Health** — port 3000 answers `200` while a frame has been published in the last 30 s (60 s after startup, before the first), `503` otherwise, with `{healthy, messages, startedAt, lastMessageAt}`

**Public market data only.** Hoarder subscribes to public channels and carries no venue credentials of any kind.

## Adding a venue

Each venue is one file under [src/venues/](src/venues/) implementing the `Venue` interface — endpoints, which endpoint carries a channel, subscribe/unsubscribe frames, ack matching, and whether a frame is market data. Add its subscriptions to [src/venues/channels.ts](src/venues/channels.ts) and register it in [src/venues/index.ts](src/venues/index.ts). The core never learns a venue's name.

Currently implemented:

| Venue | Endpoint | Channel syntax | Ack correlates on |
|---|---|---|---|
| `binance` | spot, `wss://stream.binance.com:9443/ws` | raw stream name — `btcusdt@aggTrade` | request id, derived from the channel |
| `bybit` | v5 linear, `wss://stream.bybit.com/v5/public/linear` | raw topic — `publicTrade.BTCUSDT` | `req_id`, set to the topic |
| `okx` | v5 public, `wss://ws.okx.com:8443/ws/v5/public` | `channel:instId` — `trades:BTC-USDT` | echoed arg (`channel` + `instId`) |
| `kraken` | v2 public, `wss://ws.kraken.com/v2` | `channel:symbol` — `trade:BTC/USD` | echoed `channel` + `symbol` |

Binance futures is not collected; for its endpoint, see [BINANCE.md](../../docs/venues/BINANCE.md#websocket).

Where an ack does not name the channel (Binance, Bybit), the adapter derives the request id from the channel and recomputes it when matching, so nothing is held between send and ack. Where a rejection names no channel (OKX, Kraken), it is taken as the refusal of the channel being awaited only while no other request on the socket is unanswered. A request whose wait timed out can still be answered while a later one is awaited; until that answer is read, such a rejection may be its, so the awaited channel is retried instead of dropped, and the rejection is counted as the answer to the oldest unanswered request. Binance acknowledges a stream that does not exist exactly as a real one, so a Binance channel counts as confirmed once its request is acknowledged, whether or not data follows.

The frames in `tests/venues-protocols.test.ts` are trimmed from frames captured against the live endpoints. For each venue's WebSocket protocol, see the *WebSocket* section of its doc, where one exists: [BINANCE.md](../../docs/venues/BINANCE.md), [BYBIT.md](../../docs/venues/BYBIT.md), [OKX.md](../../docs/venues/OKX.md). Kraken's observed frames are in the docblock of [src/venues/kraken.ts](src/venues/kraken.ts).

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
| `HOARDER_VENUES` | No | _(all known)_ | Comma-separated venues to collect — `binance`, `bybit`, `kraken`, `okx`. Unknown names fail at startup |
| `QUEUE_URL` | Yes | — | RabbitMQ connection URL |

**What each venue subscribes to is not configurable** — the lists live in [src/venues/channels.ts](src/venues/channels.ts). They change rarely and never per host, so a rebuild is the right cost for changing them, and the collected set stays legible in one file instead of spread across deployment envs.

## Message Envelope

Every market-data frame is published to the topic exchange `hoarder`, which hoarder declares at
startup, with the venue name as routing key, `contentType` `application/json`, persistent, and the
frame as received as body.

| Header | Meaning |
|---|---|
| `x-venue` | Which venue the frame arrived from |
| `x-hoarder-uuid` | Collector instance, so several collectors can share one AMQP exchange |
| `x-collected-at` | When the collector received it |
