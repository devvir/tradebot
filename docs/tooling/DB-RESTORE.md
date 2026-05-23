# db restore

`tools db restore <args>` re-imports `mongodump` archives back into MongoDB. Pulls anything missing from Mega first, then runs `mongorestore --gzip --archive=…` per matched file.

Same arg parser as [dump](./DB-DUMP.md), [purge](./DB-PURGE.md), [stats](./DB-STATS.md): collection names + date filters (`YYYY` / `YYYYMM` / `YYYYMMDD`, dashes optional) + the `all` keyword.

---

## Lookup is exact and unambiguous

| Arg form | Meaning |
|---|---|
| `db restore quote 2024` | look for exactly `quote/2024.archive.gz` (local + Mega) |
| `db restore quote 2024 2025` | look for `quote/2024.archive.gz` AND `quote/2025.archive.gz` |
| `db restore quote trade 2024` | cartesian: `quote/2024.archive.gz` + `trade/2024.archive.gz` |
| `db restore quote` | every archive under `quote/` (local ∪ Mega) |
| `db restore all 2024` | every collection × `2024.archive.gz` |

**No partial matches.** `2024` does NOT match `202403` or `20240315`. If you want a year, you must have a year archive; if you want months, you must specify months.

### Overlap guard

After discovery, the targets are checked per collection for coarser-vs-finer overlap. If detected, the restore aborts before any work:

- `2024` × `202403` — year overlaps with one of its months
- `2024` × `20240315` — year overlaps with one of its days
- `202403` × `20240315` — month overlaps with one of its days
- `all` × anything — `all` overlaps with any dated archive

The user is expected not to produce overlapping dumps in the first place; this is a safety net, not a feature. To fix, remove one side of the conflict (locally or on Mega) and retry.

---

## Execution flow

1. **Parse args** → `Pair[]` (collection × date).
2. **Discover** — for each pair:
   - dated pair → exact filename lookup
   - bare collection → list its dir in local AND Mega, emit one target per archive matching `(all|YYYY|YYYYMM|YYYYMMDD).archive.gz`
3. **Overlap check** → abort if any conflict.
4. **Plan table** with source (`local` / `mega` / `both`), size, status (`ready` / `download needed` / `⚠ size mismatch (prefer local)`).
5. **Size-mismatch warning**: if a target exists in both with different sizes, the local copy wins. The user is told to delete the local file and re-run if Mega is the correct version. Confirm defaults to **N** when mismatches are present, **Y** otherwise.
6. **Disk-space pre-flight**: compares free space in `DB_DUMP_DIR` against the bytes to pull from Mega:

   | Ratio (free ÷ to-download) | Behaviour |
   |---|---|
   | `< 1` | reject — print error, abort |
   | `< 2` | warn + offer download-only fallback (default **N**); if accepted, skip the import step entirely so the user can re-run after freeing space |
   | `< 3` | warn that it may be tight, then standard confirm |
   | `≥ 3` | proceed silently |

   Skipped when nothing needs to be downloaded.
7. **Download phase** — sequential `mega-get` for every target that's Mega-only (or where local is missing). Live progress polled from `mega-transfers` (same pattern as upload).
8. **Restore phase** — parallel pool of `mongorestore --gzip --archive=<path> --verbose` workers (default 4, override via `DB_RESTORE_CONCURRENCY`). Reuses the dump's `ProgressBlock` for the live multi-line status. Duplicate-key errors are ignored (mongorestore default behaviour; user assumed to know what they're doing). Skipped if the user picked the download-only fallback at step 6.
9. **Cleanup prompt** (default **N**) — offer to delete local archives, but only those whose Mega copy is **verified identical** (same byte size). Local-only files and size-mismatched files are held back with a per-file reason ("local only" or "size mismatch (local X, mega Y)"); they're never deleted by the tool, since doing so could leave the user with no usable backup or discard the version they explicitly chose. Mega copies are never touched.
10. **`restore.log`** appended to `<DB_DUMP_DIR>/restore.log` with timestamp, args, targets, results, removed files.

---

## mongorestore invocation

```
mongorestore --uri=$DB_URL --archive=<localPath> --gzip --verbose
```

No `--db` / `--collection` overrides — the archive carries its own db+coll metadata from the original `mongodump --db --collection`. If you dumped from `tradebot.quote`, you restore to `tradebot.quote`.

Verbose stderr is parsed for `<ns>  <count>` lines (the running document counter) and the `finished restoring … (N documents)` completion line. Same parser shape as the dump's mongodump wrapper.

---

## Output

```
ℹ Discovering archives in local + Mega…

Collection  Period       Source  Size    Status
─────────────────────────────────────────────────
quote       2024         local   1.2GB   ready
quote       2025         mega    800MB   download needed
trade       2024-03      both    500MB   ready
trade       2024-04      both    1.3GB   ⚠ size mismatch (prefer local)
─────────────────────────────────────────────────
Total       4 archives           3.8GB

⚠ 1 size mismatch (will prefer local — delete local first if you want Mega's copy):
  trade/202404.archive.gz   local: 1.2GB   mega: 1.3GB

? Restore 4 archives? (y/N)
```

After confirm — download phase, then parallel restore phase with the dump-style progress block at the bottom (one row per active worker). On completion:

```
✓ Restore complete — 4 archives imported
? Remove 4 restored archives from local? (y/N)
```

---

## restore.log format

Plain ASCII, append-only.

```
════════════════════════════════════════════════════════════════════════
2026-05-24 15:00:00Z  —  restore  —  args: quote 2024 2025
output: /storage/bitmex/dumps

targets (2):
  quote/2024.archive.gz  (local + mega, 1.2GB)
  quote/2025.archive.gz  (mega, 800MB)

results:
  ✓ quote/2024  204716976 docs in 320.5s
  ✓ quote/2025  223456789 docs in 351.2s
  total: 2 ok, 0 failed

removed from local (2):
  /storage/bitmex/dumps/quote/2024.archive.gz
  /storage/bitmex/dumps/quote/2025.archive.gz
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DB_URL` | yes | MongoDB connection URI (passed to mongorestore via `--uri`). |
| `DB_DATABASE` | no | Only used for the quick connectivity check before kicking off workers. The actual restore targets the db baked into the archive. |
| `DB_DUMP_DIR` | no | Where archives live locally and where `restore.log` is written. Default `./db-dump`. |
| `DB_DUMP_MEGA_DIR` | no | Mega base path for download lookups. Unset → discovery only checks local; targets that need Mega are flagged as `NOT FOUND`. |
| `DB_RESTORE_CONCURRENCY` | no | Parallel mongorestore workers. Default `4`. |

---

## External dependencies

| Tool | Purpose | Required |
|---|---|---|
| `mongorestore` | The actual import. Part of MongoDB Database Tools. | yes |
| `mega-ls`, `mega-get` | Discover + download from Mega. From `mega-cmd`. | only if `DB_DUMP_MEGA_DIR` is set; missing CLI degrades to "local-only discovery". |
