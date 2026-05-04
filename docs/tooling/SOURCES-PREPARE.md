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

1. Discovers source groups with `collectLeafFolders` + `discoverGroups`.
2. Skips any group where `prepared/YYYYMMDD.csv.gz` or its `.tmp` already exists.
3. Per group: wires the pipeline as a chain of async generators, drives it to completion, writes per-group and command logs.

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

## Discovery (`utils/discover.ts`)

Groups source files by day prefix. File sort order is priority order for MERGE: `YYYYMMDD.csv.gz` (bare) sorts before `YYYYMMDD.a.csv.gz`, `YYYYMMDD.overflow-YYYYMMDD.csv.gz`, etc. The sort strips the `.csv.gz` extension before comparing to preserve this ordering (without stripping, `.a.` < `.c` at the first differing character would reverse it).

Table name is derived by walking path components upward and matching against `KNOWN_TABLES`; falls back to the folder basename.

**Output location:** `<source-folder>/prepared/YYYYMMDD.csv.gz`. `collectLeafFolders` skips `prepared/` subfolders when the parent contains `.csv.gz` files, so no explicit exclusion is needed.

**Overflow files** (`YYYYMMDD.overflow-SOURCEDAY.csv.gz`) are valid sources for subsequent runs. The day prefix groups them correctly on re-run.

---

## Logging

**Per-group log** (`prepared/YYYYMMDD.log`): human-readable. Sources, written count, dedup drop count, validation drop sample (capped at 50).

**Command log** (`prepare.log`, appended): machine-auditable. Per-source read counts, per-source merge contributions (only shown when >1 source), dedup drops broken down by action, all malformatted rows.

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
  tables.ts               — table config (columns, fixed partials, parsing path, gap threshold)

  prepare/
    run.ts                — orchestrator: discovery, pipeline wiring, logging
    types.ts              — PreparedMessage, DedupConfig, DedupStore, ReadIssue, etc.

    tasks/
      reader.ts           — READ: parse, validate, emit PreparedMessage batches
      sorter.ts           — SORT: minute-bucket accumulator + BoundedQueue + actor wiring
      merger.ts           — MERGE: N-way gap-aware merge + Peekable adapter
      deduper.ts          — DEDUP: per-table store config, hash store implementations
      header.ts           — HEADER: CSV header row + synthetic midnight partial
      writer.ts           — WRITE: consume stream, flush to gzip writer

    utils/
      discover.ts         — group discovery, filename priority sort, table name detection
      log.ts              — per-group log, command log, terminal result summary
```

---

## CLI flags

```
sources prepare [path]
  -D, --dry-run         Scan and report only; do not write output
  --from <date>         Skip groups before this date (YYYYMMDD or YYYY-MM-DD)
  --log <dir>           Write log files into this directory (default: group's prepared/ folder)
```

`prepare` only creates new files and never modifies originals. To re-run a group: delete the corresponding `prepared/YYYYMMDD.csv.gz` (and `.log` if desired) and run again.
