# sources prepare

`sources prepare` reads all source `.csv.gz` files for each table/day group, merges them into a single sorted, deduplicated stream, and writes `prepared/YYYYMMDD.csv.gz` alongside the raw source folder.

---

## Why it exists

Collected data arrives from multiple sources (journalist, tardis, manual WS captures) with no guarantee of order or uniqueness. A single day may have several source files from different collectors, and ghost subscriptions in BitMEX's WS protocol routinely deliver the same event twice.

The fundamental requirement is: **sort before dedup**. Deduping on a raw stream misses oscillations that span unrelated timestamps. Once sorted by exchange timestamp, duplicates are either contiguous (easy to catch) or appear within a bounded window (bounded hash). `prepare` always sorts first.

---

## Pipeline

Each group (one table, one day) runs this pipeline:

```
[HEADER] → [READ × N] → [SORT × N] → [MERGE] → [DEDUP] → [WRITE]
```

- One READ + SORT actor per source file, all running concurrently.
- MERGE interleaves N sorted streams into one.
- DEDUP removes duplicates per table rules.
- WRITE flushes to a `.tmp` file; on success the orchestrator renames it to the final path.

---

## Data model

```typescript
type Action = 'partial' | 'insert' | 'update' | 'delete' | `partial:${string}`;

interface PreparedMessage {
  rows:      string[];   // raw CSV lines — rows[0] is the message-start row
  date:      string;     // _date_ field value (reception time, UTC ISO)
  action:    Action;
  timestamp: string;     // timestamp column value on message-start row, or ''

  ts:   string;          // canonical sort key: timestamp.slice(0,23) || date.slice(0,23)
  tsMs: number;          // ts as epoch ms, computed once by READ via Date.UTC()
}
```

**`rows` are raw CSV strings**, not parsed objects. READ validates and normalises them into canonical form (via `arrayToCsv` for tables that need full RFC 4180 parsing, or raw `readline` for tables with no free-text fields). Downstream steps treat rows as opaque strings and write them directly.

**`ts` is data-driven.** If the row has a non-empty `timestamp`, `ts = timestamp.slice(0, 23)`. Otherwise `ts = date.slice(0, 23)`. This handles older files that predate the timestamp column. All sort and dedup comparisons use `ts`; no `Date` calls in hot paths.

**`tsMs`** is used only by MERGE for gap arithmetic. Computed once via `Date.UTC()` (pure positional arithmetic).

**`partial:SYMBOL`** — filtered partials, e.g. `partial:XBTUSD`. These are real-state-table partials that have been filtered by symbol at an earlier pipeline stage. They pass through DEDUP unconditionally, same as plain `partial`.

---

## HEADER

```typescript
writeOutputHeader(writer: Writer, tableName: string, day: string): void
```

Writes the CSV header row plus, for fixed-partial tables, a synthetic `partial` row at midnight of the group day.

**Fixed-partial tables:** `announcement`, `chat`, `connected`, `liquidation`, `publicNotifications`. These send a `partial` on every WS (re)connection but the body carries no useful state. Source partials are dropped in READ; HEADER writes one synthetic marker per day:

- `connected` → `<day>T00:00:00.000Z,partial,0,0,0` (zero counters)
- all others  → `<day>T00:00:00.000Z,partial,,,...` (empty values after `_action_`)

The `connected`-vs-other distinction is by table identity, not by column name — several tables share column names like `id` but those must be empty in their synthetics.

**Real-state tables:** `instrument`, `orderBookL2`. Partials carry full snapshots with exchange timestamps; they sort and write naturally. No synthetic partial.

HEADER looks up the column list itself via `getVaultColumns(tableName)`. The caller just passes `tableName` and `day`.

---

## READ

```typescript
async function* read(
  tableName: string,
  filePath:  string,
  onIssue:   (issue: ReadIssue) => void,
): AsyncGenerator<PreparedMessage[]>
```

Streams and validates a single `.csv.gz` source file. Emits batches of 20 000 messages.

**Parsing path — two options:**

Tables whose fields contain no free text (numbers, symbols, ISO timestamps) use `readline` for speed — raw lines, no field-count validation. Tables: `connected`, `instrument`, `liquidation`, `orderBookL2`.

All other tables (including `chat`, `announcement`) use `csv-parse` with `relaxColumnCount` to handle malformed rows without aborting the stream, followed by `arrayToCsv` to produce a canonical string representation.

**Per-message steps:**

