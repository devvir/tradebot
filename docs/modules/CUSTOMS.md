# Customs Module — Technical Reference

## Overview

```
vault (closed .csv.gz)
  └─ clerk
       ├─ WS tables  ──→ topic:clerk  data ──→ assembler ──→ topic:assembled  record ─┐
       └─ REST tables ──→ topic:clerk  item ────────────────────────────────────────┘
                                                                                      └─→ registrar → MongoDB tradebot
```

Customs reads all closed vault files and loads them into the `tradebot` MongoDB
database. It handles both WS and REST/S3 tables with a single pipeline, using the
routing key to distinguish whether message reconstruction is needed.

## Services

### clerk

Entry point. Scans vault for all files across all tables, sorts them by date (then
table as tiebreaker), and processes them in that order. Each file is read as NDJSON:
WS files emit one array of rows per original WS message (`data` routing key); REST/S3
files emit one row object per item (`item` routing key). Progress is tracked in Redis
so each file is processed exactly once. See [CLERK.md](../services/CLERK.md).

### assembler

Consumes `data` messages. Strips the vault-internal `action` field from each row and
restores the original BitMEX WebSocket message structure — `keys`, `types`, and
`filter` metadata for `partial` actions come from a static per-table spec. Publishes
the result as a `record` to `topic:assembled`. See [ASSEMBLER.md](../services/ASSEMBLER.md).

### registrar

Consumes all `record` messages (from both clerk and assembler). Assigns a deterministic
53-bit `_id` and bulk-inserts into `MongoDB tradebot / <table>`. Duplicate inserts are
silently acked. See [REGISTRAR.md](../services/REGISTRAR.md).

### customs-pipe

A one-shot service that declares the AMQP bindings connecting the three services, then
exits. Bindings:

```
topic:clerk (key: data) → fanout:assembler
topic:clerk (key: item) → fanout:registrar
topic:assembled          → fanout:registrar
```

## RabbitMQ Topology

| Exchange | Type | Declared by |
|---|---|---|
| `clerk` | topic | clerk |
| `assembler` | fanout | assembler |
| `assembled` | topic | assembler |
| `registrar` | fanout | registrar |

Bindings are established by `customs-pipe` after all services are running. Clerk
depends on the pipe completing successfully before it starts publishing.

## ID Scheme

Each document in MongoDB receives a deterministic 53-bit integer `_id`:

```
_id = dateOffset × 2³⁹ + msgIndex × 2¹² + reserved
```

| Field | Bits | Description |
|---|---|---|
| `dateOffset` | 14 | Days since 2000-01-01 UTC (valid until ~2044) |
| `msgIndex` | 27 | Message position within the closed vault file |
| `reserved` | 12 | Always 0; 1–4095 reserved for future gap-fill events |

The `_id` is deterministic from file content alone. Running the pipeline twice over the
same file produces the same `_id` values — inserting them a second time triggers
duplicate key errors, which registrar acks silently.
