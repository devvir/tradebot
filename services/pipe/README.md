# Pipe Service

A one-shot service that declares native RabbitMQ exchange-to-exchange bindings and optionally asserts queues. Unlike the Router, it does not consume or republish messages — it simply wires exchanges together at the broker level and exits. RabbitMQ handles message forwarding natively with zero CPU overhead.

## Core Functionality

- **Exchange-to-exchange bindings** — native RabbitMQ E2E bindings, no consumer loop
- **Queue assertion on destination** — optionally assert a durable queue inside the destination exchange
- **Fanout, topic, direct, headers** — any combination of exchange types
- **Routing key filter** — topic sources default to `#` (all messages); direct requires an explicit key; fanout/headers ignore the routing key and match all messages by default
- **Multiple bindings** — single invocation declares N bindings at once
- **One-shot** — exits 0 on success; restarts only on failure (`restart: on-failure`)

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

## Configuration

Requires RabbitMQ — see [infra packs](../../modules/infra/README.md).

**Required:**
- `PIPE_BINDINGS` — Binding rules (see syntax below)

### Binding Syntax

```
[type:]source[(key:bindingKey)] > [queue@][type:]destination
```

Where:
- `type` — exchange type: `fanout`, `topic`, `direct`, `headers` (defaults to `fanout` if omitted)
- `name` — exchange name
- `(key:...)` — binding key on the **source** side only
- `queue@` — optional prefix on the **destination** side; asserts a durable queue named `queue` inside the destination exchange, bound with routing key `#`
- `|` — separator between multiple bindings

**Default binding keys by exchange type:**

| Type | Default key | Notes |
|---|---|---|
| `fanout` | _(none)_ | Routing key ignored by broker |
| `topic` | `#` | Passes all messages; specify `(key:pattern)` to filter |
| `direct` | _required_ | Must specify `(key:exact-key)` — no wildcard exists |
| `headers` | _(none)_ | Routing key ignored; pipe binds with `{}` (match-all), forwarding all messages. Header-based filtering is not yet supported |

**Important:** Routing keys belong on the source side. Placing `(key:...)` on the destination is rejected — E2E bindings have no concept of a destination routing key.

### Examples

**Simple fanout-to-fanout:**
```bash
PIPE_BINDINGS="fanout:broadcast > fanout:ingest"
```

**Topic source — all messages (default `#`):**
```bash
PIPE_BINDINGS="topic:codec.out > topic:writer"
```

**Topic source with routing key filter:**
```bash
PIPE_BINDINGS="topic:events(key:trade.*) > fanout:archive"
```
Only messages matching `trade.*` flow from `events` into `archive`.

**Type omitted (defaults to fanout):**
```bash
PIPE_BINDINGS="broadcast > ingest"
```

**Fan-out one source to multiple destinations:**
```bash
PIPE_BINDINGS="fanout:broadcast > fanout:ingest | fanout:broadcast > fanout:archive"
```

**Chain (A → B → C):**
```bash
PIPE_BINDINGS="fanout:a > fanout:b | fanout:b > fanout:c"
```

**Mixed types:**
```bash
PIPE_BINDINGS="topic:events(key:trade.*) > fanout:archive | fanout:broadcast > fanout:replay"
```

**Assert a queue inside the destination exchange:**
```bash
PIPE_BINDINGS="topic:broadcast > journalist@topic:journalist"
```
This creates the E2E binding `broadcast → journalist` **and** asserts a durable queue `journalist` inside exchange `journalist` (bound with `#`). The journalist service can then consume from `journalist` queue without declaring it itself.

## Message Flow

```
Source Exchange
    ↓ (native RabbitMQ E2E binding — no service involvement)
Destination Exchange
```

Once declared, bindings are **persisted by RabbitMQ** and survive service restarts. They are only lost if the broker's data volume is wiped, in which case the pipe service will redeclare them on its next run.

## Pipe vs Router

| | Pipe | Router |
|---|---|---|
| Mechanism | Native E2E binding | Consume + republish |
| Routing key transform | ✗ | ✓ |
| CPU overhead | None | Per message |
| Process lifetime | One-shot | Long-running |
| Headers preserved | ✓ (by broker) | ✓ (explicit) |
| Restart policy | `on-failure` | `unless-stopped` |

Use **Pipe** when you only need to forward messages between exchanges as-is. Use **Router** when you need routing key transformation or queue-level control.
