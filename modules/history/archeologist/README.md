# Archeaologist Module

Historical data fetcher for BitMEX paginated data (Rest API).

## Services

| Service | Role |
|---------|------|
| **mongodb** | Persistence layer for historical data |
| **history** | BitMEX REST API historical data fetcher and poller |

## Usage

```bash
tb up archeologist          # Start all services
tb up archeologist --build  # Rebuild and start
tb down archeologist        # Stop all services
tb logs archeologist        # Stream logs
tb ps archeologist          # Check service status
```

## Configuration

Copy `.env.example` to `.env` and update credentials as needed. Most config lives in the root `.env.example`.

See each service's documentation for the full list of available environment variables:

- [History](../../../services/history/README.md)
- [MongoDB](../../../services/mongodb/README.md)

For detailed technical documentation, see [docs/modules/ARCHEOLOGIST.md](../../docs/modules/ARCHEOLOGIST.md).
