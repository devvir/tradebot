# Digger

The replay engine. Digger serves historical BitMEX data to bots and the UI over
the *same* WebSocket and REST surfaces real BitMEX exposes, driven by a
data-internal clock that can run far faster than real time. Point a client at
digger instead of BitMEX and it replays years of history with no code change.

Digger is **synchronization + serving** only: it owns the replay clock, the k-way
merge that produces one chronological stream, the ws/rest servers, and the
slowest-client backpressure. It never reads MongoDB and never reshapes data — it
consumes ready-made messages from the **provider** (which reads librarian). No
RabbitMQ: digger pushes straight to WebSocket clients.

## Three APIs

- **WebSocket** (BitMEX realtime protocol) — clients `{ "op": "subscribe", "args":
  ["trade", "orderBookL2:XBTUSD"] }`, receive `{ table, action, data }` frames
  (`partial` then deltas). Identity is `?api-key=<accountId>`, exactly as live.
  The stream runs as fast as its **slowest** client allows.
- **REST** (`/api/v1/...`) — the BitMEX public REST surface: same paths, params,
  and shapes. "Now" is the replay clock — a hard ceiling, so no future data is
  ever served.
- **Control** — non-BitMEX: `POST /set-clock?timestamp=<ISO|ms>` to seek,
  `GET /clock` to read the current replay time.

## The clock

Data-driven and frozen when idle. Digger starts with no subscriptions and the
`DIGGER_START_TIME` clock; time only flows once a client subscribes, advancing
with the data, and freezes again when the last subscription drops. A client (or
controller) can seek with `set-clock` at any point — typically before subscribing,
for a clean cold start.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROVIDER_WS_URL` | **Yes** | — | Provider instance for the stream (firehose) |
| `PROVIDER_REST_URL` | **Yes** | — | Dedicated provider instance for REST |
| `DIGGER_START_TIME` | No | — | Initial clock (ISO-8601 or epoch ms); frozen until a client subscribes |
| `DIGGER_WS_PORT` / `DIGGER_REST_PORT` / `DIGGER_CONTROL_PORT` | No | 80 / 8000 / 8001 | The three server ports |
| `DIGGER_BATCH_SIZE` / `DIGGER_LOW_WATERMARK` | No | 1000 / 5000 | Buffer paging |
| `DIGGER_DRAIN_BATCH` | No | 256 | Messages the loop drains per event-loop turn (one pacer check + one yield each) |
| `DIGGER_BP_HIGH` / `DIGGER_BP_LOW` | No | 4 MB / 1 MB | Per-client `bufferedAmount` backpressure thresholds (bytes) |

## Deployment

Part of the replay module (`modules/exchange/replay`), wired to two provider
aliases (ws firehose + dedicated rest), each backed by its own librarian.

See [docs/services/DIGGER.md](../../docs/services/DIGGER.md) for the technical
reference and [docs/planning/REPLAY.md](../../docs/planning/REPLAY.md) for the
module architecture.
