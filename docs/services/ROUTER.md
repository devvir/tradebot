# Router Service - Technical Documentation

## Overview

The Router service consumes messages from RabbitMQ source queues and republishes them to destination queues or exchanges, applying configurable routing key transforms and header injection. It supports fan-out (one source to many destinations), explicit exchange bindings, and static header injection per destination.

## Rule Syntax

Rules are set via the `ROUTER_RULES` environment variable. Each rule has the form:

```
sources > destinations
```

**Full source syntax:**
```
queue[@type:exchange][(key:bindingKey)]
```

**Full destination syntax:**
```
[queue][@type:exchange][(modifier,...)]
```

Where:
- `queue` — queue name (required on sources, optional on destinations with `@`)
- `@type:exchange` — explicit exchange (`@` prefix is mandatory)
  - `type` — exchange type: `fanout`, `topic`, `direct`, `headers`, `default`
  - `exchange` — exchange name
- `(modifier,...)` — comma-separated modifiers: `key:...` and/or `header:name=value`
- `&` — separator for multiple sources or destinations
- `>` — separator between sources and destinations
- `|` — separator between multiple rules

A colon (`:`) without `@` is treated as an error — write `@fanout:broadcast`, not `fanout:broadcast`.

## Modifiers

Modifiers are comma-separated tokens inside `(...)` on sources or destinations.

### Routing key — `key:`

**On sources** — sets the AMQP binding key:
- `(key:#)` — catch-all (default for topic/direct if omitted)
- `(key:trade.*)` — specific pattern

**On destinations** — overrides or transforms the outgoing routing key:
- `(key:collect)` — always publish with static key `collect`
- `(key:message:collect)` — replace `message` with `collect` in the incoming routing key
  - Example: `message.trade` → `collect.trade`
- Omitted — pass through the incoming routing key unchanged

`(key:match:replace)` is only valid on destinations.

### Header injection — `header:`

Injects a static AMQP header into every republished message at that destination. Merged non-destructively with any existing headers.

```
(header:name=value)
```

- `name` must be non-empty; `value` may be empty
- Multiple `header:` entries allowed in one modifier group

## Examples

**Simple route (default exchange):**
```bash
ROUTER_RULES="broadcast > writer"
```

**Fan-out to multiple destinations:**
```bash
ROUTER_RULES="broadcast > codec.in & writer"
```

**With explicit exchange binding:**
```bash
ROUTER_RULES="broadcast@fanout:broadcast > codec.in@fanout:codec"
```

**Exchange-only destination (broadcast pattern):**
```bash
ROUTER_RULES="broadcast@topic:broadcast > @fanout:broadcast"
```
Consumes from Broadcast's topic exchange, republishes to a fanout. No destination queue is declared — subscribers bind their own queues independently.

**With routing key replacement:**
```bash
ROUTER_RULES="collect@topic:broadcast > collect@topic:writer(key:message:collect)"
```
Incoming `message.trade` becomes `collect.trade`.

**With header injection:**
```bash
ROUTER_RULES="src@topic:broadcast > dst@topic:writer(key:message:collect,header:x-writer-database=tradebot_collect)"
```
Routing key replacement plus injects `x-writer-database` into every message.

**Multiple rules:**
```bash
ROUTER_RULES="
  | broadcast > codec.in & writer
  | reader > codec.reader & archive
"
```

**Multiple sources:**
```bash
ROUTER_RULES="broadcast & reader > writer"
```

## Architecture

### Message Flow

```
Source Queue (default or explicit exchange)
    ↓ (consume)
 Router Service
    ↓ (optional routing key transform + header merge)
Destination Queue/Exchange (default or explicit)
```

### Behaviour

1. Router declares topology (exchanges, queues, bindings) at startup.
2. For each message received:
   - Preserves message content, all headers, and AMQP properties
   - Applies routing key transform if configured
   - Merges injected headers if configured (non-destructive)
   - Forwards to all destination queues/exchanges (true fan-out)
   - Uses raw byte forwarding — no parse/serialize round-trip
3. Acknowledges on successful publish; requeues on error.

### Default Exchange & Routing Keys

When a destination uses the **default exchange** (bare queue name, no `@`), the routing key is always set to the destination queue name — this is how the default exchange works. The original routing key is not preserved.

Use an explicit exchange if routing key preservation matters:

```bash
# Routing key lost — default exchange overwrites it
ROUTER_RULES="broadcast@topic:broadcast > writer"

# Routing key preserved — explicit exchange keeps it
ROUTER_RULES="broadcast@topic:broadcast > writer@topic:writer"
```

## Rule Validation

Rules are validated at startup. Rejected conditions:
- Missing `>` separator, or more than one
- No sources or no destinations
- Source without a queue name (sources consume from queues)
- Colon without `@` (likely a missing `@` before an exchange spec)
- Invalid exchange type
- `(key:match:replace)` on a source
- `header:` without `=`, or with an empty name
- Unknown modifier prefixes

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RABBITMQ_URL` | Yes | - | RabbitMQ connection string |
| `ROUTER_RULES` | Yes | - | Routing rules (see syntax above) |

## Health Monitoring

```bash
curl http://router:3000/health
```

Returns service status and configured routes. Available only after topology is declared at startup.

**Response (200 - Healthy):** broker connected, topology declared.

**Response (503 - Unhealthy):** broker not connected or startup incomplete.
