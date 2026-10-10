# data resort

`data resort` reads collected (non-WS) flat `.csv.gz` buckets and rewrites each as a timestamp-major, canonically-timestamped copy `<name>.resorted.csv.gz` beside the original. It never mutates the source, is safe to run on already-correct files (they are detected and clean-copied), and is idempotent (a file whose `.resorted` sibling exists is skipped).

---

## Why it exists

Some collected buckets are stored **symbol-major** — grouped by symbol, each symbol's rows time-sorted within its block — rather than **timestamp-major** — all symbols interleaved in one global time order:

- **BitMEX public S3 daily buckets** (`courier`): sorted by `symbol`, then `timestamp`. The pre-pool trade history (2014 → pool rollout) and any future S3 fetch.
- **REST `quote`** (`scribe`): paginated per symbol, so symbol-major.
- **REST `trade`** (`scribe`): already globally timestamp-sorted — no reordering.
- **WS** collection (from 2026-07-15): written in arrival order, natively timestamp-major — no reordering.

The database is a **replay source**: to stream a bucket back out as a live WS feed it must be in global timestamp order. Symbol-major data cannot be replayed chronologically without re-sorting, so we sort **once, at import time**, not on every replay.

Timestamps also arrive in two shapes. S3 uses `2026-04-01D19:58:24.219584` (`D` separator, microseconds, no zone); REST/WS use canonical `2026-04-01T00:00:00.402Z` (`T` separator, milliseconds, `Z`). The import target is one canonical form, so resort normalizes as it goes.

`resort` handles **flat tables only** — one CSV line per record, keyed by a `timestamp` column. WS-structured files (first column `_date_`) are message-shaped: continuation rows carry no timestamp, so line-level sorting would tear messages apart. Those are skipped; message-aware processing is [`data prepare`](DATA-PREPARE.md)'s domain.

---

## Pipeline

Each candidate file runs a read-only **verdict** pass that picks one of three tiers, doing no work when none is needed:

```
[VERDICT] → copy            (already sorted + canonical)
          → normalize       (sorted, non-canonical timestamps)
          → normalize + sort (not timestamp-sorted)
```

- **copy** — the source is already the desired artifact; duplicate it byte-for-byte.
- **normalize** — a single streaming pass rewrites the timestamp column; row order is untouched.
- **sort** — normalize, then an external timestamp sort.

Tiers 2 and 3 verify the finished output (row count read back from the artifact) before the `.tmp` is renamed. Tier 1 checks the copied byte size.

---

## VERDICT

A single `awk` pass (`VERDICT_AWK`) streams every data row, normalizes its timestamp in-memory, and tracks two facts:

- **canonical?** — did any timestamp change under normalization.
- **sorted?** — did any *normalized* key sort below its predecessor. It exits on the first out-of-order row.

Comparing **normalized** keys is what makes the check sound: a raw-string comparison could be fooled by mixed fractional widths (`…1.5` vs `…1.100`), but the normalized keys are fixed-width, so lexical order is chronological.

The tier is encoded in the awk exit code, chosen once in `END`:

| exit | meaning |
|------|---------|
| 0 | sorted + canonical → **copy** |
| 3 | sorted, non-canonical → **normalize** |
| 2 | not sorted → **sort** |
| 4 | malformed timestamp → **abort the run** |

A malformed timestamp anywhere aborts before anything is written for that file — bad data is surfaced for inspection, not papered over.

---

## Normalization

Operates on the `timestamp` field only (its column index is read from the header, not assumed to be column 0); every other byte is preserved.

```
YYYY-MM-DD [D|T] HH:MM:SS [.frac] [Z]   →   YYYY-MM-DDTHH:MM:SS.mmmZ
```

- separator `D` or `T` → `T`
- fractional part truncated to its first 3 digits (microseconds → milliseconds), right-padded to 3, `.000` when absent
- always terminated with `Z`

Truncation is monotonic, so global order is preserved; the stable sort keeps sub-millisecond input order within a truncated millisecond. `NORMALIZE_AWK` also prints the data-row count to stderr for the in == out invariant.

---

## Sort

Tier 3 pipes `zcat → awk (normalize, header dropped) → sort → pigz`, with the header written straight to `pigz` ahead of the sorted body. The sort is:

```
LC_ALL=C sort -t, -k<ts>,<ts> -s -S 1G -T <source folder>
```

GNU `sort`'s own external merge-sort supplies the memory and scale properties for free:

- **`-S 1G`** caps in-memory size: it sorts chunks, spills sorted runs to disk, then k-way merges them. Peak memory is bounded by `-S`, independent of the (multi-GB) file — the same path survives `orderBookL2` later.
- **`-T <source folder>`** keeps spill files in the working folder (visible during the run, removed by `sort` on completion), never in the small `/tmp` partition.
- **`-s`** (stable) keeps rows sharing a truncated millisecond in input order.
- **`LC_ALL=C`** makes lexical order chronological on the canonical fixed-width keys.

All stages are spawned and piped directly from node — no shell in the middle. Each stage's exit promise is captured at spawn time, so a stage that finishes before the pipeline is fully wired (tiny inputs) is not missed; EPIPE on a stage whose downstream exited early (verdict fast-fail) is swallowed, with real failures surfaced through exit codes.

