# Farmer Service — Technical Reference

## Overview

Farmer takes the raw vault data (gzipped CSV per table+date) and turns it into
the cleaned, reconstructed, deterministically-keyed Mongo collections the
replay engine needs. A single in-process pipeline reads from vault, transforms
each item, and hands the resulting documents to a dedicated write-only sidecar
— a [Librarian](LIBRARIAN.md) instance configured as farmer's writer (referred
to throughout this doc simply as "the writer"). Progress is checkpointed in
Redis so work resumes cleanly across restarts.

If the only goal were "move bytes from vault to Mongo", the service would be
twenty lines. The extra surface is five layered concerns:

**Reliability.** Resumption from Redis, deterministic `_id` so any retry is
idempotent (`E11000` is acceptable), corruption captured into a dedicated
`farmer` database for forensics rather than silent loss.

**Replayability.** WS-message envelopes are stored in vault with their
redundant metadata stripped (BitMEX `partial`-only fields like
`keys`/`types`/`filter`). Farmer reconstructs the full envelope so replay
engines can serve it as-is and spend no CPU on per-message decoration. Legacy
gaps (e.g. pre-2023 `orderBookL2` rows missing `timestamp`/`transactTime`/
`pool`) are filled here.

**Normalization.** Every document gets a reliable timestamp (native if the
table has one, reception date otherwise) and a deterministic `_id` packed as
`dateOffset × 2³⁹ + slot × 2¹² + reserved` — a 53-bit safe integer that lets
date-range queries ride Mongo's natural `_id` index. `slot = position − 1`
internally; see [id.ts](../../services/farmer/src/write/id.ts).

**Throughput.** Mongo writes are CPU-heavy enough (BSON encoding, driver
work) that doing them in-process forces the reader and the writer to share one
Node event loop. Offloading to the writer service over HTTP recovers the
reader's natural rate (~40k/s) at the cost of one TCP round-trip per batch.

**Maintainability.** New BitMEX quirks appear regularly. A well-structured
pipeline (read → infer → assemble → dispatch) keeps new guards landing in one
place. Orchestration concerns (where to start, what's next, what's done) are
isolated in their own submodule and reachable only through `nextTask()`.

## Glossary

| Term | Meaning |
|---|---|
| **bucket** | One gzipped CSV at `<table>/<year>/<YYMMDD>.csv.gz`. The unit of stored data. |
| **record** | A REST item — one CSV row → one Mongo document. |
| **message** | A WS item — one or more CSV rows (continuation rows have empty `_date_`+`action`), reassembled by vault into a single object. |
| **item** | Record or message, with its 1-based `position` in the bucket file, its `task`, and its `rows` count (1 for REST, `parsed.data.length` for WS). |
| **task** | A bucket that needs importing. Owns its progress and lifecycle; carries the shared `stopSignal`. |
| **progress** | Stored in Redis as `<messages>` while in-flight, `done:<messages>` once complete. |

## Pipeline

One global pipeline with edge concurrency: N parallel **readers** stream their
buckets from vault, the **flusher** ships per-table batches to the writer over
HTTP, and the middle is single-threaded — fast CPU work that doesn't gain from
parallelism and would only obscure the flow.

```
N readers (one per task — workers feed and move on)
        │
        ▼
 ┌──────────────┐
 │  reader q    │  200k high / 50k low
 └──────┬───────┘
        │
   infer (by task.type)
   ┌────┴────┐
WS │         │ REST
   ▼         │
 ┌──────────────┐
 │ assembler q  │
 └──────┬───────┘
        │
   parse + reconstruct
   (sets item.rows = parsed.data.length)
        │         │
        ▼         ▼
 ┌──────────────┐
 │  writer q    │  global in-flight cap: 100k rows
 └──────┬───────┘
        │
   dispatch (by table)
        │
   per-table batches
        │
   flush (50ms timer or cap headroom)
        │
   POST /:table  ─→  Librarian  ─→  MongoDB
```

`JSON.parse` and `reconstruct()` errors fork to the `farmer.<table>`
collection via a direct mongo `insertOne` — error volume is too low to be
worth routing through the writer.

## Item

Every item flows through the pipeline as a single mutable object with a stable
property set (V8 hidden-class friendly):

```ts
interface Item {
  task:     Task;
  position: number;                       // 1-based: first message of a file is position 1
  raw?:     string;                       // present from reader; cleared after parse
  parsed?:  Record<string, unknown>;      // populated by assembler (WS) or at write (REST)
  rows:     number;                       // 1 for REST; parsed.data.length for WS
}
```

