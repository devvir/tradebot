# Archives Module

Establishes what each venue publishes (every file, its size and its checksum) and downloads what a
lens selects. How the pieces fit and why they are split this way is in
[ARCHIVES.md](../../../docs/modules/ARCHIVES.md).

## Services

| Service | Role |
|---------|------|
| **prospector** | Surveys venue archives and writes `catalog.db`. Its API is private to the module and publishes no port |
| **catalog** | The public API over `catalog.db`: S3-style listings, contents, lenses |
| **hauler** | Walks each venue's listing (only what is still owed, through `HAULER_LENS` when set) and writes the files |
| **catalog-ui** | The page a person uses to read the catalog, edit lenses, and start or pause surveys |

## Usage

```bash
tb up archives -d          # Start
tb up archives -d --build  # Rebuild and start
tb down archives           # Stop
tb logs archives -f        # Follow the logs
tb ps archives             # Check status
```

Consumers outside the module reach the catalog on `CATALOG_PORT`; every endpoint is in
[CATALOG-API.md](../../../docs/services/CATALOG-API.md).

## Configuration

Copy `.env.example` to `.env` and adjust. The module also reads the root `.env`, where `DATA_DIR` is
set. The compose files default `DATA_ARCHIVES_DIR` and `CATALOG_DIR` under `DATA_DIR`; set either only
to put it elsewhere.

| variable | default | |
|---|---|---|
| `CATALOG_DIR` | `${DATA_DIR}/catalog` | host directory holding `catalog.db`, mounted at `/data/catalog` in prospector and catalog. Compose refuses to start while neither it nor `DATA_DIR` is set |
| `CATALOG_TOKEN` | empty | sent as `x-catalog-token` by hauler and catalog-ui, checked by catalog and prospector. **Empty turns the check off** |
| `CATALOG_PORT` | empty | host port the catalog API is published on. Empty lets docker pick a free one, so set it wherever something on the host must reach the catalog |
| `CATALOG_BIND` | `127.0.0.1` | host address the catalog API is published on |
| `CATALOG_UI_PORT` | `9020` | host port the page is served on |
| `CATALOG_UI_BIND` | `127.0.0.1` | host address the page is served on |
| `CATALOG_UI_HOSTS` | empty (any `Host`) | comma-separated names the page may be opened as; requests catalog-ui forwards under any other `Host` are refused |
| `CATALOG_API` | `http://catalog:8080` | where hauler and catalog-ui reach the catalog |
| `PROSPECTOR_VENUES` | empty (every venue) | comma-separated subset of `binance`, `bitget`, `bybit`, `gate`, `htx`, `kucoin`, `okx` this prospector surveys and resumes; an unknown name fails startup |
| `PROSPECTOR_CONCURRENCY` | `200` | requests prospector keeps in flight, across every venue |
| `DATA_ARCHIVES_DIR` | `${DATA_DIR}/archives` | host directory hauler writes the archives into, mounted at `/data/archives`. Compose refuses to start while neither it nor `DATA_DIR` is set |
| `HAULER_LENS` | empty (every catalogued file) | slug of the catalog lens hauler fetches through |
| `HAULER_VENUES` | empty (every venue the catalog knows) | comma-separated venues hauler fetches |
| `HAULER_CONCURRENCY` | `100` | fetches in flight, across every venue |
| `HAULER_MIN_FREE_GB` | `25` | free space on the archives volume, in GB, below which hauler takes no new file |

Each service's README (`services/<name>/README.md`) has the detail of its variables.

**An empty `CATALOG_TOKEN` means an open catalog**, and every service treats it the same way: catalog
and prospector check no header and warn on startup, hauler and catalog-ui send none. That is what makes
the read endpoints answerable from a browser with nothing to configure. Set it whenever `CATALOG_BIND`
lets another host reach the catalog.

**The token does not guard catalog-ui.** catalog-ui adds it to every request it forwards and checks
nothing about who is asking, so whoever reaches `CATALOG_UI_PORT` can start and pause surveys and
create, edit and delete lenses. Publish it beyond `127.0.0.1` only where everyone who can reach it may
do that.

### The catalog directory

Prospector and catalog both mount `CATALOG_DIR`, so they run on the same host. Pre-create it owned by
uid 1000, as with the other volumes:

```sh
dir="${CATALOG_DIR:-$DATA_DIR/catalog}"
sudo mkdir -p "$dir" && sudo chown 1000:1000 "$dir"
```

**Point `CATALOG_DIR` at an empty directory and prospector builds a fresh catalog on first start**, by
running the whole migration chain from zero; the chain is also what puts the venue rows and the data
shipped with the code into it. Point it at an existing catalog and it is migrated forward from its
version. The catalog service creates nothing: until the database exists, it waits.

## Starting a survey

Prospector surveys nothing until a venue is asked for. Asking for a venue **enrols** it, and an
enrolled venue keeps itself current (walking, then updating daily) across restarts until it is
paused. On every start prospector resumes the enrolled venues it is configured for: an interrupted job
resumes from its cursors, a venue between passes waits out the rest of its interval, a paused venue
stays paused, and a venue nobody asked for is left alone. A deployment where no survey was ever
started stays read-only however often it restarts. Asking a paused venue for a survey lifts the
pause.

Surveys are started and paused from catalog-ui's Surveys page. Prospector publishes no port, so from
a shell the same requests go through catalog-ui's proxy (here on the default `CATALOG_UI_PORT`).
catalog-ui forwards a write only with a JSON body:

```sh
# Every venue
curl -X POST -H 'content-type: application/json' -d '{}' \
  http://localhost:9020/api/prospector/surveys

# One venue
curl -X POST -H 'content-type: application/json' -d '{}' \
  http://localhost:9020/api/prospector/venues/binance/surveys

# Pause one
curl -X POST -H 'content-type: application/json' -d '{"venue":"binance"}' \
  http://localhost:9020/api/prospector/surveys/pause

# Where each venue stands
curl http://localhost:9020/api/prospector/status
```

**One request, and where a venue has got to decides what it means**: a venue never surveyed starts,
one with a pass outstanding continues from its cursors, and one that has caught up waits for its next
update. `{"update": true}` runs that update now, and `{"refresh": true}` discards the venue's progress
and surveys it from scratch. Every parameter and what `status` reports are in
[PROSPECTOR.md](../../../docs/services/PROSPECTOR.md#the-api).
