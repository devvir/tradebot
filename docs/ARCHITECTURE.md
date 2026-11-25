# Architecture

How market data gets from what a venue publishes to a Parquet vault a consumer can query, which
service owns each step, and which module runs it. The terms are those of
[VOCABULARY.md](VOCABULARY.md).

```
   the venues' published files
        │ surveyed                          │ fetched
        ▼                                   ▼
   prospector ──▶ catalog (+ lenses) ──▶ hauler ──▶ archives ──▶ stocker ──▶ Parquet vault
                        │                                           ▲
                        └──── partitions downloaded and settled ────┘

   ./tools cold     archives · Parquet vault · catalog database   ◀──▶   cold storage
```

## Two layers

**Collection is byte-faithful.** A collector writes what the venue published and nothing else: no
renaming, no unit conversion, no common schema. A raw file stays re-verifiable against its source,
and can be read again when the understanding of it improves. Normalising on arrival would make every
misreading permanent and undetectable.

**Normalisation is a separate, repeatable pass.** One service reads the raw files and writes one
schema per canonical table across every venue, so a consumer reads a table the same way whatever
venue, source or format its rows came from. A mistake there costs a rebuild of the vault, not a download.

## Source priority: bulk, then REST, then WebSocket

Sources are not interchangeable, and the order they are taken in is deliberate.

**Archives first.** A venue's published files hand over years of history in one pass and keep being
published going forward. Whatever is available in bulk is collected in bulk.

**REST for what the archives omit.** Paginated endpoints fill series a venue never publishes as
files, at the cost of rate limits and a request per page.

**WebSocket last, and only for gaps.** Realtime data missed is gone for good, and a socket builds
history one message at a time: a full day of listening before a day is complete, and nothing to
recover after an outage. Its value is what cannot be backfilled at all: event-level sequencing,
sub-second timing, fields no archive carries. A WebSocket channel has to be justified by a gap the
other two sources cannot fill, established by comparing actual payloads rather than documentation.

What the venues' APIs serve of the past is compared in [REST.md](REST.md). What their sockets carry
is in the WebSocket section of each venue doc that has one
([BINANCE](venues/BINANCE.md#websocket), [BYBIT](venues/BYBIT.md#websocket),
[OKX](venues/OKX.md#websocket), [KRAKEN](venues/KRAKEN.md#websocket)).

## Collectors

| Source | Collected by | Writes | Deployed by |
|---|---|---|---|
| archives | prospector establishes what exists; hauler fetches it | the catalog database; the archives | the archives module |
| WebSocket | hoarder | every market-data frame to RabbitMQ, as received | no module |
| REST | no service | | |

A collector owns one source's quirks and nothing beyond them: how to enumerate what exists, how to
resume without fetching again, how to tell a missing file from a failed request, how to back off. It
never interprets the bytes.

## The stages

**[Prospector](services/PROSPECTOR.md)** establishes what each venue publishes as files and keeps
that current. It reads each venue in its own terms and records every file in one vocabulary, with
the venue's own path beside it, in the catalog database. It is that database's only writer. Its own
API, private to the archives module, starts and pauses surveys and stores what the catalog forwards.

**[The catalog](services/CATALOG.md)** is the public API over what prospector established. It opens
the same database read-only and answers what each venue publishes, which files there are (one
S3-style bucket, every venue under its own prefix) and which part of it a consumer wants: a lens, a
named selection of the catalog that a consumer reads through. What it is sent to store, a lens or a
download report, it forwards to prospector. Every endpoint is in
[CATALOG-API.md](modules/CATALOG-API.md); lenses are in [CATALOG-LENSES.md](modules/CATALOG-LENSES.md).
[Catalog UI](services/CATALOG-UI.md) is a page over both services for reading the catalog, editing
lenses, and starting and pausing surveys; nothing depends on it.

**[Hauler](services/HAULER.md)** owns what is on disk. It walks each venue's listing, through a lens
when one is named, fetches what the listing says is still owed, verifies it, writes it into the
archives at its canonical key, and reports what became of it. It never decides that a file exists or
is gone; the catalog does.

**The archives** are plain directories on the host, every downloaded file at its canonical key and
as the venue published it ([the layout on disk](services/HAULER.md#the-layout-on-disk)). No service
stands in front of them.

**[Stocker](services/STOCKER.md)** owns the Parquet vault. On each sweep it asks the catalog which
partitions are downloaded in full and settled, reads their files from the archives, mounted
read-only, and writes them into the canonical tables, recording in the vault's ledger what each was
stocked from. It reads the archives and no other source, and never modifies, moves or deletes them.
Where each file sits in the vault is its [path convention](services/STOCKER.md#path-convention).

**[`./tools cold`](tooling/COLD.md)** keeps the data in cold storage. It runs from the host, and no
service calls it. It uploads the finished partitions of the archives, packed into tars, and the
vault's files as they are; removes from the local disk what is safely stored; brings either back on
demand; and keeps a copy of the catalog's database.

## What runs it

| Module | Runs | Doc |
|---|---|---|
| archives (`modules/collect/archives`) | prospector, catalog, catalog-ui, hauler | [ARCHIVES.md](modules/ARCHIVES.md) |
| warehouse (`modules/store/warehouse`) | stocker | [README](../modules/store/warehouse/README.md) |
| infra packs (`modules/infra/*`) | RabbitMQ brokers and a Redis cache | [README](../modules/infra/README.md) |

Stocker reaches the catalog over the shared network, so the warehouse module needs the archives
module running. Cold storage is not a module: it is part of the developer CLI in `dev/tooling`.

No module deploys these services:

- **hoarder**, the WebSocket collector above ([README](../services/hoarder/README.md));
- **router**, which republishes RabbitMQ messages to the destinations its rules give
  ([ROUTER.md](services/ROUTER.md));
- **pipe**, which declares RabbitMQ exchange-to-exchange bindings and exits
  ([README](../services/pipe/README.md));
- **the vault service**, a date-partitioned CSV file store, not the Parquet vault
  ([VAULT.md](services/VAULT.md)); the dataset in its layout is described in
  [bitmex/README.md](bitmex/README.md);
- **the UI stub**, a trading dashboard kept as a stub ([README](../services/_stub/ui/README.md)).
