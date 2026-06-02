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
`dateOffset × 2³⁸ + slot × 2⁸ + reserved` — a 53-bit safe integer that lets
date-range queries ride Mongo's natural `_id` index. `slot = position − 1`
internally; built by `makeMongoId` in `@tradebot/utils`.

**Throughput.** Mongo writes are CPU-heavy enough (BSON encoding, driver
work) that doing them in-process forces the reader and the writer to share one
Node event loop. Offloading to the writer service over HTTP recovers the
reader's natural rate (~60k/s on an otherwise-idle box) at the cost of one TCP
round-trip per batch.

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
| **item** | Record or message, with its 1-based `position` in the bucket file, its `task`, its `content` (the wire-ready JSON string), and its byte `size`. |
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
 │  reader q    │  byte-bounded: readBufferBytes (derived, ≤ 1 GiB)
 └──────┬───────┘
        │
   infer (by task.type)
   ┌────┴────┐
WS │         │ REST
   ▼         │
 ┌──────────────┐
 │ assembler q  │  byte-bounded: readBufferBytes
 └──────┬───────┘
        │
   assemble: content → wire envelope, set item.size
        │         │
        ▼         ▼   admit(item.size) → staging byte gate (stagingBytes)
 ┌──────────────┐
 │  writer q    │
 └──────┬───────┘
        │
   dispatch (by table)
        │
   per-table batches
        │
   flush (100 ms timer; round-robin under the in-flight request cap)
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
  task:     Task;       // shared per-bucket pointer (table, date, type, stopSignal)
  position: number;     // 1-based: first message of a file is position 1
  content:  string;     // a JSON string beginning with `{` — the doc as it goes on the wire
  size:     number;     // byte length of `content`
}
```

`table`, `date`, `type`, and `stopSignal` live on `item.task` — one shared
pointer per bucket, not duplicated per item. `content` is mutated in place
across stages; we never spread/clone to add a property:

- the **reader** sets `content` to the vault NDJSON line as-is (REST docs are
  already wire-ready; WS lines are the raw envelope)
- **assemble** (WS only) replaces `content` with the reconstructed wire
  envelope — template-spliced for the common case, parse + `reconstruct()` +
  stringify for the rare fallbacks
- the **flusher** injects `_id` into `content` by string surgery on the way out

No `JSON.parse` runs on the hot path: keeping everything as text avoids the
hidden-class churn and GC pressure that nested POJOs cause at this volume.
`size` tracks `content`'s byte length — the reader sets it to the line length,
assemble re-sets it after splicing the envelope — and is the unit the staging
gate and the flusher's batching both bound by.

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

The flusher runs on a 100 ms timer. Each tick round-robins a fixed budget of
concurrent in-flight requests across the per-table batches — one batch per
table per pass, from a rotating start offset, looping until every slot is busy
or a full pass ships nothing. That rotating round-robin is what stops a fat
table (orderBookL2) from claiming every slot and starving the tables
dispatched into `batches` after it. Each `fetch` runs in its own async branch,
so a slow request on one table never blocks another.

### Byte-based batching

Batches are bounded by **bytes** (`item.size`), not item count. A single WS
partial may carry tens of thousands of rows and run to MBs on its own, so an
item-count cap easily blows past the librarian's 32 MiB body limit. The flusher
caps each request at `MAX_BYTES_PER_REQUEST` (20 MiB), summing `item.size`
across the slice.

The first item in any slice is always taken, even if it alone exceeds the cap.
A huge `orderBookL2` partial ships alone — the librarian either accepts it
(mongo's per-doc 16 MiB limit permitting) or surfaces an error the retry loop
catches. Splitting a single WS message isn't possible without changing the
on-the-wire shape, so "send and let the writer decide" is the only option.

### In-flight request cap

The one throughput knob is `FARMER_INFLIGHT_CAP` — how many POSTs may be in
flight to the librarian at once. A slot is a slot regardless of batch size
(each batch is ≤ `MAX_BYTES_PER_REQUEST`), so a request count maps directly to
"how many requests the writer replicas juggle" and stays meaningful no matter
how big the messages are — unlike a byte or item cap, whose real-world load
drifts with message size. Mongo is the floor; this knob exists so farmer keeps
it busy without flooding it.

### Staging gate

A single global byte counter (`staging`) bounds everything processed but not
yet shipped — the writer queue plus the per-table batches. infer/assemble call
`admit(item.size)` before pushing onto the writer queue; flush calls
`release(bytes)` when it splices a batch out to POST it. Its cap is
`stagingBytes = FARMER_INFLIGHT_CAP × MAX_BYTES_PER_REQUEST` — one full
send-set held ready, so the flusher never starves between reads. When it fills,
`admit` blocks, and that is what propagates backpressure to the readers.

This is "ready to send", distinct from "in flight": an item is counted by the
staging gate until its batch is spliced for a POST, then by the in-flight
request cap until the response lands. Never both, never neither.

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
HTTP responses lag → in-flight request slots stay full → flusher stops
launching → per-table batches build up → staging byte gate fills →
admit blocks → assembler / writer-queue pushes block → reader-queue bytes
fill past the high watermark → reader push blocks → vault HTTP body backs up →
TCP throttles the vault server-side
```

No external queue-depth polling, no broker. The footprint is byte-bounded end
to end and flat regardless of message size: the two read buffers
(`readBufferBytes` each), staging (`stagingBytes`), and the in-flight bodies
(`FARMER_INFLIGHT_CAP × MAX_BYTES_PER_REQUEST`).

## Recovery & idempotency

Restart from scratch is always safe:

- Tasks read their resume point via `progress.get` on creation. Items already
  inserted produce `E11000` on the second pass, which the writer handles as
  success and farmer treats as a normal `200` ack.
- `_id` is `dateOffset * 2³⁸ + (position - 1) * 2⁸ + reserved` — deterministic
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
    assemble.ts         assembler queue → wire envelope (template splice; parse +
                        reconstruct on the rare fallbacks) → writer queue
    reconstruct.ts      WS reconstruction (timestamp, partial decoration, legacy backfills)

  write/
    staging.ts          staging byte gate (producer-side backpressure)
    dispatch.ts         writer queue → per-table batches
    flush.ts            per-table HTTP POSTs to the writer + retry loop;
                        byte-based batching, round-robin under the request cap
    errors.ts           farmer.<table> error writes (direct insertOne)
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
| `FARMER_INFLIGHT_CAP` | No | `20` | Max concurrent POSTs in flight to the writer; `stagingBytes` (= cap × 20 MiB) and the read-buffer byte ceilings derive from it |
| `FARMER_FLUSH_INTERVAL_MS` | No | `100` | Per-table batch dispatch timer |

The per-task Redis progress tick (1 s) and the metrics log interval (60 s) are
fixed constants, not env knobs.