`table`, `date`, `type`, and `stopSignal` live on `item.task` — one shared
pointer per bucket, not duplicated per item. Fields are mutated in place
across stages; we never spread/clone to add a property. The mongo doc is
built by mutating `item.parsed` (or the freshly-parsed `JSON.parse(item.raw)`)
to add `_id`, then handing it to the writer in a JSON array body.

`rows` is set by the producer of each item: the reader defaults it to `1`,
and assemble overwrites it with `parsed.data.length` once the WS message is
reconstructed. The flusher reads it to bound each HTTP batch by total row
count rather than item count.

## Orchestration

Everything to do with "what's next?" and "where are we?" lives in one
submodule, behind a single public verb: `nextTask()`. Workers call it; they
either get a Task or `undefined` (shutdown). Nothing else from orchestration
crosses the boundary.

```
orchestration/
  index.ts      barrel — exports nextTask() + Task type + StopSignal
  progress.ts   the ONLY module that talks to Redis; owns the key format
  task.ts       Task class — self-managing aggregate
  manager.ts    pending list, refresh policy, ordering, stats
```

The progress submodule's API is semantic (`list`, `listDone`, `get`,
`markProgress`, `markDone`) — callers never see the on-disk encoding. The
storage layer could swap to Mongo or filesystem without a line of farmer code
outside `progress.ts` changing.

### Task

```ts
class Task {
  table:          BitmexTable;
  date:           string;
  type:           'ws' | 'rest';        // computed once from WS_TABLES
  startTime:      number;
  messages:       number;               // monotonic; equals max(position) confirmed
  totalMessages:  number | null;        // set by reader on EOF
  readonly stopSignal: StopSignal;

  updateProgress(position: number): void;
  setTotalMessages(count: number): void;
}
```

The Task ticks once per second and writes its current `messages` count via
`markProgress`. When `messages >= totalMessages`, `markDone(table, date,
messages)` is written and the timer is cleared. Empty file → `setTotalMessages(0)`
→ `done:0`. Resume from `done` is via the `discover` path skipping anything
listed by `progress.listDone()`.

Each Task also carries a reference to the service-wide `stopSignal`. The tick
honours it (skip Redis if shutting down), the flusher honours it (abandon
in-flight retry batches on shutdown), and `nextTask()` returns `undefined`
once it flips.

### Refresh policy

The manager keeps an in-memory list of pending tasks and a `stale` flag.
Initial state is stale. On every refresh, the flag clears and a 1-minute
timer arms; when it fires, the flag flips back to stale.

`nextTask()` always checks the flag at the top: if stale, it awaits a
refresh before picking. The cost is at most one ~1–2 second wait per
minute of activity (the deduped refresh shares its work across any
concurrent callers). The benefit is that new vault files produced during
a long backlog get noticed within a minute, instead of waiting until the
existing backlog drains.

A refresh runs `listTables` + parallel `listFiles` against vault (currently
13 tables, ~14 HTTP requests, ~1–2 s wall clock) and `progress.list()` once.
Buckets in vault that are not in `listDone()` form the new pending set; the
`messages` value (if any) becomes the bucket's resume `skip`.

### In-flight filter

A bucket currently held by a worker is "partial" in Redis but **not** done —
naively rebuilding the pending list would put it right back and let a second
worker race the first on the same file (the worker that called `nextTask`
after the refresh would resume from a more advanced offset, but the bucket
would still be processed twice and the writer would E11000 on the overlap).
To avoid that, the manager keeps an in-memory `inFlight: Set<string>` keyed
by `table:date`:

- `nextTask` adds the key right before returning the new Task.
- `trackCompletion` (Task's `onComplete` hook, fires once the writer side
  is fully drained) removes it on success.
- `releaseTask` is called by the worker loop in its `catch` block to clear
  the key after a read failure, so the bucket can come back on the next
  refresh and be retried.
- `buildPending` skips any vault entry whose key is in `inFlight`.

The Set is in-memory only. On restart it's empty and the normal "partial in
Redis → resume from `skip`" mechanism takes over.

### Ordering

Across tables: weighted random sampling. Within a table: dates ascending
(oldest first).

Weights are `1 / avgTime^0.2`, not `1 / avgTime`. The dampening matters
because the practical avgTime spread is enormous (small tables finish in
seconds, large ones take hours — a 1:10,000+ ratio). Raw inverse-time would
starve slow tables almost entirely; with exponent 0.2 the spread collapses
to a manageable ~6× picking ratio between fastest and slowest table, so
small tables still drain quickly but orderBookL2 keeps making steady
progress instead of sitting idle for weeks.

