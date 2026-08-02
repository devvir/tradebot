# TradeBot

A venue-agnostic platform for collecting market data, normalising it, and replaying it back to
trading bots through interfaces indistinguishable from the venues' own.

The goal is a bot that cannot tell training from production. It is written against a venue's
published API; the replay engine reproduces that API over historical data, so the same bot
binary trades against the real exchange or against ten years of history without knowing which.

## The three concerns

**Collect.** One collector per source shape, each writing what a venue published, byte for
byte. Bulk archives first, REST for what bulk omits, WebSocket only for what neither can
supply. Nothing is transformed on the way in — a faithful archive stays re-verifiable against
its source and can be re-read when understanding improves, which a normalised-on-arrival one
cannot.

**Normalise.** One service reads every collector's output and writes a single partitioned
Parquet vault with one schema per table across all venues, so a consumer never learns where a
dataset came from or what shape it arrived in.

**Replay.** Serve that history over each venue's own WebSocket and REST surfaces, driven by a
clock internal to the data, so bots and the UI can be pointed at it in place of the venue.

→ [docs/DATA_PIPELINE.md](docs/DATA_PIPELINE.md) for how collection and normalisation fit
together, and what each collector covers.

## Services and modules

The distinction is load-bearing and worth getting right before adding anything:

- **Services** (`services/`) are pipeline stages. Each does one job — consume, transform,
  publish, store — and produces no observable result on its own. Building blocks.
- **Modules** (`modules/`) are deployable pipelines: a compose file wiring services into
  something with an observable output. What you actually run.

## Running one

Every module is a compose file plus a `.env`. Bring one up with:

```bash
tb up <module>
```

Each module directory carries a `.env.example` listing its variables and their defaults.

## Documentation

| Where | What |
|---|---|
| `docs/DATA_PIPELINE.md` | How data gets from venues to the vault |
| `docs/services/` | One technical reference per service — architecture, algorithms, data flow |
| `docs/modules/` | How services are wired into a deployable pipeline |
| `docs/planning/` | Designs and open questions for work not finished |
| `docs/tooling/` | The `tb` command-line tools |
| `docs/venues/<venue>/` | One venue's own quirks: table semantics, API bugs, data anomalies |

Venue-specific findings live under `docs/venues/`, one directory per venue — `BitMEX/` today.
Everything outside it is venue-agnostic; a doc that names a venue while claiming to describe the
platform is a bug in the documentation.

Documentation for a retired service lives with the service, under `services/.deprecated/`, so it
stays available without describing anything that runs.
