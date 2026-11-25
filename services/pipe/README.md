# Pipe Service

A one-shot service that declares native RabbitMQ exchange-to-exchange bindings, and optionally
durable queues inside the destination exchanges. It does not consume or republish messages: it
declares the bindings and exits, and the broker forwards messages itself.

Deployed by: no module.

## Core Functionality

- **Exchange-to-exchange bindings** — native RabbitMQ bindings, no consumer loop
- **Queue assertion on destination** — optionally a durable queue inside the destination exchange
- **Fanout, topic, direct, headers** — any combination of exchange types
- **Routing key filter** — a binding key on the source side
- **Multiple bindings** — one run declares every binding given
- **One-shot** — exits 0 once everything is declared, 1 when the broker cannot be reached or rejects
  a declaration; the compose file restarts it only on failure (`restart: on-failure`)

Pipe has no health endpoint.

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

## Configuration

Requires RabbitMQ — see [infra packs](../../modules/infra/README.md).

**Required:**
- `QUEUE_URL` — AMQP URL of the broker
- `PIPE_BINDINGS` — binding rules (see below)

### Bindings

`PIPE_BINDINGS` is written in the [rule grammar](../../shared/utils/README.md#rule-grammar) of
`@tradebot/utils`, restricted to this form:

```
source[(key:pattern)] > destination

source      ::= type:name | @[type:]name
destination ::= type:name | [queue]@[type:]name
```

Pipe adds these rules:

- **Both sides are exchanges.** A bare name is a queue and is rejected, so `events > audit` fails;
  write `@events > @audit` or `fanout:events > fanout:audit`.
- **Types:** `fanout`, `topic`, `direct`, `headers`. The `default` type is rejected. Each exchange
  name has one type across all bindings: a mention without a type takes the type the name is
  given elsewhere, a name that is never typed is `fanout`, and two types for one name are rejected.
- **A routing key only on the source**, as the binding key. A `(key:...)` on the destination, a
  `(key:value:replace)` and `(header:...)` modifiers are rejected.
- **`queue@` only on the destination.** It declares a durable queue of that name inside the
  destination exchange, bound with `#`. It is rejected on a `direct` destination, where `#` is a
  literal key and would match only messages routed with exactly `#`.
- `&` and `|` work as the grammar defines: `topic:events & fanout:other > fanout:all` declares two
  bindings.

**Binding key by source type:**

| Type | Default key | Notes |
|---|---|---|
| `fanout` | _(none)_ | The broker ignores the key |
| `topic` | `#` | Forwards everything; give `(key:pattern)` to filter |
| `direct` | _required_ | `(key:exact-key)` must be given; there is no wildcard |
| `headers` | _(none)_ | The binding carries no header arguments, so it matches and forwards everything; header-based filtering is not supported |

### Examples

**Fanout to fanout:**
```bash
PIPE_BINDINGS="fanout:events > fanout:audit"
```

**Type omitted (fanout):**
```bash
PIPE_BINDINGS="@events > @audit"
```

**Topic source, all messages (default `#`):**
```bash
PIPE_BINDINGS="topic:events > topic:archive"
```

**Topic source with a key filter:**
```bash
PIPE_BINDINGS="topic:events(key:trade.*) > fanout:trades"
```
Only messages whose key matches `trade.*` flow from `events` into `trades`.

**One source to two destinations:**
```bash
PIPE_BINDINGS="fanout:events > fanout:audit & fanout:archive"
```

**Chain (A → B → C):**
```bash
PIPE_BINDINGS="fanout:a > fanout:b | fanout:b > fanout:c"
```

**A queue inside the destination exchange:**
```bash
PIPE_BINDINGS="topic:events > sink@topic:sink"
```
This binds exchange `sink` to `events` and declares a durable queue `sink` inside `sink`, bound
with `#`. Consumers can then read queue `sink` without declaring it.

## Message Flow

```
Source Exchange
    ↓ (native RabbitMQ exchange-to-exchange binding — no service involvement)
Destination Exchange
```

Exchanges and queues are declared durable, so they and their bindings outlive pipe and broker
restarts. Running pipe again redeclares them, which changes nothing when they already exist; a
declaration that conflicts with an existing exchange, such as another type under the same name, is
rejected by the broker and pipe exits with 1.

For per-message routing key rewrites and headers, see the [router](../router/README.md).
