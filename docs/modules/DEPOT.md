# Depot Module

BitMEX bulk and REST collection: everything BitMEX has already published, downloaded once and
kept current. The live-WebSocket counterpart is [journal](JOURNAL.md).

```
BitMEX S3 dumps            →  courier  ─┐
BitMEX REST endpoints      →  scribe   ─┼→  vault service (CSV)
Tardis monthly samples     →  tardy    ─┘
```

Every service here runs continuously and needs no external trigger: each detects what has newly
appeared at its source and fetches it. A restart costs listings, never re-downloads — what is on
disk is the record of what has been collected.

## Services

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

## Where it writes

Every service writes to the **vault service** over HTTP: one sealed gzip CSV per
`(table, date)`, with vault owning serialisation and the open→closed transition. A file is
either open or closed, never both, and a closed file is permanent.
→ [services/VAULT.md](../services/VAULT.md)

Depot itself transforms nothing.

## Configuration

Full variable lists are in the module's `.env.example` and each service's README. The ones that
matter day to day are the levers bounding how much work is in flight:

| Variable | Effect |
|---|---|
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

Host directories must exist and be writable by uid 1000 before the module starts. The vault
service checks at startup and fails immediately with the command to fix it, rather than after a
long listing pass.
