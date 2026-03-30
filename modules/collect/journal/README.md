# Journal Module

Records live BitMEX WebSocket events to vault as they arrive. Runs continuously alongside a RabbitMQ broker (queue-rt).

## Services

| Service        | Role                                                               |
|----------------|--------------------------------------------------------------------|
| **vault**      | Sole owner of raw data storage; all rows land here                 |
| **broadcast**  | Connects to BitMEX WebSocket and publishes messages to RabbitMQ   |
| **journalist** | Consumes from RabbitMQ and writes augmented rows to vault          |
| **pipe**       | Creates the exchange binding: `broadcast` → `journalist`           |

## Usage

```bash
tb up journal          # Start all services
tb up journal --build  # Rebuild and start
tb down journal        # Stop all services
tb logs journal        # Stream logs
tb ps journal          # Check service status
```

## Configuration

Copy `.env.example` to `.env` and update as needed.

See each service's documentation for the full list of available environment variables:

- [Broadcast](../../../services/broadcast/README.md)
- [Journalist](../../../services/journalist/README.md)

For detailed technical documentation, see [docs/modules/JOURNAL.md](../../../docs/modules/JOURNAL.md).
