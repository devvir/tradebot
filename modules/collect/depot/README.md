# Depot Module

Downloads the complete BitMEX historical dataset and keeps it current as new data becomes available. Runs continuously — no manual scheduling needed.

## Services

| Service | Role |
|---------|------|
| **vault** | Sole owner of raw dump storage; all data lands here |
| **courier** | Streams S3 gzip dumps (trade, quote) directly into vault |
| **scribe** | Fetches REST endpoints (funding, settlement, insurance, compositeIndex) into vault |
| **registry** | Persistent symbol/currency mappings; used by scribe to manage compositeIndex subtables |
| **MongoDB** | Persistence layer for registry |

## Usage

```bash
tb up depot          # Start all services
tb up depot --build  # Rebuild and start
tb down depot        # Stop all services
tb logs depot        # Stream logs
tb ps depot          # Check service status
```

## Configuration

Copy `.env.example` to `.env` and update as needed.

See each service's documentation for the full list of available environment variables:

- [Courier](../../../services/courier/README.md)
- [Scribe](../../../services/scribe/README.md)
- [Registry](../../../services/registry/README.md)

For detailed technical documentation, see [docs/modules/DEPOT.md](../../../docs/modules/DEPOT.md).
