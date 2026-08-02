# Depot Module

Bulk and REST collection: everything a venue has already published, downloaded once and kept
current. The live-WebSocket counterpart is [journal](JOURNAL.md).

```
venue archives (7 venues)  →  trucker  →  host archive tree
BitMEX S3 dumps            →  courier  ─┐
BitMEX REST endpoints      →  scribe   ─┼→  vault service (CSV)
Tardis monthly samples     →  tardy    ─┘
```

Every service here runs continuously and needs no external trigger: each detects what has newly
appeared at its source and fetches it. A restart costs listings, never re-downloads — what is on
disk is the record of what has been collected.

## Services

### trucker

Downloads each venue's published historical archives, byte-for-byte, for **binance, bitget,
bybit, gate, htx, kucoin and okx** — 107 datasets covering trades, klines, order books, funding,
borrowing, mark and index series, open interest and liquidations.

Files land under `<host dir>/<venue>/<the venue's own path>`. Layouts are mirrored rather than
renamed, so a URL maps to one path mechanically and resuming is a `stat` rather than
bookkeeping. Trucker holds no state outside its data directory: progress, symbol lists and
archive ranges are all ledgers under `@meta/`.

It also publishes `@meta/settled/{venue}.tsv` — how far collection is complete per dataset and
symbol — which is the signal stocker gates on. → [services/TRUCKER.md](../services/TRUCKER.md)

### courier

Downloads BitMEX's public S3 gzip dumps for `trade` and `quote` and streams the bytes straight
into the vault service, with no intermediate disk I/O. Asks vault which dates it already holds,
skips them, and rechecks at UTC midnight for newly published dumps. Idempotent: vault answers
409 for a date it already has, which courier treats as a no-op.
→ [services/COURIER.md](../services/COURIER.md)

### scribe

Paginates the BitMEX REST API for the public tables — `compositeIndex`, `funding`, `insurance`,
`settlement`, `tick`, plus `trade`/`quote` from 2026-04-01 and OHLCV bins at all four
resolutions — writing CSV to the vault service. Each table's behaviour is one entry in a
settings map, so the runner names no table. Progress is tracked per task in Redis; throughput
comes from spreading fetches across a guest rate-limit bucket plus one lane per configured
credential. → [services/SCRIBE.md](../services/SCRIBE.md)

### tardy

Fetches the first day of each month from the Tardis free tier, covering the seven BitMEX
WS-only tables that neither S3 nor REST publishes. Present in the module but **not enabled** —
commented out of the compose file until that history is needed.
→ [services/TARDY.md](../services/TARDY.md)

## Two destinations

BitMEX collection writes to the **vault service** over HTTP: one sealed gzip CSV per
`(table, date)`, with vault owning serialisation and the open→closed transition. A file is
either open or closed, never both, and a closed file is permanent.
→ [services/VAULT.md](../services/VAULT.md)

Trucker writes to the **host filesystem** directly, because its inputs are already files.
Putting a service in front of them would mean re-encoding a venue's own bytes in order to store
them, which is the one thing the archive exists to avoid.

Both are read by [stocker](../services/STOCKER.md), which normalises them into the Parquet
vault. Depot itself transforms nothing.

## Configuration

Full variable lists are in the module's `.env.example` and each service's README. The ones that
matter day to day are the levers bounding how much work is in flight:

| Variable | Effect |
|---|---|
| `TRUCKER_DATA_DIR` | Host directory for the archive tree — required, pre-created for uid 1000 |
| `TRUCKER_VENUES` | Which venues to collect; unset means all seven |
| `TRUCKER_SYMBOLS` | Symbol tokens, case-insensitive substrings. Unset means **every** symbol, which is terabytes |
| `TRUCKER_START_MONTH` / `TRUCKER_END_MONTH` | Inclusive month bounds — walk a backfill an era at a time |
| `TRUCKER_MIN_FREE_GB` | Stop fetching when the volume drops below this |
| `SCRIBE_TABLES`, `SCRIBE_START_DATE` | Scope REST collection |
| `SCRIBE_IDENTITIES` | Each credential adds a rate-limit lane |
| `COURIER_START_DATE` | Where the S3 backfill begins |

These are scheduling levers, not correctness ones. Narrowing them leaves periods uncollected
that a later run picks up; nothing downstream mistakes an unfetched period for an empty one,
because completeness is published separately from the files themselves.

## Running it

```bash
tb up depot
```

Host directories must exist and be writable by uid 1000 before the module starts. Both trucker
and vault check at startup and fail immediately with the command to fix it, rather than after a
long listing pass.
