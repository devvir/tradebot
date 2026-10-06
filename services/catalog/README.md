# Catalog

The public API over what prospector has catalogued: what each venue publishes, every venue's files as
one S3-style bucket, and the lenses consumers read through.

It surveys nothing, downloads nothing and writes nothing. It opens the `catalog.db` prospector writes
**read-only** and answers from it. What it is sent to be stored — a lens, a download report — it
forwards to prospector, the database's only writer.

```
GET  /venues[/:venue[/markets/:market]][/symbols]
GET  /listings?prefix=<venue>/          S3 ListObjects, V1 or V2
POST /listings/report                  by Key; settled by prospector
     /lenses …                         check, size, resolve; create and edit are stored by prospector
```

Every endpoint is in [CATALOG-API.md](../../docs/modules/CATALOG-API.md); how it is built is in
[CATALOG.md](../../docs/services/CATALOG.md).

## Environment

| variable | default | |
|---|---|---|
| `CATALOG_TOKEN` | — | the shared secret every request carries in `x-catalog-token`, and that prospector checks too. Empty turns the check off, with a warning |
| `CATALOG_PORT` | _(any free)_ | host port the API is published on, set in the archives module's `.env` |
| `CATALOG_DIR` | required (compose) | the host directory holding `catalog.db`, the same one prospector mounts |

The API listens on `8080` in the container, and prospector is always reached at
`http://prospector:8080`, inside the module.

## Commands

It runs in the archives module:

```sh
tb up archives catalog -d
tb logs archives catalog
```
