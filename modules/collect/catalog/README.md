# Catalog Module

Establishes what each venue's archive contains — every file, its size and its checksum — without
fetching any of it.

The result is a queryable catalog of published files. Questions that would otherwise cost network
requests are answered locally: whether a dataset exists, how large it is, which periods it covers,
where a given file lives, and which parts of an archive have been established completely.

It exists so that **discovery is not entangled with downloading**. The two are separate problems with
separate per-venue nuance, so neither service carries the other's: this module never fetches archive
data, and anything that does selects its work from the catalog instead of asking a venue.

Two consequences worth the split on their own. The catalog is a **file**, so surveying need not happen
where downloading does — a host with bandwidth and little disk can produce it and a host with storage
can import it, each refreshing on its own clock. And the **whole picture arrives in hours**: how many
files a venue publishes, how large, over which periods, all known before anything is fetched. Sizing
a dataset, or choosing between two of them, is a query rather than a commitment discovered two months
into a download.

## Services

| Service | Role |
|---------|------|
| **prospector** | Surveys venue archives and writes the catalog |

## Usage

```bash
tb up catalog          # Start
tb up catalog --build  # Rebuild and start
tb down catalog        # Stop
tb logs catalog        # Stream progress
tb ps catalog          # Check status
```

It runs as a **daemon serving the catalog**, and surveys nothing on its own. Starting the module
therefore neither triggers a survey nor loses one; an interrupted job keeps its cursors and resumes
when it is next asked to.

A survey starts on request:

```sh
# Start, continue, or catch up — whichever the venue needs
curl -X POST -H "x-catalog-token: $CATALOG_TOKEN" -H 'content-type: application/json' \
     -d '{"venue":"binance"}' http://localhost:$CATALOG_PORT/surveys

# Reset first and walk it all again
curl -X POST -H "x-catalog-token: $CATALOG_TOKEN" -H 'content-type: application/json' \
     -d '{"venue":"binance","refresh":true}' http://localhost:$CATALOG_PORT/surveys

# Stop, keeping every cursor
curl -X POST -H "x-catalog-token: $CATALOG_TOKEN" http://localhost:$CATALOG_PORT/surveys/pause
```

`GET /status` reports progress, and separates two things that look alike from outside: `job` is work
still outstanding, `surveying` is whether anything is doing it.

## Configuration

Copy `.env.example` to `.env` and update as needed.

`CATALOG_DIR` is the host directory holding `catalog.db`, mounted at a fixed `/data/catalog`
inside the container. It defaults to `${DATA_DIR}/catalog`; set an absolute path to put it
elsewhere — another volume, another machine — without any service knowing. Pre-create it owned by
uid 1000:

```bash
sudo mkdir -p /storage/tradebot/catalog && sudo chown 1000:1000 /storage/tradebot/catalog
```

See [docs/services/PROSPECTOR.md](../../../docs/services/PROSPECTOR.md) for the full variable list
and how surveying works.

## Running it somewhere else

This module needs a network connection and almost no disk, which makes it deployable away from
the data. A machine with bandwidth and no storage can survey venues and produce a catalog file;
that file is then merged into the catalog wherever the downloading actually happens.

Nothing here fetches archive data, so running it costs listing requests and nothing else.
