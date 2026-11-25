# RabbitMQ

A RabbitMQ 4.3 message broker with the management plugin (`rabbitmq:4.3.8-management-alpine`).

Deployed by: the `store`, `market` and `shuttle` infra packs, as `queue` (see
[modules/infra](../../modules/infra/README.md)).

## Files

| File | What it is |
|---|---|
| `docker/base.yml` | The broker definition, service `rabbitmq`, meant to be extended: each instance sets its own hostname, container name, ports and data volume. |
| `docker/compose.yml` | One standalone instance of it, service, hostname and container `rabbitmq`, with its data in the `rabbitmq-data` volume. |
| `docker/rabbitmq.conf` | Mounted as `/etc/rabbitmq/conf.d/90-tradebot.conf`, read after the image's own `10-defaults.conf`: console logging, `guest` limited to loopback, listeners on 5672 (AMQP) and 15672 (management), the broker's total memory and watermark (see [Memory](#memory)), TCP buffers, a 60 s heartbeat. |
| `docker/advanced.config` | Mounted as `/etc/rabbitmq/advanced.config`: raises the connection-to-queue credit flow to `{4000, 2000}`. |

Data lives in `/var/lib/rabbitmq`, on the instance's volume. The healthcheck is
`rabbitmq-diagnostics -q ping`.

## Credentials

| Variable | Meaning |
|---|---|
| `QUEUE_USER` | The broker's user, created on its first start with full administrator rights. Required: compose refuses to start the broker without it. |
| `QUEUE_PASS` | That user's password. Required. |

The user is created only when the data volume is empty; changing the variables later does not change an
existing broker's user. `guest` logs in only from inside the container.

A client connects with `amqp://<QUEUE_USER>:<QUEUE_PASS>@<host>:5672`, each percent-encoded if it holds a
character reserved in URLs.

## Memory

| Variable | Default | Meaning |
|---|---|---|
| `QUEUE_MEM_LIMIT` | `2GiB` | The container's memory limit, and the broker's total memory. |

The broker reads the host's RAM as its total and ignores the container's limit, so `rabbitmq.conf` sets
`total_memory_available_override_value` from `QUEUE_MEM_LIMIT`, which `base.yml` passes into the
container. Publishers are blocked once the broker uses 0.6 of that total (`vm_memory_high_watermark.relative`).

A whole number of bytes, `KiB`, `MiB` or `GiB` means the same to compose and to the broker. Compose reads
`2g` and `2GB` as 2 GiB, the broker as 2,000,000,000 bytes, which leaves its total a little under the
limit.

## Ports

The standalone `compose.yml` publishes:

| Variable | Container port | Bind variable |
|---|---|---|
| `QUEUE_PORT` | 5672 (AMQP) | `QUEUE_BIND` |
| `QUEUE_MGMT_PORT` | 15672 (management UI and HTTP API) | `QUEUE_MGMT_BIND` |

A bind address defaults to `127.0.0.1`, so only the host connects. An empty port variable still
publishes, on a free host port docker picks; `docker compose port` shows which. The management UI is at
`http://<bind>:<port>`, with the `QUEUE_USER` login.

Each pack publishes its own instances' ports under its own variables (see
[modules/infra](../../modules/infra/README.md)).
