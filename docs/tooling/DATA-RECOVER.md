# data recover

`data recover` verifies the integrity of `.csv.gz` files in the vault and salvages the ones that are corrupt. It is the repair step for files that fail to decompress — typically a crash or hard restart that left a gzip member unclosed, so that appending the next member corrupted the boundary (an interrupted write or bad transfer does the same). Only the busiest tables (instrument, orderBookL2) tend to be hit, since they're the ones with a member open long enough to be caught mid-flush.

---

## What it does

For every `.csv.gz` resolved from the given path, in order:

1. **Test** — run `gzip -t`. A file that decompresses cleanly is left untouched and reported `OK`.
2. **Recover** — for a corrupt file, run `gzrecover` to salvage what it can.
3. **Sanitize** — drop every message touched by recovery garbage and keep all healthy ones (for free-text tables, which can't be field-validated, trim only the scrambled tail).

Each file is announced before it is processed (`Checking <file> …`) and its result printed immediately after. Integrity testing a multi-GB file can take minutes, so this per-file feedback is the only signal that the run is alive.

---

## The recovered file

`gzrecover` emits the **decompressed content** — plain CSV text, not a gzip stream. The output is therefore written with a `.csv` extension, not `.csv.gz`:

```
20260411.local.csv.gz   →   20260411.local.recovered.csv
```

The original corrupt file is never modified or deleted. The `.recovered.csv` lands beside it for manual review.

---

## Sanitizing

`gzrecover` salvages as much as it can, but a crash-unclosed gzip member leaves binary garbage at **every** recovered member boundary — not just the tail. Sanitizing removes it message by message so the healthy data on both sides of each garbage block survives.

A **message** is one logical record: a first row carrying a `_date_`, optionally followed by continuation rows that start with `,` (empty `_date_`). The recovered CSV is streamed and grouped back into messages, and a message is written to the output **only when every one of its rows is healthy**. A row is healthy when it is:

- **printable ASCII** — any byte outside `0x20–0x7e` is recovery garbage;
- the table's **exact column count**;
- carrying an **ISO `_date_`** on the message's first row (empty on continuation rows);
- carrying an **ISO `timestamp`** (for tables that have that column).

Any message containing a bad row is dropped whole — wherever it sits in the file — and the header row passes through verbatim. The column count and field positions come from the table's vault header, so the check is exact per table. Output is streamed with backpressure, so memory stays flat (single-message) regardless of file size; a day's `orderBookL2` is multi-GB.

The result is a clean `.recovered.csv` with a small hole exactly where each corruption block sat (typically a fraction of a percent of messages). That data is unrecoverable — the gzip garbage destroyed it — so dropping it is the correct outcome, not avoidable loss. Those holes are filled later when `data prepare` merges the multiple sources for the day.

**Free-text / unknown tables** (announcement, chat, …) can't be split on commas safely — their fields may contain commas, quotes, or newlines — so they fall back to **tail trimming**: scan for the byte offset of the last line beginning with a valid ISO `_date_` (`grep -aboE`, streamed) and `ftruncate` there, dropping that row and everything after it. If no timestamped line exists, the file is left untouched and a warning is printed.

Sanitizing is best-effort: a `gzrecover` success is always counted as recovered. A sanitize/trim failure is a warning only — it never downgrades the result to failed. The cleaned `.csv` may still need dedup, sort, and cross-source gap-fill before use — that is the job of `data prepare`, not this command.

---

## Output

```
ℹ Checking ${VAULT_DATA_DIR}/orderBookL2/2026/20260411.local.csv.gz …
✓   OK
ℹ Checking ${VAULT_DATA_DIR}/orderBookL2/2026/20260412.local.csv.gz …
⚠   Corrupt
ℹ   Recovered & sanitized → 20260412.local.recovered.csv
ℹ     messages: kept 46,151,521, dropped 276,374  |  rows: kept 89,261,970, dropped 388,629

✓ Done. OK: 1. Corrupt: 1. Recovered: 1.
```

A free-text table instead prints `Recovered & tail-trimmed → …` (or a warning when no valid timestamp was found).

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
