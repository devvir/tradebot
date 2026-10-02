# Catalog

Establishes what every venue publishes, and serves that as the thing everything downstream is
decided from.

```
prospector → venue archives → catalog.db → the API everyone else asks
hauler     ← the API (a bucket per venue, through a lens) → archives on disk
```

Three services. [prospector](../services/PROSPECTOR.md) surveys the venues and owns the database and
the API, and is where the detail lives. [hauler](../services/HAULER.md) downloads what the catalog
lists, through a lens, and reports back. [catalog-ui](../services/CATALOG-UI.md) is a page for reading
the API and driving the surveys from a browser; it holds nothing and can be left out entirely. This
page is only what you need to run the module.

Going deeper: every endpoint is [CATALOG-API.md](CATALOG-API.md), and lenses — the named slices a
consumer reads through — are [CATALOG-LENSES.md](CATALOG-LENSES.md).

## Why it is its own module

**Surveying downloads nothing.** A survey moves kilobytes of XML while the archives it describes are
terabytes, so prospector needs bandwidth and almost no disk. Hauler is the opposite, and the two meet
only over HTTP — so a hauler can run on another machine, beside the disk it fills, and several can
split the venues between them, each through its own lens.

**One process owns the database.** Prospector is the only thing that opens `catalog.db`; every
question and every change any other service has arrives through its API. That is what keeps a single
answer to "what exists, and what do we hold of it" rather than one per service.

## Running it

```
modules/collect/catalog/
```

| variable | |
|---|---|
| `CATALOG_DIR` | host directory holding `catalog.db`, mounted at `/data/catalog` |
| `CATALOG_TOKEN` | sent as `x-catalog-token` on every request. **Empty turns the check off** |
| `CATALOG_PORT` | host port for the API. Empty lets docker pick a free one |
| `CATALOG_UI_PORT` | host port for the page. `9020` |
| `PROSPECTOR_VENUES` | the venues prospector surveys; empty for every venue |
| `PROSPECTOR_CONCURRENCY`, `PROSPECTOR_CONNECTIONS` | how many requests prospector keeps in flight, and on how many connections — see the [prospector README](../../services/prospector/README.md) |
| `HAULER_ARCHIVES_DIR` | host directory hauler writes the archives into |
| `HAULER_LENS`, `HAULER_VENUES`, `HAULER_CONCURRENCY` | what hauler fetches and how many at once — see the [hauler README](../../services/hauler/README.md) |

**An empty `CATALOG_TOKEN` means an open catalog**, and both services treat it the same way:
prospector checks no header and warns loudly on startup, catalog-ui forwards without one. That is
what makes the read endpoints answerable from a browser with nothing to configure — and it is a
decision somebody takes rather than one nobody notices, which is why the warning is there. Set it on
anything reachable beyond the machine.

Pre-create the directory for uid 1000, as with the other volumes:

```sh
sudo mkdir -p /storage/tradebot/catalog && sudo chown 1000:1000 /storage/tradebot/catalog
```

**Point `CATALOG_DIR` at an empty directory and a fresh catalog is built on first start**, by
running the whole migration chain from zero — which is what puts the venue rows, the known-bad file
lists and the two shipped series seeds in it. Point it at an existing one and it is carried forward
from wherever it is, and otherwise left alone. There is no path that skips the chain: a database
that jumped straight to the head shape would be missing everything the chain carries.

## Starting a survey

Nothing starts unasked. Once a venue has been asked for, though, it **keeps itself current** —
walking once and then updating daily, **across restarts** — until it is paused or refreshed. Whether
a venue should be surveyed at all depends on what somebody is waiting for and what the disk can take,
which is not visible from inside; how often one already being surveyed needs re-reading is simply how
often the archives move, which is once a day.

Asking for a venue **enrols** it, and that is what a restart goes back to: an interrupted job resumes
from its cursors, a venue between passes waits out the rest of its interval, a paused one stays
paused, and a venue nobody ever asked about is left alone for ever. So a deployment where no survey
was ever started is read-only, permanently and by construction — and one where a single venue was
started keeps that venue current without being asked again.

**One verb, and where a venue has got to decides what it means**: a venue with nothing starts, one
with work outstanding continues from its cursors, one that has caught up looks for what has appeared
since. The reply names the phase each was in — read off whichever kind of run that venue does, so
okx and bitget, which never walk, report the state of their updates rather than `not run`.

```sh
# Every venue — the ordinary case, since they survey concurrently anyway
curl -X POST -H "x-catalog-token: $CATALOG_TOKEN" http://localhost:$CATALOG_PORT/surveys

# One of them
curl -X POST -H "x-catalog-token: $CATALOG_TOKEN" \
     http://localhost:$CATALOG_PORT/venues/binance/surveys
```

**Every endpoint and every parameter — narrowing to several venues, the `refresh` and `update`
modifiers, pausing — is in [CATALOG-API.md](CATALOG-API.md).**

The answer says what happened to each, rather than failing the whole call because one venue was
busy:

```json
{ "at": "…", "started": ["binance", "htx", "kucoin"],
  "skipped": [{ "venue": "bybit", "reason": "already running" }],
  "phases": { "binance": "updating", "htx": "complete", "kucoin": "not run" } }
```

It answers as soon as the work is under way; a survey runs for hours. `GET /status` is where its
progress lives, and it separates two things that look alike from the outside: `state` is where the
venue stands — `not started`, `walking`, `updating`, `waiting` or `paused` — and `surveying` is
whether anything is currently doing it. **Walking with nothing surveying** is what a killed container
leaves behind. Reading either in a browser is what catalog-ui is for.

## What it is for

**So that nothing else has to know how a venue arranges its archive.** Every venue publishes its
history as files and no two agree on the trees, the names, or which of a month's two renderings you
get. A consumer asks here for `1h` `klines`, monthly, in a range, for these instruments, and is
answered with URLs that work.

A downloader asks the catalog for work instead of asking a venue, and reports back what it fetched —
so "which months are finished" and "how much is left" are queries rather than bookkeeping each
service keeps for itself. Every endpoint is listed in [CATALOG-API.md](CATALOG-API.md); why each part
of it is shaped that way is in [PROSPECTOR.md](../services/PROSPECTOR.md#the-api).
