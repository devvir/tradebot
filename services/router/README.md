# Router Service

A lightweight message routing service that connects RabbitMQ queues and exchanges. Routes messages from source queues to destination queues/exchanges with configurable routing key transforms, supporting default and explicit exchange bindings.

## Core Functionality

- **Queue-based routing** — configurable source queue → destination queue/exchange mappings
- **Flexible exchange binding** — sources/destinations can use default exchange or bind to explicit exchanges
- **Routing key transforms** — static routing keys or string replacement on incoming routing keys
- **Fan-out routing** — single source to multiple destinations
- **Header & payload preservation** — all message properties pass through unchanged
- **Durable queues** — messages persist across router restarts
- **Multiple routes** — single router instance handles N source/destination pairs
- **Automatic reconnection** — via @devvir/rabbitmq keepAlive
- **Graceful shutdown** — proper cleanup on SIGTERM

## Scripts

```bash
pnpm build           # Compile TypeScript
pnpm start           # Run compiled service
pnpm dev             # Watch mode with ts-node
pnpm test            # Run test suite
pnpm test:watch      # Watch mode tests
pnpm test:coverage   # Coverage report
```

## Configuration

**Required:**
- `RABBITMQ_URL` — RabbitMQ connection string
- `ROUTER_RULES` — Routing rules (see syntax below)

### Rule Syntax

Sources (left of `>`) consume from queues. Destinations (right of `>`) publish to exchanges.

**Basic format (default exchange):**
```
source_queue > destination_queue
```

**Full source syntax:**
```
queue[@type:exchange][(key:bindingKey)]
```

**Full destination syntax:**
```
[queue]@type:exchange[(key:routingKey)]
```

Or for default exchange destinations (bare queue name):
```
queue
```

Where:
- `queue` — queue name (required on sources, optional on destinations with `@`)
- `@type:exchange` — explicit exchange (required if not using default exchange)
  - `type` — exchange type: `fanout`, `topic`, `direct`, `headers`, `default`
  - `exchange` — exchange name
  - The `@` prefix is **mandatory** for any exchange reference
- `(key:...)` — routing key configuration (optional, see below)
- `&` — separator for multiple sources or destinations
- `>` — separator between sources and destinations

**Important:** A colon (`:`) without `@` is treated as an error, not a queue name. If you write `fanout:broadcast` without `@`, the parser will reject it and suggest `@fanout:broadcast`.

### Routing Key Configuration

The `(key:...)` suffix controls how routing keys are handled.

**On sources** — sets the binding key for exchange binding:
- `(key:#)` — bind with catch-all pattern (default for topic/direct if omitted)
- `(key:trade.*)` — bind with specific pattern

**On destinations** — controls the outgoing routing key:
- `(key:collect)` — always publish with static routing key `collect`
- `(key:message:collect)` — replace `message` with `collect` in the incoming routing key
  - Example: incoming `message.trade` → outgoing `collect.trade`
- Omitted — pass through the incoming routing key unchanged

`(key:match:replace)` is only valid on destinations (transforming a binding key makes no sense).

### Examples

**Simple route (default exchange):**
```bash
ROUTER_RULES="feed > writer"
```

**Fan-out to multiple destinations:**
```bash
ROUTER_RULES="feed > codec.in & writer"
```

**With explicit exchange binding:**
```bash
ROUTER_RULES="feed@fanout:ex.feed > codec.in@fanout:ex.codec"
```

**Exchange-only destination (broadcast pattern):**
```bash
ROUTER_RULES="broadcast@topic:feed > @fanout:broadcast"
```
Consumes from Feed's topic exchange, republishes to a fanout exchange. No destination queue is declared — subscribers bind their own queues independently.

**With routing key replacement (Collector module):**
```bash
ROUTER_RULES="collect@topic:feed > collect@topic:writer(key:message:collect)"
```
Consumes from Feed's topic exchange, replaces `message` prefix with `collect`, republishes to Writer's topic exchange. Incoming `message.trade` becomes `collect.trade`.

**Multiple rules:**
```bash
ROUTER_RULES="
  | feed > codec.in & writer
  | reader > codec.reader & archive
"
```

**Multiple sources:**
```bash
ROUTER_RULES="feed & reader > writer"
```

### Rule Validation

Rules are validated on startup:
- Must have exactly one `>` separator
- Must have at least one source and one destination
- Sources must have a queue name (you consume from queues)
- Destinations can be exchange-only (`@type:exchange`) or queue-based
- A colon without `@` is rejected (likely a missing `@` before an exchange spec)
- Exchange type must be valid if specified
- `(key:match:replace)` only allowed on destinations
- Duplicate source queues across rules are naturally deduplicated

## Message Flow

```
Source Queue (default or explicit exchange)
    ↓ (consume)
 Router Service
    ↓ (republish with optional routing key transform)
Destination Queue/Exchange (default or explicit)
```

### Behavior

1. Router declares topology (exchanges, queues, bindings) at startup
2. Health check endpoint becomes available only after topology is declared
3. For each message received:
   - Preserves message content, headers, and all AMQP properties
   - Applies routing key transform if configured
   - Forwards to ALL destination queues/exchanges (true fan-out)
   - Uses raw byte forwarding (no parse/serialize round-trip)
4. Acknowledges on successful publish
5. Requeues on error (automatic retry)

### Default Exchange & Routing Keys

When a destination uses the **default exchange** (bare queue name, no `@`), the routing key is always set to the destination queue name — this is how the default exchange works (routing key = target queue name). The original routing key from the incoming message is **not preserved**.

If you need routing key preservation across the route, use an explicit exchange instead:

```bash
# Routing key lost — default exchange overwrites it with "writer"
ROUTER_RULES="feed@topic:ex.feed > writer"

# Routing key preserved — explicit exchange keeps it
ROUTER_RULES="feed@topic:ex.feed > writer@topic:ex.writer"
```

## Health Check

```bash
curl http://router:3000/health
```

Returns service status and configured routes.
