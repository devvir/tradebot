# Customs Module — Technical Reference

## Overview

```
vault (closed .csv.gz)
  └─ clerk
       ├─ WS tables   ──→ topic:clerk (key: message) ──→ assembler ──→ topic:assembled ─┐
       └─ REST tables ──→ topic:clerk (key: record)  ─────────────────────────────────┘
                                                                                         └─→ registrar → MongoDB tradebot
                                                                                                              └─→ distiller → derived collections
```

Customs reads all vault files and loads them into the `tradebot` MongoDB database,
then derives secondary collections from the raw data.

## Services

### clerk

Entry point. Scans vault for all files across all tables, sorts them by date (then
table as tiebreaker), and processes them in that order. Each file is read as NDJSON:
WS files emit one WS message object per line (`message` routing key); REST/S3 files
emit one row object per line (`record` routing key). Progress is tracked in Redis so
each file is processed exactly once. See [CLERK.md](../services/CLERK.md).

### assembler

Consumes `message` routing key from `topic:clerk`. Strips the vault-internal `action`
field from each row and restores the original BitMEX WebSocket message structure —
`keys`, `types`, and `filter` metadata for `partial` actions come from a static
per-table spec. Publishes the result as a `record` to `topic:assembled`.
See [ASSEMBLER.md](../services/ASSEMBLER.md).

### registrar

Consumes `record` messages from both `topic:clerk` (REST/S3 tables) and
`topic:assembled` (WS tables). Assigns a deterministic 53-bit `_id` and bulk-inserts
into `MongoDB tradebot / <table>`. Duplicate inserts are silently acked.
See [REGISTRAR.md](../services/REGISTRAR.md).

### distiller

Reads raw collections from MongoDB and produces derived collections. Runs all
generators in parallel; resumes from the last processed `_id` on restart with no
external state (progress is inferred from the output collections directly).
See [DISTILLER.md](../services/DISTILLER.md).

| Source | Output |
|---|---|
| `trade` | `tradeBin1m`, `tradeBin5m`, `tradeBin1h`, `tradeBin1d` |
| `quote` | `quoteBin1m`, `quoteBin5m`, `quoteBin1h`, `quoteBin1d` |
| `orderBookL2` | `orderBook10`, `orderBookL2_25` |
| `compositeIndex`, `quote`, `trade`, `funding`, `settlement` | `instrument` |

### customs-pipe

One-shot service that declares the AMQP bindings connecting clerk, assembler and
registrar, then exits. Clerk waits for the pipe to complete before publishing.

```
topic:clerk (key: message) → fanout:assembler
topic:clerk (key: record)  → fanout:registrar
topic:assembled             → fanout:registrar
```

## RabbitMQ Topology

| Exchange | Type | Declared by |
|---|---|---|
| `clerk` | topic | clerk |
| `assembler` | fanout | assembler |
| `assembled` | topic | assembler |
| `registrar` | fanout | registrar |

## ID Scheme

Each document written by registrar receives a deterministic 53-bit integer `_id`:

```
_id = dateOffset × 2³⁹ + msgIndex × 2¹² + reserved
```

| Field | Bits | Description |
|---|---|---|
| `dateOffset` | 14 | Days since 2000-01-01 UTC (valid until ~2044) |
| `msgIndex` | 27 | Message position within the vault file |
| `reserved` | 12 | Always 0; 1–4095 reserved for future gap-fill events |

`_id` is deterministic from file content alone — reprocessing the same file produces
the same values; duplicate key errors are silently acked by registrar.
