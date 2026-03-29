# Depot Module — Technical Reference

## Overview

```
BitMEX S3 (gzip dumps)  →  courier   ─┐
                                      ├→  vault  (raw CSV files, one per table/date)
BitMEX REST API         →  scribe    ─┘

registry  ←  scribe  (symbol list for compositeIndex subtables)
```

Depot accumulates the complete BitMEX historical dataset in vault and keeps it current. Both courier and scribe run continuously: they detect new data as it becomes available and download it without any external trigger.

## Services

### vault

HTTP service that owns raw dump storage. Accepts JSON rows (serialised to CSV internally) and complete binary files (S3 gzips). Each (table, date) pair becomes one gzip file once closed. Clients call `close` when a day is complete; vault never decides this on its own.

API: `POST /files/:table/:date/rows` · `PUT /files/:table/:date` · `POST /files/:table/:date/close` · `DELETE /files/:table/:date` · `GET /files/:table/:date` · `GET /files/:table`

### courier

Downloads BitMEX public S3 gzip dumps (trade, quote) and streams the raw bytes directly to vault via HTTP PUT — no intermediate disk I/O. On startup, asks vault which dates it already has and skips them. Rechecks at UTC midnight for newly published dumps. Retries with exponential backoff on transient failures.

### Scribe

Fetches four REST endpoints — `funding`, `settlement`, `insurance`, `compositeIndex` — via the BitMEX paginated API and writes rows to vault one at a time. Uses the registry to enumerate compositeIndex symbols and processes them sequentially within each day to maintain consistent file ordering. On startup, drops any open vault files and re-fetches from the start of the affected day (clean restart, no partial state).

Closes each vault file when the first row of the following day appears in the API response. Polls live endpoints continuously after catching up to the tip.

### registry

Maintains persistent integer IDs for symbols and currencies. Used by scribe to resolve compositeIndex subtable symbols. Insert-only; JSON snapshots are bind-mounted so every new entry appears in git diff.

## Data Layout

```
/data/vault/
  trade/
    2014/20141122.csv.gz   ← closed (complete)
    2014/20141123.csv.gz
    ...
  quote/
    ...
  funding/
    2015/20150228.csv.gz
    ...
    2026/20260328.csv      ← open (today, in progress)
  settlement/
    ...
  insurance/
    ...
  compositeIndex/
    ...
```

## Ordering Guarantees

- **S3 tables** (trade, quote): one file per day, written atomically as a single PUT. Order is whatever S3 provides.
- **REST tables** (funding, settlement, insurance): rows appended in API order (ascending timestamp).
- **compositeIndex**: symbols processed one at a time within each day. All rows for symbol A precede all rows for symbol B within the same file. Consistent across restarts.

## Recovery

Courier and scribe are both restart-safe:

- **Courier**: idempotent — vault returns 409 for already-stored dates, treated as a no-op.
- **Scribe**: on startup, drops any open vault files for its tables and re-fetches from the start of that day. No partial rows, no duplicates.
