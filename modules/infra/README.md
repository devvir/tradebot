# Infra Module

Provides essential infrastructure services: RabbitMQ (message queue), MongoDB (persistent storage), and Redis (in-memory cache).

Use this module to launch all three services independently, or include it as part of your deployment (e.g., the reader module uses these services).

## Services

### RabbitMQ
Message queue broker for pub/sub communication between services.
- Durable exchanges and queues
- Topic-based routing
- Management UI accessible at `http://localhost:${RABBITMQ_MGMT_PORT}`

### Launch all three services:

```bash
tb up infra
```

### Launch only with reader module:

```bash
tb up reader
```

Reader module already includes rabbitmq, mongodb, and redis, so you don't need to launch infra separately.

## ⚠️ Security

**CRITICAL for production**:
1. Change default credentials for all services
2. Set `REDIS_PASS` to a strong value
3. Use environment-specific `.env` files
4. Never commit real credentials to version control
