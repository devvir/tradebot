# Docker Swarm for TradeBot

This document explains Docker Swarm and how it applies to TradeBot. It's targeted at someone who knows Docker and docker-compose but hasn't used Swarm or Kubernetes.

## What Docker Swarm Is

Docker Swarm is Docker's native orchestration platform. Think of it as a simpler, built-in alternative to Kubernetes that uses the same Docker CLI and Compose files you already know.

**Key idea:** Instead of running containers on a single machine with `docker-compose`, Swarm lets you:
1. Join multiple Docker hosts into a cluster
2. Define how many replicas of each service you want
3. Swarm automatically starts, monitors, and places containers across your cluster
4. Services communicate by hostname (Swarm's DNS handles routing)

It's not a completely different paradigm like Kubernetes—it's Docker with clustering on top.

## Your Current Setup (docker-compose)

You're currently using `docker-compose` for local development:

```bash
# Single machine, manual container management
docker compose -f modules/reader/compose.yml up --build
```

This:
- Starts all services on your local machine
- Each service is in its own container but on the same network
- You manage lifecycle (start, stop, restart) manually
- No automatic recovery if a container crashes
- Perfect for development; not designed for production clustering

**Service communication:** Services find each other by hostname (e.g., codec connects to `rabbitmq:5672`). Docker's embedded DNS on the compose network makes this work.

## Swarm: The Same Concepts, Scaled

Docker Swarm uses **the exact same Compose files** but adds:

```yaml
deploy:
  replicas: 3  # "I want 3 copies of this service"
  update_config:
    parallelism: 1  # "Update 1 at a time"
    delay: 10s      # "Wait 10s between updates"
  restart_policy:
    condition: on-failure
```

This `deploy` block is **ignored by docker-compose** (it only understands `services`, `networks`, `volumes`). It's only used when you deploy to Swarm.

## Concrete Example: Scaling Codec

### Current Setup (docker-compose)

```yaml
# services/codec/docker/compose.yml
services:
  codec:
    container_name: reader-codec
    build: ...
    environment:
      RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672
```

Running `docker-compose up`:
- Creates ONE container called `reader-codec`
- It connects to RabbitMQ, consumes messages, processes them
- If it crashes, it stays down until you manually restart

**Problem:** RabbitMQ publishes 10,000 messages/second. One codec instance can only process 5,000/sec. Your queue backs up.

### With Swarm

```yaml
# Same file, same service definition, plus deploy block
services:
  codec:
    build: ...
    environment:
      RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672

    deploy:
      replicas: 3  # ← This is the only thing you add
      restart_policy:
        condition: on-failure
```

Running `docker stack deploy`:
- Swarm creates **3 separate codec containers** (or more if you scale later)
- Each connects to the same RabbitMQ instance via the same `RABBITMQ_URL`
- RabbitMQ's built-in consumer groups automatically distribute messages:
  - Instance 1 gets ~3,333 msg/sec
  - Instance 2 gets ~3,333 msg/sec
  - Instance 3 gets ~3,334 msg/sec
- If one crashes, Swarm automatically restarts it
- No code changes; pure infrastructure scaling

**That's it.** The magic is RabbitMQ with multiple consumers. Queue-based scaling is the simplest form of horizontal scaling.

## What Changes

### Compose Deploy Block

Services now have a `deploy` section:

```yaml
deploy:
  replicas: ${CODEC_REPLICAS:-1}  # Configurable, defaults to 1
  update_config:
    parallelism: 1
    delay: 10s
    failure_action: rollback
  restart_policy:
    condition: on-failure
    delay: 5s
    max_attempts: 3
    window: 120s
```

**Only used by Swarm.** Docker-compose ignores it. This is why your local development isn't affected.

### No container_name

Before:
```yaml
services:
  codec:
    container_name: reader-codec
```

After (removed):
```yaml
services:
  codec:
    # No container_name
```

**Why?** With 3 replicas, you can't have 3 containers with the same name. Swarm generates unique names:
```
reader_codec.1.xyz...
reader_codec.2.abc...
reader_codec.3.def...
```

Docker-compose doesn't need `container_name` either—it auto-generates names using service name and instance number.

### Environment Variables for Scaling

Added to `.env`:

```bash
# .env (defaults, work in both compose and swarm)
CODEC_REPLICAS=1
ARCHIVIST_REPLICAS=1
FEED_REPLICAS=1

# .env.swarm (example for production swarm)
CODEC_REPLICAS=3
ARCHIVIST_REPLICAS=2
FEED_REPLICAS=1
```

In docker-compose, these are just ignored environment variables (no harm).
In Swarm, they control replica count.

## What Doesn't Change

### Service Communication

Services still communicate by hostname:

```typescript
// codec/src/rabbitmq.ts
const rabbitmqUrl = process.env.RABBITMQ_URL; // "amqp://guest:guest@rabbitmq:5672"
```

**In docker-compose:** Docker's embedded DNS in the compose network resolves `rabbitmq` to the rabbitmq container's IP.

**In Swarm:** Docker's overlay network DNS does the same thing across nodes. Transparent to your code.

No changes to connection strings, no service discovery client code, no registry lookup. Same env var semantics.

### Application Code

Nothing in your Node.js services changes. No Swarm-specific imports, no health check rewrites, no distributed locking logic.

The codec service still:
- Reads config from env vars
- Connects to RabbitMQ
- Consumes messages
- Publishes to exchange
- Gracefully shuts down on SIGTERM

Identical behavior.

### RabbitMQ & MongoDB

Infrastructure services (rabbitmq, mongodb) don't scale horizontally in our setup. Swarm will keep them at 1 replica. They're single-node services accessed by everyone else.

```bash
deploy:
  replicas: 1  # or omitted, defaults to 1
```

RabbitMQ itself handles multiple consumers (our codec and archivist instances). MongoDB handles multiple clients (writers/readers). Both are designed for this.

### Development Workflow

```bash
# Still works exactly the same
docker-compose -f modules/reader/compose.yml up --build

# Still defined the same way
compose.yml uses "include" and "extends" for service/module composition
```

`tb up reader` still works. The `deploy` block is inert in compose context.

## Running Swarm: Step by Step

### 1. Initialize Swarm (One Time)

```bash
# On the machine you want to be the manager
docker swarm init

# Output:
# Swarm initialized: current node is a manager and worker.
# To add a worker to this swarm, run the following command:
#   docker swarm join --token SWMTKN-1-xyz... 192.168.1.100:2377
```

This machine is now a Swarm manager. It orchestrates the cluster.

### 2. Join Other Nodes (Optional, for multi-node)

```bash
# On other machines you want to join the cluster
docker swarm join --token SWMTKN-1-xyz... 192.168.1.100:2377

# Each node is now part of the cluster
```

For local testing, you only need one node (your dev machine).

### 3. Deploy Stack

```bash
# Instead of docker-compose up, use docker stack deploy
docker stack deploy -c modules/reader/compose.yml reader

# Creates stack named "reader" with all services defined in compose.yml
```

Swarm reads the compose file and interprets the `deploy` blocks.

### 4. Check Status

```bash
# List all stacks
docker stack ls

# List services in stack (shows replicas)
docker service ls

# Output:
# ID       NAME               MODE     REPLICAS  IMAGE
# abc      reader_codec       replicated  3/3    tradebot:codec
# def      reader_archivist   replicated  2/2    tradebot:archivist
# ghi      reader_feed        replicated  1/1    tradebot:feed
```

The `3/3` means "3 replicas up, 3 total running" (healthy).

### 5. Check Service Details

```bash
# Which tasks (instances) are running?
docker service ps reader_codec

# Output:
# ID          NAME           IMAGE          NODE     STATE
# abc123      reader_codec.1 tradebot:codec node1    Running
# def456      reader_codec.2 tradebot:codec node1    Running
# ghi789      reader_codec.3 tradebot:codec node2    Running
```

Shows each replica, which node it's on, its state.

### 6. View Logs

```bash
# Logs from all replicas of codec
docker service logs -f reader_codec

# Output (from all 3 instances, interleaved):
# reader_codec.1 | [codec] Connected to RabbitMQ
# reader_codec.2 | [codec] Connected to RabbitMQ
# reader_codec.3 | [codec] Connected to RabbitMQ
# reader_codec.1 | [codec] Processing batch: 100 messages
# reader_codec.2 | [codec] Processing batch: 100 messages
```

Streams logs from all replicas. Useful for debugging.

## Scaling Operations

### At Deployment Time

Set replicas in environment before deploy:

```bash
export CODEC_REPLICAS=3
export ARCHIVIST_REPLICAS=2
docker stack deploy -c modules/reader/compose.yml reader
```

Or copy `.env.swarm` and set vars inline:

```bash
CODEC_REPLICAS=3 docker stack deploy -c modules/reader/compose.yml reader
```

### During Runtime

Scale up (add capacity):

```bash
# Increase codec from 3 to 5 instances
docker service update --replicas 5 reader_codec

# Swarm immediately starts 2 new codec containers
```

Scale down (reduce capacity):

```bash
# Reduce codec from 5 to 3
docker service update --replicas 3 reader_codec

# Swarm gracefully stops 2 instances (sends SIGTERM, waits for shutdown)
```

No redeployment, no compose file edit. Instant scaling via CLI.

## Rolling Updates (Zero Downtime)

Traditional docker-compose approach:

```bash
docker-compose down       # Stop everything
docker-compose up --build # Restart everything
# During down time, no processing happens
```

Swarm approach:

```bash
# Update image in compose.yml or rebuild, then:
docker stack deploy -c modules/reader/compose.yml reader

# Swarm will:
# 1. Build new image
# 2. Start 1 new codec container with new image
# 3. Wait for health check to pass
# 4. Wait 10 seconds (delay from update_config)
# 5. Stop 1 old codec container (sends SIGTERM, waits for graceful shutdown)
# 6. Repeat for next replica (one at a time, never all at once)
```

Result: Always 2-3 instances processing during update. Queue processing doesn't pause.

**For codec with 3 replicas:**
- Minute 0: [old, old, old] processing
- Minute 0: Start [new, old, old, old] (4 briefly, but new replacing one)
- After health check: [new, old, old] processing
- Minute 0:10: Stop old → [new, old, old] processing
- Minute 0:30: [new, new, old] (same pattern)
- Minute 1:00: [new, new, new] (update complete)

Never went down.

## Failure Handling

### Container Crashes

Swarm monitors health checks on each container.

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
  interval: 30s
  timeout: 5s
  retries: 3
```

If health check fails 3 times in 30 seconds:
1. Container marked unhealthy
2. Swarm stops it
3. Restart policy triggers: `delay: 5s max_attempts: 3`
4. New container started
5. If still fails after 3 attempts, it stays down and you get an alert

### Node Crashes

If the node running a codec container crashes:
1. Swarm detects the node is unreachable
2. Reschedules affected containers to healthy nodes
3. New codec instances start elsewhere
4. Message processing resumes

This is cluster-level resilience. Not possible with single-machine docker-compose.

### Update Failures

```yaml
deploy:
  update_config:
    failure_action: rollback
```

If new image is broken and health checks fail:
1. Swarm sees new container is unhealthy
2. Stops trying new replicas
3. Rolls back to previous running image
4. Original containers keep running

You don't lose the entire stack to a bad deployment.

## Networking: The Key to Scaling

Here's why queue-based services scale so well with Swarm:

### The Old Single-Container Way

```
┌─────────────────────────────┐
│   docker-compose network     │
│                             │
│  ┌─────────┐  ┌──────────┐ │
│  │ rabbitmq│  │  codec   │ │
│  │         │  │          │ │
│  │ :5672   │  │ consumes │ │
│  └─────────┘  └──────────┘ │
│       ▲             │       │
│       └─────────────┘       │
└─────────────────────────────┘

Single codec instance. Bottleneck if queue is faster than processing.
```

### The Swarm Way

```
┌────────────────────────────────────────────────────────┐
│              Swarm Overlay Network                      │
│                                                        │
│  ┌──────────┐     ┌───────┐  ┌───────┐  ┌───────┐    │
│  │ rabbitmq │     │ codec │  │ codec │  │ codec │    │
│  │ :5672    │     │   1   │  │   2   │  │   3   │    │
│  │ 1 shared │     │       │  │       │  │       │    │
│  │ queue    │     │ reads │  │ reads │  │ reads │    │
│  └──────────┘     │  msg  │  │  msg  │  │  msg  │    │
│       ▲           │   1   │  │   2   │  │   3   │    │
│       │           └───────┘  └───────┘  └───────┘    │
│       └───────────────────────────────────────────────┘
│                   Load balanced by RabbitMQ
│
│ Messages are distributed automatically by RabbitMQ's
│ fair dispatch algorithm across 3 consumers.
└────────────────────────────────────────────────────────┘
```

All three codec containers connect to the same RabbitMQ instance (same hostname, same queue). RabbitMQ's consumer group mechanism distributes messages.

**This is standard RabbitMQ behavior; Swarm just makes it easy to run 3 instances.**

The network layer is transparent:
- Each codec instance sees `RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672`
- Swarm's DNS resolves `rabbitmq` to the same IP on every container
- All codec instances are treated equally as consumers on the queue
- No code changes, no explicit load balancing logic

## Common Questions

### Q: Do I need Kubernetes?

For TradeBot, no. Swarm is simpler:
- One CLI (`docker` instead of `kubectl`)
- Familiar Compose files
- Smaller learning curve
- Fewer moving parts
- Good enough for small-to-medium deployments

Kubernetes is overkill unless you need:
- Across-datacenter orchestration
- Complex multi-service microservices meshes
- Extreme scale (1000s of nodes)
- Your team already knows Kubernetes

### Q: What about persistent data?

Volumes in Swarm: services get storage via named volumes, but they're tied to nodes.

```yaml
volumes:
  mongodb_data:  # Named volume owned by Swarm
```

For MongoDB to work in multi-node Swarm:
- Store data on shared storage (NFS, EBS) that all nodes can access
- Or run MongoDB on a single node (our current approach)

For now: MongoDB and RabbitMQ stay single-replica. Codec/Archivist (stateless, use the queues) scale freely.

### Q: Can I mix docker-compose and docker stack?

Yes, for development:

```bash
# Local dev: single node, full control, easy debugging
docker-compose -f modules/reader/compose.yml up

# Production: orchestrated cluster, auto-restart, rolling updates
docker stack deploy -c modules/reader/compose.yml reader
```

The `deploy` block is ignored in compose, so the same file works in both contexts.

### Q: How do I know if something is healthy?

```bash
# Service level
docker service ls
# Shows: 3/3 replicas healthy, 0/3 unhealthy

# Task level
docker service ps reader_codec
# Shows each task's state (Running, Shutdown, etc.)

# Container level (on the node)
docker ps
docker logs <container-id>

# Application level (defined by you)
curl http://localhost:3000/health
# Returns service health status
```

Health checks are observable at every level.

### Q: What if I want to update just one service?

```bash
# Update codec service only
docker service update \
  --image tradebot:codec-newversion \
  reader_codec

# Swarm rolls out the new image to codec replicas only
# Other services (archivist, feed) unchanged
```

Or edit compose.yml and redeploy (affects what's changed).

### Q: Can I drain a node cleanly?

```bash
# Prevent new tasks on this node (maintenance)
docker node update --availability drain node-1

# Swarm migrates all tasks on node-1 to other nodes
# Gracefully (sends SIGTERM, waits for shutdown)

# When done with maintenance
docker node update --availability active node-1

# Can receive new tasks again
```

Useful for patching, upgrades without downtime.

## Real-World Walkthrough

### Scenario: Your queue is backed up. Codec can't keep up.

**Step 1: Check current state**

```bash
docker service ls

# Output:
# NAME               REPLICAS
# reader_codec       1/1    ← Only one instance
# reader_archivist   1/1
# reader_feed        1/1
```

Queue length is growing (you check RabbitMQ management UI at `localhost:15672`).

**Step 2: Scale codec up**

```bash
docker service update --replicas 3 reader_codec

# Swarm immediately schedules 2 new codec containers
```

**Step 3: Monitor scaling**

```bash
docker service ps reader_codec

# After a few seconds:
# ID          NAME          STATE
# abc         reader_codec.1 Running
# def         reader_codec.2 Running  ← New, starting
# ghi         reader_codec.3 Running  ← New, starting
```

**Step 4: Verify processing resumed**

```bash
docker service logs -f reader_codec

# All 3 instances now logging message processing
# Queue length dropping as throughput increases 3x
```

**Step 5: Permanent scaling (next deploy)**

Edit `.env`:
```bash
CODEC_REPLICAS=3
```

Update compose and redeploy:
```bash
docker stack deploy -c modules/reader/compose.yml reader
```

Now codec will always start with 3 replicas.

## Next Steps

1. **Read** `docs/ai/docker-swarm.md` for command reference
2. **Try locally** on a single node (not on prod cluster):
   ```bash
   docker swarm init
   docker stack deploy -c modules/reader/compose.yml reader
   ```
3. **Play with scaling:**
   ```bash
   docker service update --replicas 2 reader_codec
   # Wait, then:
   docker service update --replicas 4 reader_codec
   # Watch logs, observe queue distribution
   ```
4. **Understand failure recovery:**
   - Kill a codec container: `docker kill <container-id>`
   - Watch Swarm restart it automatically
5. **Rolling update:**
   - Change something in codec's compose.yml
   - Redeploy: `docker stack deploy -c modules/reader/compose.yml reader`
   - Observe one-at-a-time restarts

## Summary

Docker Swarm brings clustering to Docker without changing your code or file formats:

- **Same files:** Compose files work in both contexts
- **Same communication:** Services by hostname; no code changes
- **Same patterns:** The architecture you built (queue-based scaling, environment config) is perfect for Swarm
- **Simplicity:** 10 new CLI commands instead of Kubernetes's 50+
- **Transparency:** Your services don't know they're in a cluster

For TradeBot's queue-based stateless services, Swarm is a natural fit. You're already designed for it; you just didn't realize it.
