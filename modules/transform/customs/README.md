# Customs Module

Reads closed vault files and loads them into the MongoDB `tradebot` database.

## Services

| Service | Role |
|---|---|
| **clerk** | Discovers closed vault files, reads them, and publishes rows to the `clerk` topic exchange. WS files → routing key `fragment`. REST files → routing key `record`. |
| **assembler** | Consumes `fragment` messages. Reconstructs the original BitMEX WebSocket message structure and republishes as `record` to `assembled`. |
| **registrar** | Consumes `record` messages. Assigns a deterministic `_id` and bulk-inserts into `MongoDB tradebot / <table>`. |

## Data Flow

```
vault (closed .csv.gz)
  └─ clerk
       ├─ WS tables  ──→ topic:clerk  fragment  ──→ assembler ──→ topic:assembled  record ─┐
       └─ REST tables ──→ topic:clerk  record  ─────────────────────────────────────────────┘
                                                                                             └─→ registrar → MongoDB tradebot
```

See each service's documentation for environment variables:

- [Clerk](../../../services/clerk/README.md)
- [Assembler](../../../services/assembler/README.md)
- [Registrar](../../../services/registrar/README.md)

For detailed technical documentation, see [docs/modules/CUSTOMS.md](../../../docs/modules/CUSTOMS.md).
