# Provider Service — Technical Reference

## Overview

The provider is the **shaping tier** of the replay module
(`MongoDB → librarian → provider → digger`). It reads stored BitMEX data through
librarian and converts it, on demand, into the format the caller asks for — WS
messages or REST records — abstracting the storage layout entirely. A change to
how data is stored is a change in the provider; no consumer is affected.

It exists so that **digger stays thin**: digger owns the replay clock, the k-way
merge, the WS/REST servers, and the per-client backpressure, but never learns a
stored format, never wraps a record, never reconstructs a partial. Everything
shape-related lives here.

## Stateless by construction

The provider holds **no clock and no session state** — every request is
`(table, cursor-or-time, …) → read librarian → transform → return`, so it scales
horizontally exactly like librarian. It keeps **no live snapshot**: the WS
cold-start partial is served raw (digger folds it into its own accumulator), and
the REST **state** tables are reconstructed with a **use-and-throw**
`createTable` that is built and discarded per request (see REST below). So it does
use `@devvir/bitmex-database`, but only transiently — never as retained state.

It is also **clock-agnostic**: digger resolves "now" (and caps future bounds)
before calling, so the provider only ever sees absolute times and opaque cursors.

## The catalog

Every public table is classified once, on `@tradebot/utils` (`WS_TABLES`,
`TABLE_SPECS`), so there is a single source of truth for table shapes:

| Kind | Tables | WS | REST |
|---|---|---|---|
| `message` | orderBookL2, instrument, liquidation, connected, announcement, chat, publicNotifications (the 7 `WS_TABLES`) | republish as-is | — (digger's accumulator) |
| `flat` | trade, quote, funding, settlement, insurance, tradeBin{1m,5m,1h,1d}, quoteBin{1m,5m,1h,1d} | wrap as `insert` | records |
| `orderbook` | orderBook10, orderBookL2_25 | empty (deferred) | — |

22 BitMEX-standard public tables. Two more exist in the database but are
**deferred** (return `404` for now, revisit if a bot needs them): `compositeIndex`
(a REST table, `/instrument/compositeIndex/`) and `tick` (referential index
"trades" — fake, for indices not symbols — served on rest + ws; may be merged
into `trade` later). The catalog's WS kind (above) is separate from its **REST**
kind — every table with a BitMEX REST endpoint is served here (historical / recent
/ state; see REST below).

## API

### `GET /ws/:table?after=<cursor>&limit=<n>`

The next page of WS-shaped messages after an opaque cursor.

```jsonc
{ "messages": [ { "ts": 1554076807853, "msg": { "table": "...", "action": "...", "data": [...] } }, ... ],
  "cursor": 1932391685950209,   // pass back as `after`; null when exhausted
  "exhausted": false }
```

`ts` is the message's epoch-ms timestamp (for digger's k-way merge); `msg` is the
wire frame digger forwards to clients — the live BitMEX shape, with no `_id` and
no top-level `timestamp`. `limit` defaults to 1000, capped at 10000.

- **Message tables** — stored docs are complete WS messages with `table` present
  and a top-level `timestamp`. Republished by stripping `_id` and the top-level
  `timestamp`; `action`/`data` and any partial metadata (`keys`/`types`/`filter`/
  `filterKey`) pass through.
- **Flat tables** — each record is wrapped as `{ table, action: 'insert',
  data: [record] }` (`_id` stripped). `trade` records sharing `timestamp + symbol`
  are grouped into one insert (a sweep — BitMEX delivers them that way). `quote`
  is **not** grouped: real data carries no same-`timestamp+symbol` quote pairs.
- **Order-book tables** — empty (`{ messages: [], cursor: null, exhausted: true }`)
  until their distiller lands.

**Sweep at a batch boundary.** When the batch is full (more may follow), the
trailing same-key group is held back and the cursor stops before it, so the next
page completes it — grouping stays correct across pages. The one exception is a
batch that is entirely a single group: it is emitted whole rather than stalling,
the rare straddle that splits into two inserts.

### `GET /ws/:table/partial?before=<ms>`

The partial to apply on a cold subscribe, plus the cursor to begin the forward
stream.

```jsonc
{ "partial": { "table": "...", "action": "partial", "keys": [...], "types": {...}, "data": [...] },
  "cursor": 1932391685816321 }
```

- **Message tables** — the latest stored `partial` at-or-before `before` (raw,
  stripped to the wire shape). `cursor` is just after that partial's `_id`, so
  digger pages the deltas after it and folds to the clock through its own
  accumulator.
- **Flat tables** — a schema-only partial (empty `data`) from `TABLE_SPECS`;
  `cursor` is the seek result for `before` (where the records ≥ `before` begin).
- **Order-book tables** — an empty schema partial, `cursor: null` (no stream).

### `GET /rest/:table?<bitmex params>`

Records for every table with a BitMEX REST endpoint, dispatched by the table's
verified BitMEX semantics (`restKind`). Common params: `symbol`, `count` (default
100, max 500), `start`, `reverse`, `startTime`/`endTime` (absolute epoch ms —
digger resolved "now" and capped any future bound), `columns`, `depth`. Returns
the BitMEX-shaped record array (`_id` stripped).

