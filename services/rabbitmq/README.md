# RabbitMQ

A RabbitMQ 3.12 message broker with the management plugin (`rabbitmq:3.12-management-alpine`).

Deployed by: the `local`, `store`, `market`, `bootcamp` and `shuttle` infra packs, as `queue` and
`queue-rt` (see [modules/infra](../../modules/infra/README.md) for which pack defines which).

## Files

| File | What it is |
|---|---|
| `docker/base.yml` | The broker definition, service `rabbitmq`, meant to be extended: each instance sets its own hostname, container name, ports and data volume. |
| `docker/compose.yml` | One standalone instance of it, service, hostname and container `rabbitmq`, with its data in the `rabbitmq-data` volume. |
| `docker/rabbitmq.conf` | Mounted as `/etc/rabbitmq/conf.d/90-tradebot.conf`, read after the image's own `10-defaults.conf`: console logging, `guest` limited to loopback, listeners on 5672 (AMQP) and 15672 (management), memory watermark, TCP buffers, a 60 s heartbeat. |
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
