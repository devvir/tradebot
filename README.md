# TradeBot

A venue-agnostic platform for collecting market data and normalising it into one queryable history.

It exists for a bot that cannot tell training from production: one written against a venue's
published API, trading against the real exchange or against years of history through an interface
indistinguishable from the venue's own. No replay engine is part of the repository today; where the
project is heading is [docs/planning/ROADMAP.md](docs/planning/ROADMAP.md).

## Collect, then normalise

**Collect.** What a venue published is written byte for byte: archives first, REST for what the
archives omit, WebSocket only for what neither can supply. Nothing is transformed on the way in, so a
raw file stays re-verifiable against its source and can be read again when the understanding of it
improves.

**Normalise.** One service, stocker, reads the archives and writes a single partitioned Parquet vault,
with one schema per table across every venue, so a consumer reads a dataset the same way whatever
venue, source or format it came from.

→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the stages, the boundary each owns, and which
module runs it.

## Services and modules

The distinction is load-bearing and worth getting right before adding anything:

- **Services** (`services/`) are pipeline stages. Each does one job (consume, transform, publish,
  store) and produces no observable result on its own. Building blocks.
- **Modules** (`modules/`) are deployable pipelines: a compose file wiring services into something
  with an observable output. What you actually run. The infra packs under `modules/infra/` run the
  shared brokers and cache.

## Running one

`./tb` is the compose wrapper: it creates the shared docker network `${PROJECT_NAME}-network` when it
is missing, then runs [dx](dx/README.md). A module is named by its directory:

```bash
./tb up archives
```

Each command hands compose the root `.env`, then the module's own `.env`, then its `.env.<APP_ENV>`
(`APP_ENV` read from the root `.env`), each one that exists overriding the ones before it. The root
[.env.example](.env.example) and each app module's `.env.example` (`modules/collect/archives`,
`modules/store/warehouse`) list the variables and their defaults; the infra packs have none of their
own and read the root `.env`.

## Documentation

| Where | What |
|---|---|
| `docs/ARCHITECTURE.md` | The pipeline: stages, what each owns, which module runs it |
| `docs/VOCABULARY.md` | What each platform term means |
| `docs/services/` | One technical reference per documented service: architecture, algorithms, data flow |
| `docs/modules/` | The archives module, and the references for the catalog's API and its lenses |
| `docs/tooling/` | The `./tb` and `./tools` command-line tools ([index](docs/tooling/README.md)), and `./tools cold`, the cold-storage command, one page per tree |
| `docs/venues/` | One document per venue: its archives, its APIs, its quirks |
| `docs/REST.md` | What the venues' public REST APIs serve of the past, side by side |
| `docs/planning/` | Plans and open work; [ROADMAP.md](docs/planning/ROADMAP.md) is the map |
| `docs/bitmex/` | A dataset this repository collected from BitMEX before it closed, and how to read it |

Venue-specific findings live under `docs/venues/`, one document per venue. Everything outside it is
venue-agnostic; a doc that names a venue while claiming to describe the platform is a bug in the
documentation. `docs/bitmex/` is not a venue doc: it describes a dataset this repository
collected, and names the services that wrote it.

Documentation for a retired service lives with the service, under `services/.deprecated/`, so it
stays available without describing anything that runs.