- **historical** — trade, quote, funding, settlement, insurance, the bins. Time
  window in either direction; `_id`-bounded by seek + `timestamp` filter; `start`
  by over-read-and-slice (librarian has no skip).
- **recent** — chat, announcement. The last `count` records at-or-before the
  clock, newest-first; no time filtering (matching BitMEX). The records are the
  `data` items inside the stored WS insert messages.
- **state** — orderBookL2, instrument, liquidation. The current row set
  reconstructed at the clock: find the last stored partial ≤ now, replay it + the
  deltas through a use-and-throw `createTable`, return the snapshot as records.
  Symbol-filtered; `orderBookL2` is depth-limited (`depth` default 25, `0` = full)
  and requires `symbol` (enforced by digger).

### `GET /health`

`200 { ok: true }` for the docker healthcheck.

## Time → `_id` without a timestamp index

`_id` and `timestamp` are monotonically correlated, and the `_id` carries a
day-encoding (`@tradebot/utils` mongo-id helpers), so `_id` *is* the time index —
no timestamp index is needed (one on trade/quote would cost ~0.5 TB). Steady-state
streaming never queries by timestamp; it pages by `_id` cursor.

The only timestamp→`_id` mapping is `seekId` (used by cold-start seeks, the
latest-partial lookup, and REST time bounds): a binary search over the `_id`
index. The day-encoding gives the `_id` window for the date, then descending
single-doc probes (`before=mid&order=desc&limit=1` via librarian's additive
descending read) narrow it until a short final read pins the boundary. These are
rare control-plane paths, so a handful of indexed `findOne`s is free.

## Performance lever — the partial-lookup index (deliberately omitted)

`partialBefore` for a message table reads the nearest preceding
`action: 'partial'` doc. An `{ action: 1, _id: 1 }` index makes that O(log n);
without it Mongo walks the `_id` index backward from the seek point, skipping
deltas until it hits a partial (~hourly cadence → up to ~tens of thousands of
deltas scanned on `orderBookL2`). Either way the result is **correct** — this is
purely latency, and only on a **cold subscribe** (the first client to touch a
table this session), never on the hot path.

The index is **intentionally not present** on `orderBookL2` / `instrument`: an
index costs storage proportional to table size, and those are by far the largest
tables — the same reason they're where the scan is longest. The small message
tables (`liquidation` / `announcement` / `chat`) carry an `{ action, timestamp }`
index cheaply; the big ones don't, on purpose.

**The lever:** if cold-start partial lookup is measured too slow on real data, add
`{ action: 1, _id: 1 }` to `orderBookL2` / `instrument`. That is a
distiller/farmer storage decision (they own those collections' indexes) — the
provider is read-only and never creates indexes. An agent debugging cold-start
latency should look here first.

## What the provider does *not* do

- **No *kept* snapshots.** The WS cold-start partial is served raw (digger folds
  it). REST **state** tables are reconstructed with a use-and-throw `createTable`,
  built and discarded per request — never retained between requests.
- **No clock, no "now".** Digger resolves and caps time bounds before calling.
- **No writes, no indexes.** Read-only over librarian.
- **No heavy reconstruction.** Order-book cuts, bins, and instrument synthesis are
  materialised upstream (distiller); the provider only does light envelope shaping.

## Error handling

Unknown / non-BitMEX table → `404`. Missing required query param (`after`,
`before`) → `400`. Any librarian or transform failure → `500` with the message.

## Folder structure

```
src/
  index.ts        SK.run — take the librarian client + express server, mount routes, start
  service.ts      SKFactory({ name: 'provider', servers: express, clients: librarian fetch })
  config.ts       env: LIBRARIAN_URL
  types.ts        Config, WsMessage, StreamItem/Response, PartialResponse, ReadOpts, RestParams, ...
  catalog.ts      table kind (message | flat | orderbook) + ws/rest surfaces, on TABLE_SPECS/WS_TABLES
  librarian.ts    the source seam — the only place that knows librarian's HTTP shape
  server.ts       the route surface (/ws, /rest, /health)
  ws/
    index.ts      streamAfter / partialBefore orchestration
    message.ts    message-table doc → wire message
    wrap.ts       flat record → insert; trade sweep grouping
    partial.ts    static schema partial; latest-stored-partial lookup
    seek.ts       timestamp → _id binary search
    time.ts       tolerant timestamp parse (handles ancient nanosecond form)
  rest/
    index.ts      dispatch by restKind
    historical.ts time-window records (trade, quote, funding, bins, …)
    recent.ts     last-N records (chat, announcement)
    state.ts      reconstruct at the clock via use-and-throw createTable (orderBookL2, instrument, liquidation)
    columns.ts    column projection
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `LIBRARIAN_URL` | Yes | — | Base URL of the librarian instance to read from |
| `NET_DEFAULT_PORT` | No | `80` | Host-wide default server port |

## Dependencies

| Package | Purpose |
|---|---|
| `@devvir/service-kit` | Net plugin (express server + fetch client), lifecycle, logging |
| `@devvir/bitmex-database` | transient `createTable` for REST state reconstruction |
| `@tradebot/utils` | `TABLE_SPECS`, `WS_TABLES`, mongo-id helpers, `SKFactory` |
| `@tradebot/types` | BitMEX table / action / field-type definitions |
| `express` | HTTP routing |
