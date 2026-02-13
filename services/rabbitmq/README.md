# RabbitMQ Service

Message queue broker providing pub/sub communication for the application. Used for event streaming between services.

## Features

- RabbitMQ 3.13 with management UI
- Durable exchanges and queues
- Topic-based routing
- Configurable credentials via environment variables

## Configuration

### Environment Variables

All credentials are configured via environment variables:

- `RABBITMQ_USER` - Admin username (default: `guest`)
- `RABBITMQ_PASS` - Admin password (default: `guest`)
- `RABBITMQ_AMQP_PORT` - AMQP port for client connections (default: `9672`)
- `RABBITMQ_MGMT_PORT` - Management UI port (default: `19672`)

**Important**: The user created via `RABBITMQ_USER`/`RABBITMQ_PASS` will have full administrator privileges and can access:
- The RabbitMQ message queue (for publishers/consumers)
- The management web UI at `http://localhost:${RABBITMQ_MGMT_PORT}`

### ⚠️  Security Warning

**CRITICAL**: This RabbitMQ configuration allows remote connections from any host. The default `guest/guest` credentials are well-known and **MUST be changed** before running in any environment.

**YOU MUST**:
1. Change `RABBITMQ_USER` and `RABBITMQ_PASS` in your module's `.env` file
2. Update the `RABBITMQ_URL` connection string in all services to match
3. Never commit real credentials to version control

### Setting Credentials

Set credentials in your module's `.env` file:

```bash
# Change these to strong, unique values!
RABBITMQ_USER=admin
RABBITMQ_PASS=your-secure-password-here
```

Or pass them when starting a module:

```bash
RABBITMQ_USER=admin RABBITMQ_PASS=secret tb up reader
```

### Services Using RabbitMQ

Services connect using the `RABBITMQ_URL` environment variable, which automatically includes the credentials:

```typescript
// Example: services/feed/docker/compose.yml
RABBITMQ_URL: amqp://${RABBITMQ_USER}:${RABBITMQ_PASS}@rabbitmq:${RABBITMQ_AMQP_PORT}
```

This ensures all services use the same credentials set at the module level.

## Management UI

Access the management interface at:
```
http://localhost:${RABBITMQ_MGMT_PORT}
```

Login with the credentials set via `RABBITMQ_USER` and `RABBITMQ_PASS`.
