# RabbitMQ Service

Message queue broker (RabbitMQ 3.13). Provides pub/sub messaging for inter-service communication.

## Official Documentation

- [RabbitMQ Documentation](https://www.rabbitmq.com/documentation.html)
- [RabbitMQ Installation Guides](https://www.rabbitmq.com/download.html)
- [RabbitMQ Management Plugin](https://www.rabbitmq.com/management.html)

### Environment Variables

All credentials are configured via environment variables:

- `QUEUE_USER` - Admin username (default: `guest`)
- `QUEUE_PASS` - Admin password (default: `guest`)
- `RABBITMQ_AMQP_PORT` - AMQP port for client connections (default: `9672`)
- `RABBITMQ_MGMT_PORT` - Management UI port (default: `19672`)

**Important**: The user created via `QUEUE_USER`/`QUEUE_PASS` will have full administrator privileges and can access:
- The RabbitMQ message queue (for publishers/consumers)
- The management web UI at `http://localhost:${RABBITMQ_MGMT_PORT}`

### ⚠️  Security Warning

**CRITICAL**: This RabbitMQ configuration allows remote connections from any host. The default `guest/guest` credentials are well-known and **MUST be changed** before running in any environment.

**YOU MUST**:
1. Change `QUEUE_USER` and `QUEUE_PASS` in your module's `.env` file
2. Update the `QUEUE_URL` connection string in all services to match
3. Never commit real credentials to version control

### Services Using RabbitMQ

Services connect using the `QUEUE_URL` environment variable, which automatically includes the credentials:

```typescript
// Example: services/broadcast/docker/compose.yml
QUEUE_URL: amqp://${QUEUE_USER}:${QUEUE_PASS}@rabbitmq:${RABBITMQ_AMQP_PORT}
```

This ensures all services use the same credentials set at the module level.

## Management UI

Access the management interface at:
```
http://localhost:${RABBITMQ_MGMT_PORT}
```

Login with the credentials set via `QUEUE_USER` and `QUEUE_PASS`.
