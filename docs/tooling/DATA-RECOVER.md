# data recover

`data recover` verifies the integrity of `.csv.gz` files in the vault and salvages the ones that are corrupt. It is the repair step for files that fail to decompress — typically caused by an interrupted write or a bad transfer.

---

## What it does

For every `.csv.gz` resolved from the given path, in order:

1. **Test** — run `gzip -t`. A file that decompresses cleanly is left untouched and reported `OK`.
2. **Recover** — for a corrupt file, run `gzrecover` to salvage what it can.
3. **Prune** — trim the scrambled tail that `gzrecover` leaves behind.

Each file is announced before it is processed (`Checking <file> …`) and its result printed immediately after. Integrity testing a multi-GB file can take minutes, so this per-file feedback is the only signal that the run is alive.

---

## The recovered file

`gzrecover` emits the **decompressed content** — plain CSV text, not a gzip stream. The output is therefore written with a `.csv` extension, not `.csv.gz`:

```
20260411.local.csv.gz   →   20260411.local.recovered.csv
```

The original corrupt file is never modified or deleted. The `.recovered.csv` lands beside it for manual review.

---

## Tail pruning

`gzrecover` salvages as much as it can, but the bytes after the corruption point come out scrambled — the tail of the recovered CSV is almost always binary garbage rather than valid rows.

Pruning trims this:

1. Scan the recovered file for the **last line that begins with a valid ISO timestamp** (`YYYY-MM-DDTHH:MM:SS.mmmZ,` — the `_date_` field). `grep -aboE` reports the byte offset of every such line; the last one is the boundary.
2. `ftruncate` the file at that offset. This drops the last timestamped row **and everything after it** — the last good-looking row sits on the corruption boundary and is not trusted.

The scan streams `grep`'s output line by line, so a multi-GB file with millions of matches never buffers in memory.

If no timestamped line is found at all, the file is left untouched (not truncated to nothing) and a warning is printed — the recovery produced nothing usable.

Pruning is best-effort: a `gzrecover` success is always counted as recovered. A prune failure, or a file with no valid timestamp, is a warning only — it never downgrades the result to failed.

This is the **bare minimum** cleaning. The pruned `.csv` may still need further sanitising (dedup, sort, gap-fill) before use — that is the job of `data prepare`, not this command.

---

## Output

```
ℹ Checking /data/bitmex/vault/orderBookL2/2026/20260411.local.csv.gz …
✓   OK
ℹ Checking /data/bitmex/vault/orderBookL2/2026/20260412.local.csv.gz …
⚠   Corrupt
ℹ   Recovered & pruned → 20260412.local.recovered.csv

✓ Done. OK: 1. Corrupt: 1. Recovered: 1.
```

The summary line always reports `OK` / `Corrupt` / `Recovered` counts, plus `Failed to recover` when any `gzrecover` call failed outright.

---

## Flags

| Flag | Effect |
|---|---|
| `-D, --dry-run` | Test integrity and report corrupt files only — no `gzrecover`, no pruning. |
| `--from <date>` | Restrict to days ≥ this date (`YYYYMMDD` or `YYYY-MM-DD`). |
| `--log [dir]` | Mirror output to `<dir>/recover.log` (default `<cwd>`). |

---

## Path resolution

The path argument follows the same rules as the other `data` subcommands:

- omitted / empty → `VAULT_DATA_DIR`
- absolute path → used as-is
- relative path → joined with `VAULT_DATA_DIR`

It resolves to any set of `.csv.gz` files — a single file, a day, a year, a table, or the whole vault — sources and buckets alike.
