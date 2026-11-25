# Infra packs

Each directory here is an **infra pack**: a Compose project that runs a shared broker, a cache, or both,
on the external network `${PROJECT_NAME}-network` (default `tradebot-network`), which every module and
pack joins. Each pack defines one or both of two services. The service name is also its hostname on
that network and its container name:

| Pack | Compose project | `queue` | `cache` |
|---|---|:---:|:---:|
| `local` | `infrastructure` | — | ✓ |
| `store` | `store` | ✓ | — |
| `market` | `market` | ✓ | ✓ |
| `shuttle` | `shuttle` | ✓ | — |

- `queue` is a RabbitMQ broker, extending [services/rabbitmq](../../services/rabbitmq/README.md)'s
  `base.yml`, with its data in the `queue-data` volume.
- `cache` is Redis, extending [services/redis](../../services/redis/README.md)'s `compose.yml`, with its
  data in the `cache-data` volume.

Because the container names are fixed, two packs that define the same service cannot run on one host.

## Running a pack

Every pack holds a `.dxskip`, so a `tb` command that names no module leaves the packs out. Start one by
name; `tb` creates the shared network first when it does not exist:

```sh
tb up <pack>
tb down <pack>
```

## Variables

The packs read these from the root `.env` (see the root `.env.example`):

| Variable | Used for |
|---|---|
| `PROJECT_NAME` | The shared network's name, `${PROJECT_NAME}-network` |
| `QUEUE_USER`, `QUEUE_PASS` | The broker's user; both required, a pack with a broker refuses to start without them |
| `QUEUE_PORT`, `QUEUE_MGMT_PORT` | Host ports of `queue`'s AMQP (5672) and management (15672) listeners |
| `CACHE_PASS` | The cache's password; required, a pack with a cache refuses to start without it |
| `CACHE_PORT` | Host port of the cache (6379) |
| `QUEUE_MEM_LIMIT`, `CACHE_MEM_LIMIT` | Each container's memory limit; default `2GiB` and `1GiB`. The broker also takes its own as its total memory ([services/rabbitmq](../../services/rabbitmq/README.md#memory)) |
| `*_BIND` beside each port | The host address the port is published on; default `127.0.0.1` |
| `TZ` | The containers' time zone; default `UTC` |

An empty port variable still publishes the port, on a free host port docker picks
(`docker compose port` shows which).

The root `.env.example` also gives the URLs at these hostnames: `QUEUE_URL`
(`amqp://…@queue:5672`) and `CACHE_URL` (`redis://:…@cache:6379`).
