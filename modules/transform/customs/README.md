# Customs Module

Reads vault files and loads them into the MongoDB `tradebot` database, then derives
secondary collections from the raw data.

## Services

| Service | Role |
|---|---|
| **clerk** | Discovers vault files, reads them, and publishes rows to the `clerk` topic exchange. WS files → routing key `message`. REST files → routing key `record`. |
| **assembler** | Consumes `message` messages. Reconstructs the original BitMEX WebSocket message structure and republishes as `record` to `assembled`. |
| **registrar** | Consumes `record` messages. Assigns a deterministic `_id` and bulk-inserts into `MongoDB tradebot / <table>`. |
| **distiller** | Reads raw collections from MongoDB and produces derived collections (bins, order book snapshots, instrument messages). |

## Data Flow

```
vault (closed .csv.gz)
  └─ clerk
       ├─ WS tables   ──→ topic:clerk (key: message) ──→ assembler ──→ topic:assembled ─┐
       └─ REST tables ──→ topic:clerk (key: record)  ────────────────────────────────┘
                                                                                         └─→ registrar → MongoDB tradebot
                                                                                                              └─→ distiller → derived collections
```

See each service's documentation for environment variables:

- [Clerk](../../../services/clerk/README.md)
- [Assembler](../../../services/assembler/README.md)
- [Registrar](../../../services/registrar/README.md)
- [Distiller](../../../services/distiller/README.md)

For detailed technical documentation, see [docs/modules/CUSTOMS.md](../../../docs/modules/CUSTOMS.md).
