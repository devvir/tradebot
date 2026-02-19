# Docker Swarm Deployment Guide

This document describes how to deploy TradeBot using Docker Swarm for horizontal scaling.

## Overview

Docker Swarm allows you to:
- Scale stateless services (codec, archivist) horizontally across multiple nodes
- Load-balance message consumption automatically via RabbitMQ
- Perform zero-downtime rolling updates
- Manage the cluster with Docker CLI (no external tools needed)

## Prerequisites

- Docker Engine 20.10+ on all nodes
- Swarm initialized: `docker swarm init`
- Nodes joined to swarm: `docker swarm join --token <token> <manager-ip>:2377`

## Key Architectural Changes

### Service Replicas

Each scalable service now supports a `REPLICAS` environment variable (defaults to 1):

```yaml
deploy:
  replicas: ${CODEC_REPLICAS:-1}
  update_config:
    parallelism: 1        # One instance at a time
    delay: 10s            # Wait 10s between updates
    failure_action: rollback
  restart_policy:
    condition: on-failure
    delay: 5s
    max_attempts: 3
```

### Queue-Based Load Balancing

Services like `codec` and `archivist` consume from shared RabbitMQ queues. RabbitMQ automatically distributes messages to all connected consumers, providing natural horizontal scaling:

- **3 codec instances** = messages distributed 3 ways
- **2 archivist instances** = messages distributed 2 ways
- Each instance processes a portion of the queue independently

No special coordination code needed—RabbitMQ handles it.

## Deployment

### Local Development (docker-compose)

```bash
# Single replica of each service
cd modules/reader
docker-compose up --build
```

### Swarm Deployment

```bash
# Initialize swarm (if not already done)
docker swarm init

# Deploy with scaling
docker stack deploy -c modules/reader/compose.yml reader

# View running services
docker service ls

# View replicas of codec service
docker service ps reader_codec
```

### Configuration Example

Use `.env.swarm` as a template. Override with environment variables:

```bash
export CODEC_REPLICAS=3
export ARCHIVIST_REPLICAS=2
docker stack deploy -c modules/reader/compose.yml reader
```

Or set in `.env`:

```bash
cp modules/reader/.env.swarm modules/reader/.env
docker stack deploy -c modules/reader/compose.yml reader
```

## Scaling in Production

### Scale Up (Add Capacity)

```bash
# Increase codec instances from 3 to 5
docker service update --replicas 5 reader_codec

# View progress
docker service ps reader_codec

# Watch logs
docker service logs -f reader_codec
```

### Scale Down (Reduce Capacity)

```bash
# Reduce codec instances from 5 to 3
docker service update --replicas 3 reader_codec
```

### Rolling Update (Zero Downtime)

```bash
# Update deploy config in compose.yml, then redeploy
docker stack deploy -c modules/reader/compose.yml reader

# Swarm will:
# 1. Build new image
# 2. Start 1 new instance
# 3. Wait 10 seconds
# 4. Stop 1 old instance
# 5. Repeat for each replica
```

## Monitoring

### Service Status

```bash
# List all services
docker service ls

# Detailed service info
docker service inspect reader_codec

# Running tasks/instances
docker service ps reader_codec
docker service ps reader_archivist
```

### Logs

```bash
# Follow codec logs
docker service logs -f reader_codec

# Follow all services
docker service logs -f reader_*
```

### Health Checks

Each service has a health check endpoint at `http://localhost:3000/health`. Swarm uses these to detect and restart unhealthy instances.

```bash
# View health status (in service ps output)
docker service ps reader_codec

# Check a health endpoint directly (from swarm node)
curl http://localhost:3000/health
```

## Removing Services

```bash
# Remove stack (all services, volumes preserved)
docker stack rm reader

# Remove swarm (this node)
docker swarm leave --force
```

## Important Notes

### Stateless Services Only

Only services designed to be stateless without `container_name` can be scaled:
- ✅ codec (stateless, shared queue)
- ✅ archivist (stateless, shared queue)
- ✅ feed (stateless, connects to BitMEX)

Infrastructure services (rabbitmq, mongodb) should remain single replica in most deployments.

### Container Names Removed

Removed `container_name` from service definitions to allow Swarm to generate unique names for each replica:
```
reader_codec.1.xyz...
reader_codec.2.abc...
reader_codec.3.def...
```

### Port Binding

In Swarm, avoid explicit port bindings for internal services. Set `*_PORT` env vars to empty:

```bash
# Good for Swarm (no external port binding)
CODEC_PORT=
ARCHIVIST_PORT=

# If you need external access, Swarm uses ingress overlay network
# All replicas appear as a single service via hostname resolution
```

## Design Philosophy

Our implementation aligns with these principles:

1. **Service-oriented**: Each service is independent, reads config from env vars
2. **Queue-based scaling**: RabbitMQ distributes work, no code changes needed
3. **Graceful shutdown**: Services handle SIGTERM/SIGINT for clean drains
4. **Health checks**: Each service provides `/health` endpoint
5. **Backward compatible**: Same compose files work in both docker-compose and Swarm

## Troubleshooting

### Service won't start

```bash
docker service logs reader_codec

# Check deploy config
docker service inspect reader_codec
```

### Tasks constantly restarting

Usually health check failures. Check logs and service health endpoint.

### Replicas stuck in "pending"

- Check resource constraints: `docker node ls`, `docker node inspect <node-id>`
- Insufficient disk space, memory, or CPU
- Image pull failures: `docker service logs <service-name>`

### Messages not distributing evenly

RabbitMQ consumer groups handle distribution. If uneven:
- Check connection logs: `curl http://localhost:15672/#/connections` (RabbitMQ Management UI)
- Ensure all consumers connected
- Check queue configuration (prefetch, ack mode)

## Additional Resources

- [Docker Swarm Documentation](https://docs.docker.com/engine/swarm/)
- [Service Rollback & Recovery](https://docs.docker.com/engine/reference/commandline/service_update/)
- [RabbitMQ Consumer Fair Dispatch](https://www.rabbitmq.com/tutorials/tutorial-two-python.html)