1. Drop the first record if it is a header row (`_date_` in position 0).
2. Group rows into messages: a row not starting with `,` is a message-start; rows starting with `,` are continuation rows (multi-row payloads like large `insert` snapshots).
3. On field-count error (csv-parse path): discard the current message, report to `onIssue`, skip to next message-start.
4. Validate `_date_` and `_action_` with ISO regex. Drop entire message on failure.
5. Validate `timestamp` on every row where the column exists and the value is non-empty.
6. For fixed-partial tables: drop any message with a `partial` or `partial:*` action.
7. Compute `ts` and `tsMs`.
8. Yield batch when 20 000 messages accumulate.

---

## SORT

Runs as a background actor per source, consuming from READ and producing sorted minute-buckets for MERGE.

**Sort key:** `msg.ts` (23-char ISO string). Bucket key: `msg.ts.slice(0, 16)` (minute resolution). Ties within a bucket are resolved by stable sort: READ emits messages in source-file order, which is `_date_` order, so insertion order is the natural tiebreaker.

**Lazy sort:** each bucket tracks whether incoming messages arrive in non-decreasing `ts` order. If they do (as they almost always do for BitMEX data), eviction skips the sort call entirely.

**Eviction:** when total buffered messages across all buckets exceeds 50 000, the oldest minute-bucket is evicted to the outbound queue — sorted on eviction.

**Flush:** on end-of-source, remaining buckets are flushed in chronological key order (`[...order].sort()` — lexicographic on ISO strings equals chronological).

**Actor wiring (`createSourceActor`):**

```
[READ actor] ──inbound (cap 30k)──▶ [SORT actor] ──outbound (cap 25k)──▶ [MERGE]
```

Both actors run as detached async tasks. `BoundedQueue` provides backpressure: when outbound fills, SORT pauses; when inbound fills, READ pauses; OS I/O stops. With one actor pair per source file, all files are read concurrently by libuv.

---

## MERGE

```typescript
async function* merge(
  sources:    AsyncGenerator<PreparedMessage[]>[],
  tableName:  string,
  onComplete: (contributedBySource: number[]) => void,
): AsyncGenerator<PreparedMessage[]>
```

N-way gap-aware merge. Sources are already sorted upstream. MERGE does not re-sort.

**Gap threshold** — from `potentialGapThresholdMs(tableName)`:
- `instrument`, `orderBookL2` (have a `timestamp` column, not fixed-partial) → **1 ms**
- all other tables → **60 000 ms**

**Algorithm:**

1. Pick the initial active source: lowest head `tsMs` (priority — index 0 — breaks ties).
2. Emit the head message of the active source.
3. If the active source's next head is within `gapThreshold` ms → stay on it.
4. Otherwise: drain every source of messages at or before `message.tsMs` (covered range — they are duplicates of what the active source already emitted). Then switch to the source with the lowest remaining head `tsMs`.

After a gap, the new source is the one **closest in time**, not the highest-priority one with any valid head. Priority only breaks exact `tsMs` ties. This is the gap-fill behaviour: a lower-priority source with a closer next message wins when the active source has a gap.

**Drain condition:** `head.tsMs <= message.tsMs` — drops messages at or before the last emitted timestamp, keeps everything after. Messages from the gap-filling source that are strictly after the last emitted timestamp are kept.

---

## DEDUP

```typescript
async function* dedup(
  source:    AsyncGenerator<PreparedMessage[]>,
  tableName: string,
  onDrop:    (msg: PreparedMessage) => void,
): AsyncGenerator<PreparedMessage[]>
```

Per-table dedup driven by `TABLE_CONFIG` inside `deduper.ts`. Partials (plain and `partial:SYMBOL`) always pass through — they are never a duplicate.

**Content key:** the joined CSV rows with `_date_` stripped (everything from the first comma onward). Two messages with the same exchange content but different reception times (`_date_`) are identical for dedup purposes.

**Per-table config:**

| Table | insert / delete | update |
|-------|----------------|--------|
| announcement, publicNotifications, liquidation | global hash, no window | global hash, no window |
| chat | global hash, no window | global hash, drop if seen within 10 s |
| instrument | global hash, no window | contiguous (last only), no window |
| orderBookL2 | bounded key store (100), no window | contiguous (last only), no window |
| connected | — (never occurs²) | contiguous (last only), drop if seen within 15 s |

² connected has no insert or delete. Its state is a single object maintained entirely through updates; the initial state arrives via `partial` (dropped by READ, replaced by a synthetic midnight marker).

**Why contiguous for instrument/orderBookL2 updates:** same-ms oscillations are real events and must not be over-dropped. Only strictly adjacent identical updates are dupes.

**Why bounded key store (100) for orderBookL2 inserts:** ghost subscription dupes are non-adjacent. Two source streams interleave at the same ms:

```
S1.E1: insert X
S1.E2: insert Y
S2.E1: insert X   ← ghost dup of S1.E1, but S1.E2 is between them
```

Since timestamp is part of the content key, dupes only exist within a single ms cluster. `limit=100` covers the largest realistic cluster without unbounded memory.

