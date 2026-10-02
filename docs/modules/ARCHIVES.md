# Archives

Establishes what every venue publishes, serves that as the catalog everything downstream is decided
from, and brings the files a lens selects to disk.

```
prospector → venue archives → catalog.db
catalog    → catalog.db → listings, contents and lenses over HTTP
hauler     ← the catalog's listings (through a lens) → archives on disk
```

Four services. [prospector](../services/PROSPECTOR.md) surveys the venues, owns the database, and is
where the detail lives. [catalog](../../services/catalog/README.md) is the public API over what
prospector found. [hauler](../services/HAULER.md) downloads what the catalog lists, through a lens, and
reports back. [catalog-ui](../services/CATALOG-UI.md) is a page for reading the catalog, editing lenses
and driving the surveys; it holds nothing and can be left out entirely. This page is only what you need
to run the module.

Going deeper: every public endpoint is [CATALOG-API.md](CATALOG-API.md), and lenses (the named slices a
consumer reads through) are [CATALOG-LENSES.md](CATALOG-LENSES.md).

## Why it is split this way

**Surveying downloads nothing.** A survey moves kilobytes of XML while the archives it describes are
terabytes, so prospector needs bandwidth and almost no disk. Hauler is the opposite, and the two meet
only over HTTP, so a hauler can run on another machine, beside the disk it fills, and several can split
the venues between them, each through its own lens.

**Prospector collects; the catalog serves.** Prospector writes every file, series and survey row, and
its API (start and pause surveys, settle download reports) is private to the module. Everything a
consumer asks goes to the catalog, which reads the same database file. A consumer never needs to know
how collection works, and collection can change without any consumer noticing.

**Lenses belong to the catalog**, because a lens is a consumer's choice of what to read, not something
collection knows or acts on. So the catalog writes the `lens` table and nothing else; every other row is
prospector's.

**One database, two processes, one host.** SQLite in WAL mode lets the catalog read while prospector
writes, but only through shared memory, so the two must mount the same directory on the same machine.
Catalog reads stay short, because a long read holds back prospector's checkpoints.

## Running it

```
modules/collect/archives/
```

| variable | |
|---|---|
| `CATALOG_DIR` | host directory holding `catalog.db`, mounted at `/data/catalog` in prospector and catalog |
| `CATALOG_TOKEN` | sent as `x-catalog-token` on every request, checked by catalog and prospector. **Empty turns the check off** |
| `CATALOG_PORT` | host port for the catalog API. Empty lets docker pick a free one |
| `CATALOG_UI_PORT` | host port for the page. `9020` |
| `PROSPECTOR_VENUES` | the venues prospector surveys; empty for every venue |
| `PROSPECTOR_CONCURRENCY`, `PROSPECTOR_CONNECTIONS` | how many requests prospector keeps in flight, and on how many connections — see the [prospector README](../../services/prospector/README.md) |
| `HAULER_ARCHIVES_DIR` | host directory hauler writes the archives into |
| `HAULER_LENS`, `HAULER_VENUES`, `HAULER_CONCURRENCY` | what hauler fetches and how many at once — see the [hauler README](../../services/hauler/README.md) |

**An empty `CATALOG_TOKEN` means an open catalog**, and every service treats it the same way: catalog
and prospector check no header and warn loudly on startup, catalog-ui and hauler send none. That is what
makes the read endpoints answerable from a browser with nothing to configure. Set it on anything
reachable beyond the machine.

Pre-create the directory for uid 1000, as with the other volumes:

```sh
sudo mkdir -p /storage/tradebot/catalog && sudo chown 1000:1000 /storage/tradebot/catalog
```

**Point `CATALOG_DIR` at an empty directory and prospector builds a fresh catalog on first start**, by
running the whole migration chain from zero, which is what puts the venue rows, the known-bad file lists
and the shipped series seeds in it. Point it at an existing one and it is carried forward from wherever
it is. The catalog service creates nothing: until the database exists, it waits.

## Starting a survey

Nothing starts unasked. Once a venue has been asked for, though, it **keeps itself current** (walking
once and then updating daily, **across restarts**) until it is paused or refreshed.

Asking for a venue **enrols** it, and that is what a restart goes back to: an interrupted job resumes
from its cursors, a venue between passes waits out the rest of its interval, a paused one stays paused,
and a venue nobody ever asked about is left alone for ever. So a deployment where no survey was ever
started is read-only, permanently and by construction.

Surveys are started and paused from catalog-ui's Surveys page. Prospector publishes no port, so from a
shell the same requests go through catalog-ui's proxy:

```sh
# Every venue — the ordinary case, since they survey concurrently anyway
curl -X POST http://localhost:$CATALOG_UI_PORT/api/prospector/surveys

# One of them
curl -X POST http://localhost:$CATALOG_UI_PORT/api/prospector/venues/binance/surveys

# Where each venue stands
curl http://localhost:$CATALOG_UI_PORT/api/prospector/status
```

**One verb, and where a venue has got to decides what it means**: a venue with nothing starts, one with
work outstanding continues from its cursors, one that has caught up looks for what has appeared since.
Every parameter (several venues, the `refresh` and `update` modifiers, pausing) and what `status`
reports are in [PROSPECTOR.md](../services/PROSPECTOR.md#the-api).

## What it is for

**So that nothing else has to know how a venue arranges its archive.** Every venue publishes its history
as files, and no two agree on the trees, the names, or which of a month's two renderings you get. A
consumer asks the catalog what exists, in the catalog's own vocabulary, and walks a listing whose keys
say what each file *is*.

A downloader asks the catalog for work instead of asking a venue, and reports back what it fetched, so
"how much is left" is a query rather than bookkeeping each service keeps for itself.