Stage completion is the child's **`exit` event, not `close`**: `close` additionally waits for the child's stdio streams to drain, and a stage whose downstream died early (verdict fast-fail) exits with undrained buffered stdout — its `close` never fires. Awaiting `close` there left the run's promise chain pending with no live handles, so node's event loop drained and the process exited 0 mid-loop, silently abandoning the remaining files. Exit codes are all the pipeline consumes from these promises; stream completeness is proven independently (collected stream `end` events and the read-back row-count verification).

---

## Verification

For the normalize and sort tiers, the finished `.tmp` is read back with `zcat | wc -l`: total lines must equal `header + expected data rows` (the count `awk` reported). Decompressing the whole artifact also proves gzip integrity. Only then is `.tmp` renamed to `<name>.resorted.csv.gz`; on any failure the `.tmp` is removed and the source is untouched.

The invariant is strong for the sort tier: since a canonical source is only permuted, the output must contain exactly the input rows — verified in practice by hashing the sorted row-multisets of source and output (identical).

---

## File selection

Discovery reuses the shared `resolveCsvGzFiles`, passing resort's own table set (`RESORT_TABLES` = the WS tables plus `trade`, `quote`, `tick`, `compositeIndex`) instead of the default `KNOWN_TABLES`, so the extension is local to resort and other subcommands' discovery is unchanged. `--from` is honored.

A `.csv.gz` file is a candidate (`isResortCandidate`) when:

- it is a **suffixed source** (`YYYYMMDD.<suffix>.csv.gz`) — sources always carry a source suffix; plain `YYYYMMDD.csv.gz` files are built buckets and are ignored, and
- it is **not** itself a `.resorted.csv.gz` output, and
- no `.resorted` sibling already exists (idempotent re-runs; an aborted run resumes cleanly).

`.tmp` files are excluded automatically — they do not end in `.csv.gz`. Files whose header first column is `_date_` (WS-structured) or that lack a `timestamp` column are skipped with a warning.

---

## Output & safety

- **Never mutates the source.** Output is a sibling `<name>.resorted.csv.gz`.
- **In progress** it is `<name>.resorted.csv.gz.tmp`; the external sort's spill files live in the same folder. All intermediates are visible during the run and gone after it.
- **The operator deletes originals manually** once satisfied — resort leaves that to you, mirroring the raw-sources vs prepared-buckets split (`data prepare`): originals are archived as sources; resorted files become the vault buckets the DB imports.

---

## File structure

```
dev/tooling/src/tools/data/
  discover.ts             — resolveCsvGzFiles(absPath, tables?): shared discovery, table set now injectable
  tables.ts               — KNOWN_TABLES, vault column lookup

  resort/
    run.ts                — entry point (runResort), verdict/normalize/sort/copy tiers, verification, stage plumbing
    types.ts              — ResortTier, ResortOutcome, FileResult, Stage
```

---

## CLI

All flags are declared on the `data` parent command.

```
tools data [flags] resort [path]

Flags:
  -D, --dry-run   Report the verdict per file; write nothing
  --from <date>   Skip days before this date (YYYYMMDD or YYYY-MM-DD)
```

**`path`** is optional; defaults to `$VAULT_DATA_DIR`. Relative paths are joined with it; absolute paths are used as-is. Point it at a table, a year, or a single file:

```bash
tools data resort quote -D                 # dry-run: verdicts only
tools data resort quote/2026
tools data resort trade --from 2026-04-01
tools data resort quote/2026/20260414.primary.csv.gz
```

---

## Context: trade/quote history rebuild

`resort` is the unblocked foundation of a one-time trade/quote history rebuild:

1. Download S3 trade/quote from 2014 (pre-pool; S3 for pooled dates is inspection-only — it lacks the `pool` field).
2. `data resort` all suffixed source buckets.
3. One-time merge of `.primary` + `.secondary` (per table; secondary begins **trade 2026-04-16**, **quote 2026-04-14**) into pooled vault buckets — a throwaway step, not a permanent subcommand; the fallback is re-fetching unfiltered from REST.
4. Drop trade/quote collections and all bins — only after the vault bucket set is built and verified.
5. Reimport trade/quote and redistill bins from the start (gated on farmer's Secondary→separate-DB routing, which keeps the main DB non-pooled + Primary only).

End state: trade/quote timestamp-sorted across their whole history in the DB; originals archived as sources in Mega, resorted files in the vault. From 2026-07-15 collection is WS (natively sorted). If BitMEX adds the `pool` field to S3, `courier` resumes and `data resort` is applied before import.

Adjacent future work (not this tool): `data prepare` must learn the WS-collected flat tables — `trade`/`quote`/`tick` are now collected over WS but stored vault-side as flat REST-like rows (no `_date_`/`_action_`), so they need merging and sorting through a flat-table path prepare does not yet have. Note the `contentKey` over-dedup gotcha there: `quote` has no unique id, so a dedup key must retain the exchange `timestamp` (unlike WS tables, whose first column is `_date_`).
