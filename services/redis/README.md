# Redis

A Redis 7.4 cache (`redis:7.4-alpine`), kept on disk with an append-only file so its data survives a
restart.

Deployed by: the `local` and `market` infra packs, as `cache` (see
[modules/infra](../../modules/infra/README.md)).

## Definition

`docker/compose.yml` defines service `redis`, which is also its hostname on its network. It runs
`redis-server --appendonly yes --requirepass "$CACHE_PASS"`, keeps its data in `/data` on the
`redis-data` volume, and checks its health with an authenticated `redis-cli ping` that reads the password
from the container's environment, keeping it off the command line. An instance that extends it sets its
own name, ports and volume.

## Variables

| Variable | Meaning |
|---|---|
| `CACHE_PASS` | The password. Required: compose refuses to start the service when it is unset or empty, since an empty password would turn authentication off. Clients authenticate as Redis's `default` user, so a URL carries no user name. |
| `CACHE_PORT` | The host port published for 6379. Empty still publishes, on a free host port docker picks; `docker compose port` shows which. |
| `CACHE_BIND` | The host address the port is published on. Default `127.0.0.1`, so only the host connects. |
| `TZ` | The container's time zone. Default `UTC`. |

A client connects with `redis://:<CACHE_PASS>@<host>:6379`, the password percent-encoded if it holds a
character reserved in URLs.
