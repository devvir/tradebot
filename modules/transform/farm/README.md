# Farm Module

Reads vault files and loads them into the MongoDB `tradebot` database, then derives
secondary collections from the raw data.

## Services

| Service | Role |
|---|---|
| **farmer** | Discovers vault buckets, streams them, reconstructs WS envelopes, and bulk-inserts into `MongoDB tradebot / <table>`. Corrupt rows go to `MongoDB farmer / <table>` for forensics. |
| **distiller** | Reads raw collections from MongoDB and produces derived collections (bins, order book snapshots, instrument messages, partials). |

## Data Flow

```
vault (closed .csv.gz)
  └─ farmer ──→ MongoDB tradebot / <table>      (clean docs)
            └─→ MongoDB farmer   / <table>      (forensics)

MongoDB tradebot ─→ distiller ─→ derived collections
```

Progress is checkpointed in Redis under `farm:<table>:<date>`.

See each service's documentation for environment variables:

- [Farmer](../../../services/farmer/README.md)
- [Distiller](../../../services/distiller/README.md)

For detailed technical documentation, see [docs/services/FARMER.md](../../../docs/services/FARMER.md).
