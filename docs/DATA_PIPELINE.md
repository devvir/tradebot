# Data Pipeline — Architecture

## Overview

BitMEX market data is collected from three sources — S3 dumps, the REST API, and
the live WebSocket — and stored as daily per-table gzip CSV files in vault.

Two modules handle data acquisition:

- **depot**: courier (S3) + scribe (REST) write to vault
- **journal**: broadcast (WS) → journalist writes to vault

Both modules write to the same vault storage layout. A separate **stage 2** pipeline (customs module) reads those files and loads them into MongoDB.

---

## Data Sources

| Source | Tables | Service |
|---|---|---|
| BitMEX S3 dumps | trade, quote | courier |
| BitMEX REST API | funding, compositeIndex, settlement, insurance | scribe |
| BitMEX WebSocket | orderBookL2, instrument, and others | journalist (via broadcast) |

---

## Stage 1 — Data Acquisition

All sources produce the same output: **date-partitioned gzip CSV files in vault**.

### Storage — vault

Vault is the central file store. All files live under `/data/vault` in the container (and the configurable mount in the host, defined in env var `VAULT_DATA_DIR`):

```
/data/vault/<table>/<yyyy>/<yyyymmdd>.csv      ← open (being written)
/data/vault/<table>/<yyyy>/<yyyymmdd>.csv.gz   ← closed (sealed)
```

A date file is either open or closed — never both. Upstream services write rows
via HTTP POST; vault serialises them to CSV internally and manages the open → close transition. The on-disk extensions are a vault-internal concern — callers work in terms of `table` and `date` only.

Vault HTTP API:

| Endpoint | Description |
|---|---|
| `POST /files/:table/:date/rows` | Append JSON row(s); returns 202 immediately |
| `PUT /files/:table/:date` | Store a complete pre-built binary file (e.g. S3 gzip) |
| `POST /files/:table/:date/close` | Gzip and seal an open file |
| `DELETE /files/:table/:date` | Drop an open file |
| `GET /files/:table/:date` | Stream a closed file |
| `GET /files/:table` | List all files for a table with their state |

### S3 dumps → courier

```
BitMEX S3  →  courier  →  vault (PUT /files/:table/:date)
```

courier downloads BitMEX public S3 gzip dumps for the `trade` and `quote` tables
and streams the raw bytes directly to vault via `PUT` — no intermediate disk I/O.
On startup, asks vault which dates it already has and skips them. Rechecks at UTC midnight for newly published dumps. Retries with exponential backoff.

Available from 2014-11-22.

### REST API → scribe

```
BitMEX REST API  →  scribe  →  vault (POST /files/:table/:date/rows)
```

scribe paginates the BitMEX REST API for `funding`, `settlement`, `insurance`, and
`compositeIndex`. For `compositeIndex`, scribe loads the list of index symbols from
the registry and processes them one at a time within each day to maintain consistent
file ordering.

On startup, scribe drops any open vault files and resumes from the day after the
latest closed file. Polls continuously once caught up.

### WebSocket → journalist

```
BitMEX WS  →  broadcast  →  [exchange:broadcast]
                                      ↓  (pipe: broadcast > journalist)
                             [exchange:journalist]  →  journalist  →  vault (POST /files/:table/:date/rows)
```

broadcast connects to the BitMEX WebSocket and publishes every message to the
`broadcast` topic exchange. The `pipe` service (journal module) creates the
`broadcast → journalist` AMQP binding. journalist consumes the `journalist`
exchange, augments each row, buffers them in memory, and flushes to vault on day
transitions or when the buffer reaches 1,000 rows.

---

## Dump Formats

### S3 tables (trade, quote)

Written atomically to vault as-is via PUT. Column layout matches BitMEX S3 CSVs exactly.

### REST tables (funding, settlement, insurance, compositeIndex)

Flat rows, one item per line. Column layout matches the BitMEX REST response fields. No additional metadata columns.

### WS dump format

journalist adds one field to every row:

| Column | Description |
|---|---|
| `action` | BitMEX action: `partial`, `insert`, `update`, `delete` |

Message boundaries are preserved by vault internally. When journalist sends a batch
of rows to vault, vault tags each group with a `_head_` marker in the CSV (a
vault-internal detail). When clerk later reads the file, vault's NDJSON stream
already reconstructs the groups — each line is a JSON array of rows belonging to
one original WS message.

Example — three consecutive WS messages as journal sees them:

```
// journalist sends to vault:
[[{action:'insert',...}], [{action:'insert',...}], [{action:'update',...},{action:'update',...},{action:'update',...}]]
```

---

## Stage 2 — Load (customs module)

The customs module reads closed vault files and loads them into MongoDB.

```
vault (closed .csv.gz)
  └─ clerk
       ├─ WS tables   ──→ topic:clerk  data  ──→ assembler ──→ topic:assembled  record ─┐
       └─ REST tables ──→ topic:clerk  item  ───────────────────────────────────────────┘
                                                                                          └─→ registrar → MongoDB tradebot
```

**clerk** polls vault for files it hasn't processed yet, sorted by date across all
tables. For WS files, vault's NDJSON stream emits one array of rows per original WS
message; clerk publishes each array as a `data` message. For REST files, each line is
a single row object published as an `item`. Progress is tracked in Redis.

**assembler** consumes `data` messages. It strips the `action` field from each row,
reconstructs the original WS message shape (adding `keys`, `types`, and
`filter` metadata for `partial` actions from a static per-table spec), and republishes
as a `record`.

**registrar** consumes `record` messages. It assigns a deterministic 53-bit `_id` and
bulk-inserts documents into `MongoDB tradebot / <table>`. Duplicate inserts are silently
acked. Transient errors are retried up to 3 times before nacking.

### ID scheme

```
_id = dateOffset × 2³⁹ + msgIndex × 2¹² + reserved
```

| Field | Bits | Description |
|---|---|---|
| `dateOffset` | 14 | Days since 2000-01-01 UTC (valid to ~2044) |
| `msgIndex` | 27 | Message position in the day's closed file |
| `reserved` | 12 | Always 0; 1–4095 reserved for future gap-fill events |

---

## Data Layout

```
/data/vault/
  trade/
    2014/20141122.csv.gz   ← closed (complete)
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

---

## Ordering Guarantees

- **S3 tables** (trade, quote): one file per day, written atomically as a single PUT. Order is whatever S3 provides.
- **REST tables** (funding, settlement, insurance): rows appended in API order (ascending timestamp).
- **compositeIndex**: symbols processed one at a time within each day. All rows for symbol A precede all rows for symbol B within the same file. Consistent across restarts.
- **WS tables**: rows are in arrival order. Message groupings are preserved by vault internally and surfaced as pre-grouped arrays in the NDJSON stream.

---

## Recovery

All services are restart-safe:

- **courier**: idempotent — vault returns 409 for already-stored dates, treated as a no-op.
- **scribe**: drops any open vault files on startup and re-fetches from the start of that day. No partial rows, no duplicates.
- **journalist**: on the first message for any table, queries vault for open files and continues appending if found. Retries vault writes indefinitely on errors.

---

## Gap-filling (WS)

The BitMEX WebSocket disconnects with code 1006 every 40–50 minutes on average. Stage
1 captures gaps faithfully. Future pipeline work will correct for them at load time
using `action` and gap detection via `partial` comparisons.

---

## What the live trading module uses

The live trading module (WS, REST, proxy, snapshots, broadcast) is entirely separate
from this pipeline. It operates on live data in real time via RabbitMQ. The data
pipeline is for accumulating and curating historical data for replay and bot training.