**Why 15 s window for connected:** connected state is a single object (bots, users, connections) that changes via updates only. Two consecutive snapshots with no state change between them are content-identical but both legitimate — the second must not be dropped. Ghost-sub dupes arrive within ms of each other; real snapshots repeat every ~30 s. The 15 s window drops the ms-apart ghost while letting the next real snapshot through regardless of whether its content changed.

**Why 10 s window for chat:** different sources may have seconds of lag between them (not just ms as in ghost subs). The 10 s window covers cross-source duplicates that slip through MERGE.

**Key store internals** (`createKeyStore`):
- `limit = 1` → `lastKeyStore`: holds the single most-recent key. Used for contiguous dedup and connected's window-constrained update check.
- `limit > 1` → rotating dual-set store: `current` and `next` sets swap when `current` reaches `limit`. The old `current` becomes `next` and lives until the following rotation. Size guarantee: min `limit`, max `2 × limit` entries retained. For tables with `globalLimit = Infinity`, the store never rotates and acts as a true global key store.

---

## WRITE

```typescript
async function write(
  source: AsyncGenerator<PreparedMessage[]>,
  writer: Writer,
): Promise<{ written: number }>
```

Consumes the post-DEDUP stream and writes all messages to the gzip writer. Each batch is flushed via a single `writer.writeMessages()` call; the writer's promise chain serialises output ordering while returning immediately, so WRITE keeps consuming without blocking on disk I/O.

The `.tmp` → rename dance is the orchestrator's responsibility, not WRITE's.

---

## Orchestrator (`run.ts`)

`runPrepare` calls `resolveSourceFiles` to turn the path argument into a flat list of `.csv.gz` files, then groups them into `PrepareGroup` records by `(folder, day)`.

With `-C 1` (default): groups are processed sequentially in the same process. With `-C ≥ 2`: delegates immediately to the subprocess orchestrator (`orchestrator.ts`) and returns.

Per group (C=1 path):
1. Skip if `prepared/YYYYMMDD.csv.gz` or its `.tmp` already exists.
2. Wire the pipeline, drive it to completion, rename `.tmp` → final path.
3. Write per-group and command logs.

**Pipeline wiring:**

```typescript
const sources = group.paths.map((sourcePath, i) =>
  createSourceActor(group.tableName, sourcePath, onIssue, count => { readCounts[i] = count; }),
);

await write(
  dedup(
    merge(sources, group.tableName, contribs => { ... }),
    group.tableName,
    onDrop,
  ),
  writer,
);
```

All table-specific behaviour (gap threshold, dedup rules, partial handling, parsing path) is resolved inside the steps themselves from `tableName`. The orchestrator passes no strategy objects or config structs.

---

## Subprocess orchestrator (`orchestrator.ts`)

Active when `-C ≥ 2`. Holds at most C children running at any time — each free slot spawns a `tools sources prepare <bucket-path>` child process for the next pending file. Files are not pre-distributed: the pool stays at capacity until the queue drains.

Each child process is an independent run of the same binary with `-C 1` (default). It handles its own log setup, preflight, and pipeline. The parent process inherits all child stdout/stderr (`stdio: 'inherit'`), so both appear in the terminal.

**Flag forwarding:** `-D`, `--from`, and `--log` are forwarded to each child. `-C` is not (children always run single-process). `LOG_LEVEL` is inherited via environment.

**Shared log file:** all children append to the same `<dir>/prepare.log` (and `<dir>/debug.log`). Each per-bucket section is written in a single `appendFileSync` call, which Linux's `O_APPEND` mode keeps atomic up to PIPE_BUF (4 KB). Clean buckets are well under that; very noisy buckets (hundreds of validation drops) can exceed it and may interleave on some filesystems — accepted as a rare and minor tradeoff.

---

## File discovery (`discover.ts`)

`resolveSourceFiles(absPath)` turns the path argument into a sorted list of absolute `.csv.gz` file paths. It matches the path against these patterns in order:

| # | Pattern | Validation | Files collected |
|---|---------|------------|-----------------|
| 3 | `<table>/<YYYY>/(\d{1-8}\|YYYYMMDD.csv.gz)` | year dir must exist | files with matching day prefix, or single exact file |
| 4a | `<table>/\d{1-3}` | table dir must exist | all `.csv.gz` in year subdirs starting with that prefix |
| 4b | `<table>/\d{4}` | year dir must exist | all `.csv.gz` directly inside |
| 5 | `<table>` | table dir must exist | all `.csv.gz` in all year subdirs |
| 6 | any other path | path must be a dir | KNOWN_TABLES direct children only, then each child's year subdirs |

