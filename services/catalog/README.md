# Catalog

The public API over what prospector has catalogued: what each venue publishes, every venue's files as
one S3-style bucket, and the lenses consumers read through.

It surveys nothing, downloads nothing and writes nothing. It opens the `catalog.db` prospector writes
**read-only** and answers from it. What it is sent to be stored (a lens, a download report) it
forwards to prospector, the database's only writer.

It serves venue contents, the bucket listing and lenses; every endpoint is in
[CATALOG-API.md](../../docs/modules/CATALOG-API.md).

Deployed by: archives module (`modules/collect/archives/compose.yml`).
How it works: [docs/services/CATALOG.md](../../docs/services/CATALOG.md).

## Running it

- **Storage.** `CATALOG_DIR` on the host is mounted at `/data/catalog`, the same directory prospector
  mounts. It defaults to `${DATA_DIR}/catalog`; compose refuses to start only while neither
  `CATALOG_DIR` nor `DATA_DIR` is set. Until `catalog.db` exists the service waits for
  prospector to create it.
- **Ports.** The API listens on `8080` in the container and is published on the host as below;
  containers on the module network reach it as `catalog:8080`. `3000` serves `GET /health` for the
  container healthcheck and is not published. Prospector is always reached at `http://prospector:8080`,
  inside the module.

## Environment

| variable | default | |
|---|---|---|
| `CATALOG_TOKEN` | empty | the shared secret every request carries in `x-catalog-token`, and that prospector checks too. Empty turns the check off, with a warning at startup |
| `CATALOG_PORT` | empty: a free port docker picks | host port the API is published on, set in the archives module's `.env`. Set `CATALOG_PORT` wherever something on the host calls the catalog, e.g. `./tools cold` |
| `CATALOG_BIND` | `127.0.0.1` | host address the port is published on. Another address lets other hosts connect; set `CATALOG_TOKEN` then too |
| `CATALOG_DIR` | `${DATA_DIR}/catalog` | the host directory holding `catalog.db`, the same one prospector mounts |
| `CATALOG_DB` | `/data/catalog/catalog.db` | path of the database inside the process. Compose does not set it, so the service opens the file in the `CATALOG_DIR` mount; set it to run the service against another file, e.g. outside compose |
| `LOG_LEVEL` | `info` | log level |
| `APP_ENV` | `prod` | which image is built (`docker/<APP_ENV>.node.Dockerfile`), passed to the process as `NODE_ENV` |
| `TZ` | `UTC` | the process's time zone |

## Commands

It runs in the archives module:

```sh
tb up archives catalog -d
tb logs archives catalog
```
