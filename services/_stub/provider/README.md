# Provider

The replay data provider. It reads stored BitMEX data through **librarian** and
serves it to **digger** in the exact shape digger asks for — WebSocket messages
or REST records — so digger never needs to know how anything is stored.

## What it does

Given a table, a cursor or time, and a direction, the provider reads the raw
documents from librarian and converts them to the requested format:

- **`GET /ws/:table?after=<cursor>&limit=<n>`** — the next page of BitMEX
  WS-shaped messages. Message tables (orderBookL2, instrument, …) are republished
  as-is; flat record tables (trade, quote, the bins, …) are wrapped as `insert`
  messages, with `trade` records that share `timestamp + symbol` grouped into one
  sweep insert.
- **`GET /ws/:table/partial?before=<ms>`** — the partial to apply on a cold
  subscribe: the latest stored `partial` before that time (message tables) or a
  schema-only partial (flat / order-book tables), plus the cursor to start paging
  the forward stream from. The provider serves the data only — it never builds
  snapshots; that is digger's job.
- **`GET /rest/:table?<bitmex params>`** — time-series records for flat tables,
  in either direction, honouring `symbol` / `count` / `start` / `reverse` /
  `startTime` / `endTime` / `columns`.
- **`GET /health`** — liveness for the container healthcheck.

It abstracts storage completely: a change to how data is stored is a change here,
and no consumer is affected. The two order books (`orderBook10`, `orderBookL2_25`)
are served empty for now (pending their distiller).

## Stateless

The provider holds no clock, no session state, and builds no snapshots. Every
request is independent, so it scales horizontally — run as many replicas as the
read load needs. The replay module runs one pool for digger's WS firehose and a
separate instance for REST, each pointing at its own librarian.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `LIBRARIAN_URL` | **Yes** | — | Base URL of the librarian instance to read from |
| `NET_DEFAULT_PORT` | No | `80` | Host-wide default server port (service-kit Net) |

## Deployment

Extended per-alias by the replay module's compose (a WS-firehose instance and a
dedicated REST instance), each wired to the matching librarian. Never run
standalone in production.

See [docs/services/PROVIDER.md](../../docs/services/PROVIDER.md) for the technical
reference and [docs/planning/REPLAY.md](../../docs/planning/REPLAY.md) for the
module architecture.
