# Digger Service — Technical Reference

## What digger is

Digger is the **replay engine** — the serving tier of the replay module
(`MongoDB → librarian → provider → digger`). It serves historical BitMEX data to
clients over the same WebSocket and REST surfaces real BitMEX exposes, driven by a
data-internal clock. It is **synchronization + serving** only: it owns the replay
clock, the k-way merge, the ws/rest/control servers, and the slowest-client
backpressure — but never reads MongoDB and never reshapes data. Everything
storage- and shape-related lives in the provider; digger consumes ready-made
messages from it. There is no RabbitMQ — digger pushes straight to sockets.

## Concern structure

Digger is fat, so structure is load-bearing. Each concern is a folder with a
barrel `index.ts` and a local `types.ts`; a change to one stays in its folder.

```
src/
  core/        clock, snapshot accumulator, shared types
  provider/    the data-source seam — the only place that knows the provider's HTTP shape
  reader/      warm buffers + k-way merge + cold-activation/catch-up
  ws/          ws server, subscription hub, egress, pacer, streaming loop
  rest/        BitMEX REST surface (params + pure pass-through to the provider)
  management/  control surface (set-clock seek, expose clock)
  service.ts   SKFactory: 3 servers (ws + 2 express) + 2 provider fetch clients
  index.ts     boot: seed clock, build seam, start the servers + loop
```

Dependency direction: `core` → nothing; `provider`/`reader`/`rest` → `core`
(reader/rest also → `provider`); `ws` → `core` + `reader`; `management` → `core` +
`reader` + `ws`.

## The replay clock

`core/clock` is a module-level `number | null`: the epoch-ms timestamp of the last
message emitted onto the shared stream. **Data-driven** and **forward-only** — it
advances only as messages flow and **freezes** (holds its value) when nothing is
subscribed.

- `set(ms)` — jump to any instant (start time / seek).
- `update(ms)` — forward-only advance, once per emitted message.
- `fetch()` — current replay time, or null before set.

Digger boots with the `DIGGER_START_TIME` clock (or null) and no subscriptions, so
time is frozen. The first subscribe starts the flow; the last unsubscribe freezes
it again. REST reads the clock as a **ceiling** (below).

## Subscriptions

Each client owns a subscription set (`table` or `table:SYMBOL`, held in the Net ws
server's per-client `data`). A table is **active** (consumed and merged) iff its
subscriber count ≥ 1; one client unsubscribing only stops *its* egress, and the
table is deactivated (buffer dropped) only on the last unsubscribe. Symbol scope
is an **egress filter** — the whole table is read and merged once regardless.

**Cold vs warm.** The first subscriber to a table triggers cold-activation at the
current clock; later subscribers are warm and get the current partial immediately.
Both go through one rule: *an active table whose buffer is empty is (re)activated
at the current clock* — which also covers re-priming after a seek.

**Ordering guarantee.** A client never receives a delta before its partial. The
partial is sent and the client registered for egress in one **synchronous**
critical section, and a table's buffer is made loop-visible (`promote`) only after
that — so the streaming loop, which yields between emits, cannot interleave.
Concurrent cold subscribes to the same table are serialised through an
`activating` gate.

## The reader — buffers, merge, activation

`reader/` holds one warm buffer per active table, paged from the provider, and the
k-way merge that picks the buffer head with the globally smallest timestamp.

**Cold-activate(table, atClock)** is **uniform** for every table — digger carries
no per-table partial logic:

1. Fetch the provider's partial (the stored partial for message tables; a synth
   empty for the rest) and feed it to the accumulator — a table is tracked only
   once it has had a partial.
2. Catch up — page forward, folding every message with `ts < clock` silently into
   the accumulator; the first message with `ts >= clock` and all after it land in
   the buffer for emission.
3. Return `buildPartial(table)` — the library produces the right snapshot for the
   table's kind (full for orderbook/instrument, 1-per-symbol for trade/quote/bins,
   active for liquidation, empty for chat/announcement).

How far back priming starts is the provider's call (its cursor). A staged buffer
becomes loop-visible only on `promote` (after the partial is sent), so the merge
never emits a delta before the partial. `partialFor(table)` returns the warm
partial straight from `buildPartial`. Order books (`orderBook10`/`orderBookL2_25`)
serve empty until their distiller lands.

## The snapshot accumulator

`core/snapshot` wraps `@devvir/bitmex-database` in `wsPartialMode`, fed **every**
emitted message so it mirrors what digger has streamed up to the clock. It is
**WS-only** — it serves warm partials to late subscribers (and seeds cold-start
folding); REST never touches it. The library handles every table correctly
(empty-partial tables ignored, insert-only tables kept 1-per-symbol), so digger
feeds indiscriminately and never special-cases. Reset on a seek. The only
in-memory state digger holds.