`<table>` refers to one of the 7 known BitMEX table names (`KNOWN_TABLES`). Patterns 3–5 are recognised by matching path components against that set.

`prepared/` subdirectories are never entered — pattern matching targets year dirs directly, and listing within year dirs filters for `*.csv.gz` files only.

The `--from` filter is applied centrally in `resolveSourceFiles` after collection. Empty result (`[]`) is not an error.

**Group assembly** (`utils/discover.ts`): files are grouped by `(parentDir, day)`. Within each group, files are sorted by stem priority so `YYYYMMDD.csv.gz` (bare) precedes `YYYYMMDD.a.csv.gz`, `YYYYMMDD.overflow-SOURCEDAY.csv.gz`, etc. (sort strips the `.csv.gz` extension to preserve this ordering). Output path is always `<parentDir>/prepared/YYYYMMDD.csv.gz`.

**Table name** is derived by walking path components upward for the first `KNOWN_TABLES` match; falls back to the folder basename.

**Overflow files** (`YYYYMMDD.overflow-SOURCEDAY.csv.gz`) are valid sources for subsequent runs. The day prefix groups them correctly on re-run.

---

## Logging

Three tiers, mutually exclusive between tiers 2 and 3:

**Tier 1 — stdout** (always): terminal output — progress lines, result summary, warnings.

**Tier 2 — command log** (`--log <dir>`): two files written to `<dir>/`:
- `prepare.log` — per-group sections appended as they complete: per-source read counts, merge contributions, dedup drops by action, malformatted rows.
- `debug.log` — verbose internal events, written only when `LOG_LEVEL=debug` is also set.

**Tier 3 — bucket logs** (when `--log` is absent): `prepared/YYYYMMDD.log` written next to each output file. Human-readable: sources, written count, dedup drop count, validation drop sample (capped at 50).

**With `-C ≥ 2`:** all children share the same `<dir>/prepare.log` (and `<dir>/debug.log`). Linux's atomic-append guarantee covers per-bucket sections under 4 KB; larger sections may interleave on rare noisy buckets.

---

## Table config reference (`tables.ts`)

| Function | Returns | Tables |
|----------|---------|--------|
| `hasFixedPartials` | `true` | announcement, chat, connected, liquidation, publicNotifications |
| `allowsSimplifiedParsing` | `true` | connected, instrument, liquidation, orderBookL2 |
| `potentialGapThresholdMs` | `1` | instrument, orderBookL2 |
| `potentialGapThresholdMs` | `60000` | all others |

---

## File structure

```
dev/tooling/src/tools/sources/
  discover.ts             — resolveSourceFiles: path pattern matching, file collection
  tables.ts               — table config (columns, fixed partials, parsing path, gap threshold)

  prepare/
    run.ts                — entry point: resolves files, sequential pipeline (C=1)
    orchestrator.ts       — subprocess pool for C≥2: slot management, child spawning
    types.ts              — PreparedMessage, DedupConfig, DedupStore, ReadIssue, etc.

    tasks/
      reader.ts           — READ: parse, validate, emit PreparedMessage batches
      sorter.ts           — SORT: minute-bucket accumulator + BoundedQueue + actor wiring
      merger.ts           — MERGE: N-way gap-aware merge + Peekable adapter
      deduper.ts          — DEDUP: per-table store config, hash store implementations
      header.ts           — HEADER: CSV header row + synthetic midnight partial
      writer.ts           — WRITE: consume stream, flush to gzip writer

    utils/
      discover.ts         — group assembly from file list, filename priority sort
      preflight.ts        — skip-or-proceed decision per group
      report.ts           — per-group log, command log, terminal result summary
```

---

## CLI

All flags below are declared on the `sources` parent command and apply to every subcommand (`prepare`, `check`, future `sync`).

```
tools sources [flags] prepare [path]

Flags:
  -D, --dry-run           Run the full pipeline but do not write any output files
  --from <date>           Skip files before this date (YYYYMMDD or YYYY-MM-DD)
  --log [dir]             Write command logs to <dir>/; default dir is cwd
  -C, --concurrency <n>   Number of buckets to process in parallel (default: 1)
```

**`path`** is optional; defaults to `$VAULT_DATA_DIR`. Relative paths are joined with `$VAULT_DATA_DIR`. The accepted patterns are:

```
<table>                                 all years, all buckets
<table>/<YYYY>                          one year, all buckets
<table>/<YYYY>/<prefix>                 buckets whose filename starts with <prefix>
<table>/<YYYY>/YYYYMMDD.csv.gz          a single exact file
<base>                                  any dir whose direct children include KNOWN_TABLES
```

`prepare` only creates new files and never modifies originals. To re-run a group: delete `prepared/YYYYMMDD.csv.gz` (and `.log` if desired) and run again.
