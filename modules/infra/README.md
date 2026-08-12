# Infrastructure Packs

Each subdirectory is an **infra pack** — a Compose project that provides shared infrastructure for a specific server role. Infra packs and app modules run as separate Compose projects and communicate over a shared Docker network (`${PROJECT_NAME}-network`).

Start the infra pack before the app modules:

```sh
tb up <infra-pack> --build -d
tb up <module> --build -d
```

All infra services restart `unless-stopped` by default.

---

## Abstract service names

Services never reference a concrete container name. They connect via these stable hostnames, which are provided by whichever infra pack is running:

| Hostname | Role | Description |
|---|---|---|
| `queue` | Message broker | General / batch RabbitMQ |
| `queue-rt` | Message broker | Real-time live data RabbitMQ |
| `bouncer` | Auth | API credential signing |
| `redis` | Cache | Fast in-memory cache |

A service compose file maps abstract → concrete via environment variables:

```yaml
services:
  writer:
    environment:
      DB_URL: ${DB_URL}   # which db-* this writer talks to
      QUEUE_URL: ${QUEUE_RT_URL}
```

The constructed `DB_*_URL` and `QUEUE_*_URL` values all live in the root `.env`.

---

## Packs

| Pack | Server role | `queue` | `queue-rt` | `bouncer` | `redis` |
|---|---|:---:|:---:|:---:|:---:|
| [local](#local) | Local development | ✓ | ✓ | ✓ | ✓ |
| [store](#store) | Data collection | ✓ | ✓ | ✓ | — |
| [market](#market) | Live trading | ✓ | ✓ | ✓ | ✓ |
| [bootcamp](#bootcamp) | Replay / training | — | ✓ | ✓ | — |
| [shuttle](#shuttle) | Data fetch/move | ✓ | — | — | — |

---

## Infra Pack: local

**Role:** Local development. Covers all server roles simultaneously.

Two RabbitMQ instances isolate RT feed traffic from batch processing, so every module pattern works without running separate hosts.

---

## Infra Pack: store

**Role:** Data collection server. Runs history modules (archivist, collector, archeologist, packer).

Two separate RabbitMQ instances prevent RT feed traffic (`queue-rt`) from competing with batch processing (`queue`).

---

## Infra Pack: market

**Role:** Live trading server. Runs the gui and trading modules.

Redis provides fast order/position caching. `queue` carries trading signals; `queue-rt` carries the live venue feed.

---

## Infra Pack: bootcamp

**Role:** Model training / replay server. Runs trading modules against stored historical data.

No batch queue — replay is driven entirely through `queue-rt`. No live feed — data comes from the vault. The replay surface itself is unbuilt and waits on the per-venue APIs.

---

## Infra Pack: shuttle

**Role:** Data fetch / move server. Runs concierge, student, or witness modules.

Shuttle fetches data from BitMEX REST or moves data between server roles. It owns a local `queue` for internal pipelines but connects to remote databases via `DB_*_URL` — no local database containers. No bouncer — shuttle performs no authenticated BitMEX requests.

