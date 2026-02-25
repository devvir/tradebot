# Redis Service

In-memory data store (Redis 7). Provides fast, ephemeral storage for caching and temporary data.

## Docker Commands

Build the image:
```bash
docker compose -f services/redis/docker/compose.yml build
```

Start the container:
```bash
docker compose -f services/redis/docker/compose.yml up -d
```

Stop the container:
```bash
docker compose -f services/redis/docker/compose.yml down
```

View logs:
```bash
docker compose -f services/redis/docker/compose.yml logs -f
```

## Official Documentation

- [Redis Documentation](https://redis.io/documentation)
- [Redis Server](https://redis.io/commands/)
- [Redis Docker Hub](https://hub.docker.com/_/redis)

### Environment Variables

All configuration is done via environment variables:

- `REDIS_PASS` - Redis password (default: `""` / no password). Note: Redis uses password-only authentication (no username).
- `REDIS_PORT` - Port for client connections (default: `6379`)
- `REDIS_RESTART_POLICY` - Container restart policy (default: `unless-stopped`)

### ⚠️ Security Warning

**CRITICAL**: This Redis configuration allows unauthenticated connections if `REDIS_PASS` is empty.

**YOU MUST**:
1. Set `REDIS_PASS` to a strong password in your module's `.env` file
2. Update the `REDIS_URL` in services that connect to Redis
3. Never commit real credentials to version control

### Setting Credentials

Set credentials in your module's `.env` file:

```bash
REDIS_PASS=your-secure-password-here
```

Or pass them when starting a module:

```bash
REDIS_PASS=secret tb up infra
```

## Connection String

After setting `REDIS_PASS`, services connect via (note: Redis uses no username, only password):

```
redis://:${REDIS_PASS}@redis:6379
```

Or without authentication (if `REDIS_PASS` is empty):

```
redis://redis:6379
```
