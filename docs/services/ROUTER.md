# Router

The router consumes messages from RabbitMQ source queues and republishes each one to the
destinations its rules give, optionally rewriting the routing key and adding headers. Rules are set
in `ROUTER_RULES`, written in the shared rule grammar (see
[shared/utils/README.md](../../shared/utils/README.md#rule-grammar)). This doc covers what the
router makes of a rule.

## Sources

A source is always a queue; the router consumes it.

| Written | The router declares |
|---|---|
| `q` | durable queue `q`, consumed as it is |
| `q@type:x` or `q@x` | exchange `x` and durable queue `q` bound to it |

The binding key of a source queue on an exchange is its `(key:pattern)`. Without one, a `topic`
exchange binds with `#`, and a `direct` exchange is rejected: it has no wildcard. `fanout` and
`headers` exchanges ignore the key; a `headers` binding carries no arguments, so it matches every
message.

A source takes no other modifier: no `(key:...)` on a bare queue, no `(key:match:replace)`, no
`(header:...)`. A source cannot use the `default` type.

Several rules may read one source queue, since every rule on a queue receives every message the
queue gets. They must read it from the same exchange, and either bind it with the same key or
deliver to the same destinations, in which case the queue is bound with all their keys.

## Destinations

| Written | The router declares | Publishes to | Routing key |
|---|---|---|---|
| `q` | durable queue `q` | the default exchange | `q` |
| `@type:x` | exchange `x` | `x` | per the key modifier |
| `q@type:x` | exchange `x` and durable queue `q` bound to it | `x` | per the key modifier |

A bare destination queue is reached through the default exchange, so its routing key is always the
queue's name and the incoming key is lost; it takes no `(key:...)`. To keep the incoming key,
publish to an exchange.

A queue on a destination exchange is bound so that it receives everything the router publishes
there:

| Exchange type | Binding key of the queue |
|---|---|
| `topic` | the static key when the destination has one, otherwise `#`; with `#` the queue also receives whatever else is published to the exchange |
| `direct` | the static key; a destination without one is rejected |
| `fanout`, `headers` | empty (the broker ignores it; the `headers` binding matches every message) |

### Routing key

On an exchange destination:

| Modifier | Outgoing routing key |
|---|---|
| none | the incoming key |
| `(key:k)` | always `k` |
| `(key:match:replace)` | an incoming key equal to `match` or starting with `match.` has that part replaced by `replace`, taken literally; any other key passes unchanged |

With `(key:message:collect)`, `message.trade` becomes `collect.trade`, and `messages.trade` passes
unchanged.

### Headers

`(header:name=value)` sets a header on every message published to that destination. An injected
header replaces an incoming header of the same name; the other headers are kept.

### Exchange types

Each exchange name has one type across all rules, sources and destinations alike. A mention without
a type takes the type the name is given elsewhere; a name that is never typed is `fanout`; two
different types for one name are rejected. On a destination, `default` is declared as a `direct`
exchange.

## Validation

The router checks its rules and settings at startup and does not start when any is invalid. The
route checks report every problem they find in one error. Beyond the grammar's own parse errors, it
rejects:

- an empty `ROUTER_RULES`, or a missing `QUEUE_URL`
- a source without a queue, and a source modifier listed under [Sources](#sources)
- a source on a `direct` exchange without `(key:...)`
- a `(key:...)` on a bare destination queue
- a queue on a `direct` destination without a static `(key:...)`
- a rule that delivers into its own source queue, or publishes into its own source exchange
- one exchange name given two types
- the same rule given twice
- rules that share a source queue against the conditions under [Sources](#sources)
- `ROUTER_MAX_READY` without `ROUTER_WATCH_QUEUES`, or the reverse, and an integer setting that is
  not a whole number in range

## Message handling

The router runs one consumer per source queue. Each message goes to every distinct destination of
the rules on that queue; rules that share the queue and name the same destination publish once.

- The body is forwarded as the bytes received. AMQP properties are kept, except the user id, which
  is dropped; a message that arrived without a content type is published with `application/json`.
  The message stays persistent exactly when it arrived persistent.
- Destinations are published in order. The message is acked once every destination has it.
- When a publish fails, the message is requeued, so destinations that already had it receive it
  again: delivery is at least once per destination. The requeue waits 500 ms while the publishing
  connection is up, or until it reconnects. Failures are logged at most once per 10 s per source
  queue, with the count of those left out.
- The router publishes without the mandatory flag: a message that a destination exchange routes to
  no queue is dropped by the broker, and the router still acks it.
- At most `ROUTER_PREFETCH` messages per source queue are unacknowledged at a time.

## Connections

The router opens two connections to `QUEUE_URL`. The consumer connection declares the source queues
and exchanges and consumes from them; the publisher connection declares the destinations and
publishes to them.

At startup the consumer connection is tried up to 10 times, with exponential backoff, before the
router gives up and shuts down; the publisher connection is retried until it opens. Once running,
the consumer connection is not re-established: when it is lost, the router exits with code 1. The
publisher connection reconnects without limit and declares its topology again. The router also exits
with code 1 when the broker cancels one of its consumers, as it does when a source queue is deleted.
Restarting is left to the container's restart policy (`unless-stopped` in the compose file).

## Backpressure

With `ROUTER_MAX_READY` above 0, publishing pauses while any queue in `ROUTER_WATCH_QUEUES` holds
`ROUTER_MAX_READY` ready messages or more.

- Depths are read at startup and then every 2 s, with a passive queue check, so the router does
  not declare the watched queues. Before each message is published, the latest depths are
  compared with the limit.
- While a queue is at or above the limit, every source queue waits. The router reads that queue's
  depth every 1 s and resumes all of them together once no watched queue is at or above the limit.
- A watched queue that does not exist counts as empty, with a warning at most once a minute. A depth
  that cannot be read keeps its last value, and counts as 0 until one is read: the pause fails open.
- The checks run on a channel of their own on the consumer connection, so a failed check does not
  close the consuming channel.

A paused router still holds up to `ROUTER_PREFETCH` unacknowledged messages per source queue.

## Configuration

RabbitMQ comes from an infra pack (see [modules/infra/README.md](../../modules/infra/README.md)).

| Variable | Required | Default | Description |
|---|---|---|---|
| `QUEUE_URL` | Yes | - | AMQP URL; both connections use it |
| `ROUTER_RULES` | Yes | - | Rules, in the [rule grammar](../../shared/utils/README.md#rule-grammar) |
| `ROUTER_PREFETCH` | No | `500` | Most unacknowledged messages per source queue; a positive integer |
| `ROUTER_MAX_READY` | No | `0` (off) | Ready messages in a watched queue at which publishing pauses; a non-negative integer |
| `ROUTER_WATCH_QUEUES` | With `ROUTER_MAX_READY` | - | Comma-separated queues to watch; set exactly when `ROUTER_MAX_READY` is above 0 |

`services/router/docker/compose.yml` passes all of them, with the same defaults.

## Health

The health server answers on port 3000 (`curl http://router:3000/health`):

- `200` `{"healthy":true,"brokers":{"consumer":"connected","publisher":"connected"}}` while both
  connections are up;
- `503` with `"healthy":false` and each connection's state otherwise, as while the publisher
  reconnects.

Until both connections are first up at startup, it answers `200` `{"status":"ok"}`. The compose
healthcheck requests `/health` every 30 s.

## Examples

```bash
# Queue to queue, through the default exchange
ROUTER_RULES="src > dst"

# Fan-out to two queues
ROUTER_RULES="src > dst & audit"

# Read a topic exchange, republish to a fanout exchange; subscribers bind their own queues
ROUTER_RULES="src@topic:events > @fanout:broadcast"

# Rewrite the key prefix: message.trade becomes collect.trade
ROUTER_RULES="src@topic:events > @topic:collected(key:message:collect)"

# Keep the incoming key, and declare a queue that receives everything on the exchange (bound with #)
ROUTER_RULES="src@topic:events > dst@topic:out"

# A static key and an injected header; the queue is bound with the key
ROUTER_RULES="src@topic:events > dst@direct:out(key:trade,header:x-origin=router)"

# Several rules, one per line
ROUTER_RULES="
  | src@topic:events(key:trade.#) > trades
  | audit.in > @fanout:audit
"
```
