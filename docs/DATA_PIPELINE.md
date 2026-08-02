# Data Pipeline

How data gets from a venue to a queryable history a bot can be trained against.

Two layers, and the split between them is the whole design:

```
venues ──▶ collectors ──▶ raw, exactly as published ──▶ stocker ──▶ canonical Parquet vault
           (per source)   (venue-shaped)                            (venue-agnostic)
```

**Collection is byte-faithful.** A collector writes what the venue published and nothing else —
no renaming, no unit conversion, no common schema. A raw file stays re-verifiable against its
source, and can be re-read when understanding of it improves. Normalising on arrival makes every
misreading permanent and undetectable.

**Normalisation is a separate, repeatable pass.** One service interprets every venue's shapes
and writes one schema per table. Getting it wrong costs a rebuild, not a re-download.

## Source priority: bulk → REST → WebSocket

Sources are not interchangeable, and the order they are tried in is deliberate.

**Bulk archives first.** A venue's published files hand over years of history in one pass and
keep being published going forward. Anything available in bulk is collected in bulk.

**REST for what bulk omits.** Paginated endpoints fill series a venue never dumped to files, at
the cost of rate limits and a request per page.

**WebSocket last, and only for gaps.** Realtime data missed is gone forever, and a socket builds
history one message at a time — a full day of drip-feed before a day is complete, unrecoverable
after an outage. Its value is what cannot be backfilled at all: event-level sequencing,
sub-second timing, fields no archive carries. Every WS channel has to be justified by a gap the
other two sources genuinely cannot fill, established by comparing actual payloads rather than
documentation.

→ [planning/VENUE_SOURCES.md](planning/VENUE_SOURCES.md) for the per-venue, per-table findings.

## Collectors

| Service | Venues | Source | Writes to |
|---|---|---|---|
| [trucker](services/TRUCKER.md) | binance, bitget, bybit, gate, htx, kucoin, okx | published archives | host disk, mirroring each venue's own layout |
| [courier](services/COURIER.md) | BitMEX | S3 daily dumps (`trade`, `quote`) | vault service |
| [scribe](services/SCRIBE.md) | BitMEX | REST endpoints | vault service |
| [tardy](services/TARDY.md) | BitMEX | Tardis monthly samples of the seven WS-only tables | vault service |
| [broadcast](services/BROADCAST.md) → [journalist](services/JOURNALIST.md) | BitMEX | live WebSocket | vault service |
| hoarder | every venue except BitMEX | live WebSocket | RabbitMQ |

Each is a stage, not a pipeline; the modules that wire them into running deployments are
[depot](modules/DEPOT.md) (bulk and REST collection) and [journal](modules/JOURNAL.md) (live
WebSocket capture).

Live capture is split by venue rather than unified. `hoarder` handles the venues that have a
future: one instance collects one of them, several, or all, publishing every payload verbatim.
BitMEX stays on `broadcast`/`journalist` for as long as its market runs, because rebuilding a
working capture path for a venue that is closing buys nothing.

WebSocket collection is currently **parked**: hoarder's channel lists are provisional pending
the payload comparisons that decide what a socket must carry, and the bulk and REST sources have
years of backfill to work through first.

### BitMEX is a data source with an end date

BitMEX's market closes on 2026-09-23. Collection ends with it — nothing about it is worth
extending — but the history already collected is real market data and stays in the pipeline:
normalised by stocker like any other venue's, and used by the simulator. What stops is the
forward-looking half: no new BitMEX collection, and no replay surface reproducing its API,
because there will be no BitMEX to trade against and so no bot to train for it.

### What a collector owns

A collector is responsible for one source's quirks and nothing beyond them: how to enumerate
what exists, how to resume without re-fetching, how to tell a missing file from a failed
request, and how to back off politely. It publishes what it has finished so the next stage can
act on it, and it never interprets the bytes.

## Where raw lands

Two stores, both historically called "vault", holding different things:

**The vault service** — a date-partitioned HTTP file store for CSV, one sealed gzip per
`(table, date)`. Upstream services POST rows and vault serialises, buffers and seals them;
courier PUTs complete S3 gzips as-is. It is write-optimised and has no query capability. All
BitMEX collection lands here. → [services/VAULT.md](services/VAULT.md)