Tables with no stats yet get the lowest known `avgTime` — optimistic, so
new tables don't sit at the back of the queue waiting for a chance. When no
stats exist at all (very first batch), the distribution is uniform.

Stats are in-memory only. On restart, the first few completions recalibrate
the averages. There's no benefit to persisting them.

## Flushing

The flusher runs on a 50 ms timer. Each tick walks the per-table batches and
launches as many HTTP POSTs as fit under the wire-side inflight cap.
Concurrent posts per table are allowed: each `fetch` runs in its own async
branch, so a slow request on one table never blocks the next.

### Row-based batching

Batches are bounded by **rows**, not item count. A single WS partial may
carry tens of thousands of rows; an item-count cap easily blows past the
writer's 32 MB body limit. The flusher caps each request at
`MAX_ROWS_PER_REQUEST` rows (50 000), summing `item.rows` across the slice.

The first item in any slice is always taken, even if its row count alone
exceeds the cap. A 70 000-row `orderBookL2` partial ships alone — the writer
either accepts it (mongo's per-doc 16 MB limit permitting) or surfaces an
error that the retry loop catches. Splitting a single WS partial into
multiple inserts isn't an option without changing the on-the-wire shape, so
"send and let the writer decide" is the only sensible behaviour.

### Inflight gate

A single global counter caps how many rows are currently being held by
in-flight HTTP requests (default cap 100 000). Items move through two stages:

1. Admitted to the writer queue (post-parse for WS, direct for REST) →
   incremented by 1 per item via the per-item `admit` gate.
2. Spliced out into a per-table batch and shipped via HTTP → released from
   the per-item gate, and the row count is added to the wire inflight.
3. Response received → the row count comes off the wire inflight.

The two-stage design lets the writer queue empty as soon as items have been
handed to a `fetch` call (so dispatch can advance), while still keeping a
hard ceiling on rows the producer-side has outstanding.

## Drops, errors, shutdown

| Case | Action | Why |
|---|---|---|
| WS message with `data: []` | Drop. Bump task progress. | Empty partials/deltas convey no state — the replay engine synthesizes them on subscription. Storing them is wasted space, not an error. |
| `JSON.parse` throws | Write `{ _id, message: raw }` to `farmer.<table>` (direct `insertOne`). Bump progress. | Bytes got corrupted between vault and farmer. Preserve for forensics; the `_id` matches where the doc would have lived in `tradebot.<table>`. |
| `reconstruct()` throws | Same as parse throw. | Same cause — vault constructs the JSON itself, so a shape mismatch is post-vault corruption. |
| `TABLE_SPECS` lookup miss (unknown table) | `service.shutdown('Unknown table ${table}')` | Config drift between vault and code. Operator must look. |
| Writer responds `200 { duplicates: true }` | Treat as success. Bump progress. | The writer (a librarian instance) runs with `LIBRARIAN_IGNORE_DUPLICATES=true`, so it has handled the `E11000` for us; idempotent retry path. |
| Writer responds non-2xx, or fetch throws | Retry forever, exponential backoff `1s → 2 → 4 → 8 → 16 → 30s`. | Transient infra (writer restarting, mongo blip) resolves in seconds. Persistent issues hang loudly on the batch; data is never silently dropped. |
| `stopSignal.triggered` mid-retry | Abandon the batch, log. | Items are re-streamed and re-inserted on next start; `_id` collision keeps it idempotent. |

## Backpressure

When the writer (or mongo behind it) is slow:

```
HTTP responses lag → wire inflight stays near cap → flusher stops launching →
batches build up → writer queue admission waits → assembler push blocks →
reader queue fills past high watermark → reader push blocks →
vault HTTP body backs up → TCP throttles vault server-side
```

No external queue-depth polling, no broker. Memory is bounded by the queue
sizes and the wire inflight cap together.

## Recovery & idempotency

Restart from scratch is always safe:

- Tasks read their resume point via `progress.get` on creation. Items already
  inserted produce `E11000` on the second pass, which the writer handles as
  success and farmer treats as a normal `200` ack.
- `_id` is `dateOffset * 2³⁹ + (position - 1) * 2¹² + reserved` — deterministic
  from `(date, position)`. Two runs over the same bucket produce identical
  `_id`s. Empty file → `setTotalMessages(0)` → `done:0`.
- Buckets that returned from `progress.listDone()` at refresh time are skipped
  at discovery.

A crash mid-bucket loses at most the items between the last `<messages>` write
(≤ 1 s ago) and the crash. Those replay safely on resume via `E11000`.

## Metrics

`metrics.ts` keeps two counters with two rates each, plus pause accounting
for the reader-side queue. Call sites are one-liners — no math at the call
site:

| Call | Where | Meaning |
|---|---|---|
| `recordRead()` | reader pushes a line into the reader queue | "item entered the pipeline" |
| `recordReadPause()` | reader queue hits high watermark | "input is back-pressured" |
| `recordReadResume()` | reader queue drops to low watermark | "input resumed" |
| `recordWrite(n)` | flusher after a successful writer response | "n items acknowledged" |

A periodic interval (default 1 min) logs:

| Field | Meaning |
|---|---|
| `totalRead` / `totalWritten` | Cumulative counts |
| `readRateActive` | items/s when the reader is **not** paused. Reflects what farmer is capable of pulling, independent of downstream stalls. |
| `writeRate` | items/s end-to-end |
| `hourlyReadRate` / `hourlyWriteRate` | rolling 60-minute equivalents |
| `pausedPct` | fraction of uptime spent paused at the reader |
| `pauseCount` | number of pause events since startup |
| `readerQueueSize` | current depth of the reader queue at log time |
| `uptimeMin` | service uptime in minutes |

The rates together expose the bottleneck. `readRateActive` ≫ `writeRate`
with high `pausedPct` → writer/mongo is the limiter; `readRateActive` ≈
`writeRate` with low `pausedPct` → system at equilibrium; both low → vault
or network.

Errors written to `farmer.<table>` and dropped empty partials are not counted
in `recordWrite` — that counter reflects only what landed in the target db.

## Folder structure

```
src/
  index.ts              entry — SK.run, wire pipeline, start workers
  service.ts            SKFactory({ name: 'farmer', mongodb, redis, config })
  config.ts             env vars
  types.ts              Item, shared types
  buffer.ts             BoundedBuffer<T> (with onPause/onResume)
  metrics.ts            recordRead/recordWrite/pause-resume + periodic logger
  loop.ts               worker pool — N workers calling nextTask()

  orchestration/
    index.ts            barrel: nextTask, Task type, StopSignal
    progress.ts         SOLE Redis owner; semantic API + farm:* key format
    task.ts             Task class; self-managing
    manager.ts          pending list, stale-based refresh, weighted ordering, stats

  read/
    vault.ts            vault HTTP client (NDJSON streaming + large-skip dispatcher)
    reader.ts           per-task NDJSON streamer (→ reader queue)

  process/
    infer.ts            reader queue → assembler queue (WS) or writer queue (REST)
    assemble.ts         assembler queue → parse → reconstruct → writer queue
                        (sets item.rows = parsed.data.length)
    reconstruct.ts      WS reconstruction (timestamp, partial decoration, legacy backfills)

  write/
    inflight.ts         per-item admission gate (writer-side backpressure)
    dispatch.ts         writer queue → per-table batches
    flush.ts            per-table HTTP POSTs to the writer + retry loop
                        row-based batching via MAX_ROWS_PER_REQUEST
    errors.ts           farmer.<table> error writes (direct insertOne)
    id.ts               makeId(date, position) — translates position - 1 to legacy slot
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_URL` | Yes | — | Base URL of the vault service |
| `LIBRARIAN_URL` | Yes | — | Base URL of the librarian writer service |
| `DB_DATABASE` | Yes | — | Target database (writer reads its own `DB_DATABASE`; farmer's value is used only for the `farmer.<table>` forensics writes) |
| `CACHE_URL` | Yes | — | Redis connection string |
| `FARMER_TABLES` | No | (all) | Comma-separated table filter |
| `FARMER_FILE_CONCURRENCY` | No | `10` | Parallel reader workers |
| `FARMER_READ_BUFFER_HIGH` | No | `1000000` | Reader queue high watermark |
| `FARMER_READ_BUFFER_LOW` | No | `500000` | Reader queue low watermark |
| `FARMER_INFLIGHT_CAP` | No | `500000` | Wire-side inflight cap (rows in-flight to the writer) |
| `FARMER_WIRE_CAP_MB` | No | `20` | Max batch size to send to Writer, in Mb |
| `FARMER_FLUSH_INTERVAL_MS` | No | `100` | Per-table batch dispatch timer |
| `FARMER_PROGRESS_INTERVAL_MS` | No | `1000` | Per-task Redis progress tick |
| `FARMER_METRICS_INTERVAL_MS` | No | `60000` | Throughput metrics log interval |
