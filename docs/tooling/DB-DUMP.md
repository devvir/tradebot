# db dump

`tools db dump <args>` exports MongoDB collections to gzipped cold-storage archives, optionally backed up to Mega in the same run. Uses the official `mongodump` CLI under the hood — one BSON+gz archive per (collection, date) pair.

The arg parser is shared with `db stats` and `db purge`: numeric date-shaped args become date filters, everything else is a collection name, `all` is the keyword for "every collection in the DB".

---

## Argument grammar

```
tools db dump <arg>...
```

Each arg is one of:

| Form | Meaning |
|---|---|
| `2026`, `202504`, `20240315` | Date filter (year, year-month, day). Dashes optional: `2024-03-15` ≡ `20240315`. |
| `all` | Expand to every collection in the database. |
| anything else | Collection name. Unknown names trigger a warning and are skipped. |

Args resolve to **pairs**: the cartesian product of collections × dates. No dates → one pair per collection with no filter (whole collection). At least one arg is required — `db dump` with no args prints help; it will never dump the full database silently.

**Examples:**

```
db dump quote 2024 2025                # quote × {2024, 2025} → 2 pairs
db dump 2024                           # every collection × 2024 → N pairs
db dump all 2014 2015                  # every collection × {2014, 2015}
db dump quote                          # whole quote collection (no date filter)
```

---

## Filtering — _id encoding

Date filters become `_id` range queries via the vault `_id` encoding (`@tradebot/utils/startOfDayMongoId`). For `YYYY` → entire calendar year; `YYYYMM` → entire month; `YYYYMMDD` → single day. The resulting query is `{_id: {$gte: startOfDay(start), $lt: startOfDay(endExclusive)}}` — no timestamp field is ever used.

Only collections whose `_id` is vault-encoded (the BitMEX `farmer` tables) will filter sensibly. Date-filtering a collection with ObjectId or non-numeric `_id` will produce empty results.

---

## Output layout

```
<DB_DUMP_DIR>/
  <collection>/
    <date-key>.archive.gz       ← mongodump --archive --gzip output
  ...
  dump.log                       ← append-only run log
```

`<date-key>` is the dashless date (`2024`, `202503`, `20240315`) or `all` for no-date pairs. Each `.archive.gz` is a mongodump archive (BSON + metadata, native gzip) — readable by `mongorestore --gzip --archive=<file>`.

`--out <dir>` overrides `DB_DUMP_DIR` for a single run.

---

## Execution flow

1. **Parse args** → dates, collection names, `all` flag.
2. **List DB collections** via `db.listCollections()`.
3. **Build pairs** (cartesian product).
4. **Existing check** — for every pair, check whether the destination `.archive.gz` already exists locally and/or on Mega. One `mega-ls` per unique collection, run in parallel.
5. **Prompt to skip existing** (default Y). Skipped pairs are dropped before counting.
6. **Count** — `gatherRows()` uses the shared `estimateRangeCount` to get a fast approximate doc count per surviving pair; one shared `$collStats` per collection gives `avgObjSize` for the size estimate.
7. **Plan table** — collection × period × ~docs × ~size, total row at bottom.
8. **Confirm** (default Y).
9. **Append to `dump.log`** — timestamp, args, skipped pairs (with `local`/`mega` markers), the plan table.
10. **Execute** — parallel pool of `mongodump` subprocesses (see below).
11. **Mega upload prompt** (if `DB_DUMP_MEGA_DIR` set) — uploads each `.archive.gz` via `mega-put -c`.

---

## mongodump invocation

For each pair, the worker spawns:

```
mongodump --uri=$DB_URL --db=$DB_DATABASE --collection=<coll> \
          --query='{"_id":{"$gte":<startId>,"$lt":<endId>}}' \
          --archive=<DB_DUMP_DIR>/<coll>/<date-key>.archive.gz \
          --gzip --quiet
```

For no-date pairs, `--query` is omitted.

stderr is parsed for progress lines (`done/total (pct%)`) which are forwarded to a throttled (one line per pair per 30s) console update. The final doc count is captured from either the last progress line or the `done dumping … (N documents)` summary.

---

## Concurrency

`N` mongodump subprocesses run in parallel via a worker pool. As one finishes, the next queued pair starts. Default: **4**. Override via `DB_DUMP_CONCURRENCY=<N>` in `dev/tooling/.env`.

Tuning: each worker consumes a mongo cursor and roughly one CPU core for compression. 4 is a safe default; 8 saturates an 8-core box. Going higher rarely helps once mongo's cursor read becomes the bottleneck.

---

## Mega upload

After all pairs complete, if `DB_DUMP_MEGA_DIR` is set, the tool prompts to upload each `.archive.gz` to `<DB_DUMP_MEGA_DIR>/<collection>/<date-key>.archive.gz` via `mega-put -c`. Failures are logged but don't abort the run.

The existing check (step 4) uses the same path on Mega, so re-running after a successful upload will offer to skip everything already there.

---

## dump.log format

Plain ASCII, append-only, one entry per confirmed run. Safe to `tail -f`.

```
════════════════════════════════════════════════════════════════════════
2026-05-23 12:00:00Z  —  dump  —  args: quote 2014 2015
output: /storage/bitmex/dumps

skipped (1):
  quote/2014.archive.gz  (local + mega)

Collection  Period   ~ Documents   ~ Size
─────────────────────────────────────────
quote       2015      8,234,567   780.5MB
─────────────────────────────────────────
Total       1 pair    8,234,567   780.5MB
```

Written once, immediately after the user confirms the proceed prompt. No entry is logged for aborted runs.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DB_URL` | yes | MongoDB connection URI (passed to mongodump via `--uri`). |
| `DB_DATABASE` | yes | Database name (passed via `--db`). |
| `DB_DUMP_DIR` | no | Output directory. Default `./db-dump`. Override per-run with `--out`. |
| `DB_DUMP_MEGA_DIR` | no | Mega base path for backups. If unset, upload prompt is skipped and existing-on-mega checks return false. |
| `DB_DUMP_CONCURRENCY` | no | Number of parallel mongodump workers. Default `4`. |

---

## Flags

| Flag | Description |
|---|---|
| `-o, --out <dir>` | Override `DB_DUMP_DIR` for this run. |

---

## External dependencies

| Tool | Purpose | Required |
|---|---|---|
| `mongodump` | The actual export. Part of MongoDB Database Tools (`mongodb-database-tools` package). | yes |
| `mega-put` | Upload to Mega. From `mega-cmd`. | only if `DB_DUMP_MEGA_DIR` is set |
| `mega-ls` | Existence check on Mega. From `mega-cmd`. | only if `DB_DUMP_MEGA_DIR` is set; gracefully degrades if missing |

---

## Restoring a dump

```
mongorestore --uri=$DB_URL --db=$DB_DATABASE --gzip \
             --archive=/storage/bitmex/dumps/quote/2024.archive.gz
```

Each archive contains its own collection name and metadata, so `mongorestore` recreates the target collection automatically. Use `--nsTo` / `--nsFrom` to restore into a different collection name if needed.
