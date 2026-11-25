# Infra packs

Each directory here is an **infra pack**: a Compose project that runs shared brokers and a cache on the
external network `${PROJECT_NAME}-network` (default `tradebot-network`), which every module and pack
joins. Each pack defines some of three services. The service name is also its hostname on that network
and its container name:

| Pack | Compose project | `queue` | `queue-rt` | `cache` |
|---|---|:---:|:---:|:---:|
| `local` | `infrastructure` | — | ✓ | ✓ |
| `store` | `store` | ✓ | ✓ | — |
| `market` | `market` | ✓ | ✓ | ✓ |
| `bootcamp` | `infra-bootcamp` | — | ✓ | — |
| `shuttle` | `shuttle` | ✓ | — | — |

- `queue` and `queue-rt` are two RabbitMQ brokers, each extending
  [services/rabbitmq](../../services/rabbitmq/README.md)'s `base.yml` with its own data volume
  (`queue-data`, `queue-rt-data`). Local keeps a `queue` definition, commented out.
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
| `QUEUE_USER`, `QUEUE_PASS` | The brokers' user; both required, a pack refuses to start without them |
| `QUEUE_PORT`, `QUEUE_MGMT_PORT` | Host ports of `queue`'s AMQP (5672) and management (15672) listeners |
| `QUEUE_RT_PORT`, `QUEUE_RT_MGMT_PORT` | Host ports of `queue-rt`'s AMQP (5672) and management (15672) listeners |
| `CACHE_PASS` | The cache's password; required, a pack with a cache refuses to start without it |
| `CACHE_PORT` | Host port of the cache (6379) |
| `*_BIND` beside each port | The host address the port is published on; default `127.0.0.1` |
| `TZ` | The containers' time zone; default `UTC` |

An empty port variable still publishes the port, on a free host port docker picks
(`docker compose port` shows which).

The root `.env.example` also gives the URLs at these hostnames: `QUEUE_URL`
(`amqp://…@queue:5672`) and `CACHE_URL` (`redis://:…@cache:6379`).
