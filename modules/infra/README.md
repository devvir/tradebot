# Infra Module

Shared infrastructure services: RabbitMQ (message broker), MongoDB (persistent storage), and Redis (cache).

Start this module independently to bring up infrastructure without application services. All other modules include these services automatically via their own compose files, so this module is only needed when you want infrastructure alone.

## Services

- **RabbitMQ** — AMQP message broker; management UI at `http://localhost:${RABBITMQ_MGMT_PORT}`
- **MongoDB** — Document store
- **Redis** — In-memory cache

## Usage

```bash
tb up infra          # Start all infrastructure services
tb up infra --build  # Rebuild and start
tb down infra        # Stop all infrastructure services
tb logs infra        # Stream logs
tb ps infra          # Check service status
```

## Configuration

Copy `.env.example` to `.env` and customize.

See each service's documentation for the full list of available environment variables:

- [RabbitMQ](../../services/rabbitmq/README.md)
- [MongoDB](../../services/mongodb/README.md)
- [Redis](../../services/redis/README.md)
