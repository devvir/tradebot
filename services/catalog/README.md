# Catalog

The public API over what prospector has catalogued: what each venue publishes, each venue's files as an
S3-style listing, and the lenses consumers read through.

It surveys nothing and downloads nothing. It opens the `catalog.db` prospector writes, answers from it,
and writes only lenses. A download report is forwarded to prospector, which owns a file's state.

```
GET  /contents/venues[/:venue[/markets/:market]][/symbols]
GET  /listings/:venue                  S3 ListObjects, V1 or V2
POST /listings/:venue/report           forwarded to prospector
     /lenses …                         create, edit, check, size, resolve
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