## The streaming loop & backpressure

`ws/loop` runs continuously: gate on the pacer → drain a **batch** of messages
(`DIGGER_DRAIN_BATCH`, default 256) — each fanned out, fed to the accumulator
(the library ignores the empty-partial tables on its own), clock advanced, buffer
topped up → yield once (`setImmediate`, so sockets flush and fetches run).
Batching amortises the yield and the pacer scan over many messages; the overshoot
(one batch of small deltas) stays far below the MB-scale backpressure threshold,
so gating is still responsive. It never breaks: with no subscriptions it idles
(time frozen); when replay runs out it idles too, ready for a seek.

**Slowest-client gate.** `ws/pacer` reads each socket's `bufferedAmount`. Emission
proceeds only while the maximum across clients is under the high-water mark; once
over, it stays gated until below the low-water mark (hysteresis). So the slowest
client paces the whole shared timeline, byte-fair, with no per-message accounting.
The pacer's `mode` is the seam for future speed/pause controls; `paused` simply
never emits.

**Egress.** For each merged message, a bare-table subscriber gets the full frame
(serialised once and shared); a symbol-scoped subscriber gets a frame filtered to
its symbols. Bare wins over scoped.

## REST API

A faithful BitMEX REST surface at `/api/v1` — a **pure pass-through to the
provider**. Digger resolves "now" (the clock, a hard **ceiling**:
`endTime = min(endTime ?? clock, clock)`, so no record after now is served and a
future-anchored query collapses to "the last N that exist"), forwards the params,
and returns the record list. It holds **no REST state and never touches the
accumulator** — the provider owns every record strategy (historical / recent /
state-reconstruction; see PROVIDER.md). `/orderBook/L2` requires `symbol`;
`*/bucketed` maps `binSize` to the bin table.

REST is a pure observer — it never drives the clock and works whether the clock is
frozen or running.

## Control API

Non-BitMEX, on its own port:

- `POST /set-clock?timestamp=<ISO|ms>` — the seek. A flat sequence of **idempotent
  orders**: pause the loop, settle, clear buffers, reset the accumulator, set the
  clock, re-prime (re-activate each subscribed table at the new clock and resend
  partials), resume. Each order is a no-op when it doesn't apply, so it never
  branches on what is running. Purely internal — no broker to drain.
- `GET /clock` — the current replay time. The hook a future private-data service
  polls to align with the stream.

## Servers & clients (Net plugin)

Three servers on distinct ports — `ws` (BitMEX-shaped stream), `rest` (express,
`/api/v1`), `control` (express) — and two `fetch` clients to the provider (ws
firehose + dedicated rest). Declared in `service.ts`; the ws server gives the
client registry, heartbeat, `ping`→`pong`, and per-client socket access for the
pacer.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROVIDER_WS_URL` | Yes | — | Provider instance for the stream |
| `PROVIDER_REST_URL` | Yes | — | Dedicated provider instance for REST |
| `DIGGER_START_TIME` | No | — | Initial clock (ISO-8601 or epoch ms); frozen until a subscribe |
| `DIGGER_WS_PORT` / `DIGGER_REST_PORT` / `DIGGER_CONTROL_PORT` | No | 80 / 8000 / 8001 | Server ports |
| `DIGGER_BATCH_SIZE` / `DIGGER_LOW_WATERMARK` | No | 1000 / 5000 | Buffer paging |
| `DIGGER_DRAIN_BATCH` | No | 256 | Loop drain batch (one pacer check + one yield per batch) |
| `DIGGER_BP_HIGH` / `DIGGER_BP_LOW` | No | 4 MB / 1 MB | `bufferedAmount` thresholds (bytes) |

## Dependencies

| Package | Purpose |
|---|---|
| `@devvir/service-kit` | Net plugin (ws + express servers, fetch clients), lifecycle |
| `@devvir/bitmex-database` | the snapshot accumulator (`createDatabase`, `wsPartialMode`) |
| `@tradebot/utils` | `WS_TABLES`, `SKFactory` |
| `@tradebot/types` | BitMEX table / action / field-type definitions |
| `express` | REST + control routing |

## Not what it used to be

The previous digger was a RabbitMQ pump (read MongoDB, publish to a `replay`
exchange). That design — and any mention of broadcast, the `replay`/`deltas`
exchanges, `DIGGER_WAIT_IF`, `purgeQueues`, or in-process table handlers — is
gone. Digger no longer touches MongoDB, RabbitMQ, or data shapes.