**Trucker's archive tree** — plain directories on the host, one root per venue, each venue's own
path structure mirrored verbatim beneath it. No service in front of it: a URL maps to exactly
one path mechanically, which makes "do I already have this?" a filesystem question rather than a
bookkeeping one.

The Parquet vault that stocker writes is a third store, described below. When it matters, name
them: *the vault service*, *the archive tree*, *the Parquet vault*.

## The completeness contract

A consumer can see which files exist but not whether more are coming, and that difference
decides whether a period is safe to process. Only the collector knows, so trucker writes it
down: `@meta/settled/{venue}.tsv`, one line per dataset and symbol holding the date collection
is complete through.

```
spot-deals	BTC_USDT	20180531
```

"Is 2018-05 ready?" becomes a lookup rather than a guess from file counts. Milestones only ever
move forward, since a consumer may already have acted on one. Stocker builds a month only once
its milestone covers the last day of it — which is what keeps a partition write-once rather than
rewritten on every later arrival.

## Normalisation — stocker

[stocker](services/STOCKER.md) reads every collector's output and writes one partitioned Parquet
vault beside it. Raw is never modified, moved or deleted.

- **One canonical schema per table.** Every series projects into the table's full column list,
  in order, with NULL where a venue publishes nothing — so `trades` is one dataset whether the
  rows came from Binance or Gate, not a pile of venue-shaped files.
- **One time unit.** `ts` is int64 microseconds UTC everywhere, and the sort key of every
  partition. The unit is read from each value rather than declared, because venues change
  precision mid-history inside a single series.
- **Hive partitioning** by table, venue, market, symbol, interval where the table needs one, and
  month. The month is the unit of work: built whole, never appended to, rebuilt only when its
  raw inputs change.
- **Venue vocabulary is preserved, not translated.** Symbols stay as the venue writes them, and
  a size stays in the unit the venue publishes. Normalising structure is safe; normalising
  semantics invents data.

Adding a venue or a series is a declarative entry plus, at most, a file describing an unfamiliar
container or tree layout. Nothing in the core learns a venue's name.

### Origins arrive one at a time

Stocker reads **bulk-origin** data today: trucker's archive tree, where a file is a published
archive of a finished period. The other two origins land alongside it as their collectors mature
— **WebSocket-origin** files, which are message streams with actions and partials rather than
rows, and **REST-origin** files, which are paginated records.

Each needs its own reader under `sources/`, because the shapes differ in kind rather than in
detail, and the canonical tables they project into are the same. That work is also what brings
BitMEX's collected history into the Parquet vault: it arrived over WebSocket and REST into the
vault service, so it normalises through those readers, not the archive one.

## Replay

The consumer this exists for. A replay engine serves the normalised history over a **replica of
each venue's own WebSocket and REST API**, driven by a clock internal to the data, so a bot
written against Bitget trades against Bitget's interface whether it is pointed at the exchange
or at ten years of history.

A replay surface is built per venue, and only for venues worth trading on — a bot trained
against an API it can never send an order to is wasted work. The simulator consumes the vault
directly rather than through a venue API, so history from a closed venue keeps its value there
without a surface being built for it.

This is under construction. An earlier BitMEX-only implementation established the shape — a
timeline service merging tables in time order, subscription handling, backpressure to the
slowest client, and a control API for seeking and speed — and is being rewritten venue-agnostic.
→ [planning/REPLAY.md](planning/REPLAY.md)

## Retired

`services/.deprecated/` holds the MongoDB-era stages: `farmer` (loading sealed vault files into
MongoDB), `distiller` (deriving binned and depth-limited collections from them), `librarian`
(dump I/O over MongoDB) and `mongodb` itself. Parquet replaced the pair of them — the vault is
now directly queryable, so loading it into a database to query it, and materialising derived
collections ahead of time, both stopped paying for themselves.

Their docs are kept for the BitMEX-specific knowledge they carry, not as a description of
anything currently running.
