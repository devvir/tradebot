# Archives

Establishes what every venue publishes, serves that as the catalog everything downstream is decided
from, and brings the files a lens selects to disk. Running it (variables, the catalog directory,
starting surveys) is in the [module README](../../modules/collect/archives/README.md).

```
prospector → venue archives → catalog.db
catalog    → catalog.db → listings, contents and lenses over HTTP
hauler     ← the catalog's listings (through a lens) → archives on disk
```

Four services. [prospector](../services/PROSPECTOR.md) surveys the venues, is the only writer of
`catalog.db`, and is where the detail lives. [catalog](../services/CATALOG.md) is the public API over
what prospector found. [hauler](../services/HAULER.md) downloads what the catalog lists, through a
lens, and reports back what it fetched. [catalog-ui](../services/CATALOG-UI.md) is a page for reading
the catalog, editing lenses and starting and pausing surveys; it holds nothing, and no other service
depends on it.

Going deeper: every public endpoint is [CATALOG-API.md](CATALOG-API.md), and lenses (the named
selections a consumer reads through) are [CATALOG-LENSES.md](CATALOG-LENSES.md).

## Why it is split this way

**Surveying downloads nothing.** A survey moves kilobytes of XML while the archives it describes are
terabytes, so prospector needs bandwidth and almost no disk. Hauler is the opposite, and the two meet
only over HTTP, through the catalog, so a hauler can run on another machine, beside the disk it fills,
and several can split the work between them.

**Prospector collects; the catalog serves.** Prospector writes every row of the database, and its API
(start and pause surveys, settle download reports, store lenses) is private to the module. Everything
a consumer asks goes to the catalog, which opens the same database file read-only and hands what it is
sent to store, a lens or a download report, to prospector. A consumer never needs to know how
collection works, and collection can change without any consumer noticing.

**A lens is a consumer's choice of what to read**, which collection neither knows nor acts on: it is
defined and checked through the catalog, and prospector stores it like every other row (see
[PROSPECTOR.md](../services/PROSPECTOR.md#storage)).

**One database, two processes, one host.** SQLite in WAL mode lets the catalog read while prospector
writes, but only through shared memory, so the two must mount the same directory on the same machine.
Catalog reads stay short, because a long read holds back prospector's checkpoints.

## Enrolment and access

**Nothing is surveyed unasked**: asking for a venue enrols it, and an enrolled venue keeps itself
current across restarts until it is paused.

**One shared secret, `CATALOG_TOKEN`, guards the catalog and prospector**, and leaving it empty turns
the check off. It guards nothing in front of catalog-ui, which adds the token to every request it
forwards: whoever reaches the page's port acts with it.

**The catalog is published on the host** at `CATALOG_BIND:CATALOG_PORT`, and containers on the shared
network reach it as `catalog:8080`. With `CATALOG_PORT` empty, docker picks a free host port, so
anything on the host that must reach the catalog needs `CATALOG_PORT` set.

## What it is for

**So that nothing else has to know how a venue arranges its archive.** Every venue publishes its history
as files, and no two agree on the trees, the names, or which of a month's two renderings you get. A
consumer asks the catalog what exists, in the catalog's own vocabulary, and walks a listing whose keys
say what each file *is*.

A downloader asks the catalog for work instead of asking a venue, and reports back what it fetched, so
"how much is left" is a query rather than bookkeeping each service keeps for itself.
