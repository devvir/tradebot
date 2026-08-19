# Prospector Service

Surveys each venue's published archives and records **every file they contain**, as a queryable
catalog. It fetches no archive data.

Its output is a SQLite database: one row per published file with its path, date, size and
checksum, the **series** it belongs to — market, dataset, variant, instrument — and a record of which
parts of each archive have been established completely. Questions that would otherwise cost network
requests, or a downloader that knew how to read every venue's paths, become queries against it: what
does this venue publish, over what period, how many files, how large, where is a given file, and what
is that file *of*.

## Why it exists

- **Discovery and downloading are separate problems.** Knowing how a venue exposes its keyspace has
  nothing in common with knowing how to fetch, unpack and interpret its files. Split apart, neither
  service carries the other's per-venue nuance: this one never fetches, and a downloader never
  enumerates — it reads a table
- **The stages decouple across machines and across time.** The catalog is a file, so a host with
  bandwidth and little disk can survey while a host with storage downloads from an imported copy —
  and a refresh can be built on one while the other keeps working from the catalog it has
- **The whole picture arrives in hours instead of months.** How many files a venue publishes, how
  large, over which periods — known before anything is fetched. Provisioning is decided up front
  rather than discovered two months into a download, and "1w or 1mo klines", "this symbol or that",
  "is this dataset worth collecting" each carry a real number beforehand

## What it does

- **Maps each archive by asking the venue**, never by a list kept in code. The prefix tree is
  discovered by descent, so a dataset nobody knew about is catalogued the first time it is
  surveyed — which is how binance's `option/`, `BVOLIndex`, `EOHSummary` and `aggTrades` turn up
  without being named anywhere
- **Records everything published**, including datasets we have chosen not to collect. A catalog that
  holds only what someone already wanted cannot answer what else is there
- **Downloads nothing.** It reads listings and the metadata they carry, never file contents
- **Settles what a listing could not say.** Where a venue publishes browsable indexes rather than a
  listing API, size and checksum are missing from the walk, so a probe fills them in a HEAD at a
  time — oldest files first, because everything downstream is organised by month. Where a venue
  publishes no listing at all, that same probe is what decides whether a constructed key is a file.
  The probe follows its walk and ends with it: once the walk is done it drains the backlog, then
  announces the venue synced and stops
- **Keeps up without re-walking.** Once a venue's shapes and instruments are known, finding what has
  appeared since is generating the dates each series is missing and asking about those — no listing
  read, and the same code for every venue, which is the only thing the two venues that cannot be
  listed at all ever do
- **Resumes.** A survey is a job: a set of partitions written down when it starts, each with its own
  cursor. One killed halfway picks up the partitions still open and continues from their cursors,
  and one that cannot finish a partition keeps the job open and retries rather than claiming the
  venue is done
- **Answers in one vocabulary, whatever the venue calls things.** A consumer asks for `1h` `klines`,
  monthly files, in a date range, for these instruments — and gets back URLs that work. Which tree
  the venue files those under, how it spells the interval, and where the date sits in the name are
  all resolved here, because that is the knowledge this service exists to hold
- **Serves the catalog over HTTP**, which is how everything else reaches it — what exists, what is
  owed, what is held, which months are finished, and how much is left. Nothing else opens the
  database. Every endpoint is in [CATALOG-API.md](../../docs/modules/CATALOG-API.md)
- **Surveys when told to, then keeps itself current — across restarts.** `POST /surveys` starts a
  venue and it walks once, then updates daily, until `POST /surveys/pause` stops it or a `refresh`
  throws its progress away and starts over. Starting a venue **enrols** it, so a restart resumes an
  interrupted job, waits out the rest of a venue's interval, and leaves paused and never-asked-for
  venues alone. *Whether* to survey a venue is a decision this service cannot see; *how often* to
  re-read one it is already surveying is just how often the archives move
- **Publishes completion per prefix**, as a timestamp rather than a flag. A venue that backfills
  a month it published years ago moves the stamp, so a re-survey is observable rather than silent

## Venues

| venue | how it is surveyed |
|---|---|
| binance | standard S3 listing, from the **bucket root** — `data/` alone would hide `data3/` |
| bybit | **two servers.** The main archive is a standard S3 listing from the bucket root; the order books sit on another host that answers no listing API, so they are an **HTML index** walk, and one of the three servers here that probes |
| htx | standard S3 listing, from the **bucket root** — two archives live there, one six years deep |
| kucoin | standard S3 listing under `data/` |
| gate | standard S3 listing at the bucket; its CDN serves a cached listing that ignores every parameter |
| okx | **nothing to list at any layer.** Keys are constructed inside measured per-instrument bounds and settled by a `HEAD` each, so nothing is established until it has been asked |
| bitget | **no listing either, and its bucket hides absence** — a key it has never held answers `403`, the same as being turned away. Keys are constructed as okx's are, with two adapter hooks to tell the two `403`s apart |

Adding a venue is one file in `src/adapters/` and one line in `src/venues.ts`, plus a row in the
venues migration for its address. A venue on a platform already represented — a standard S3 bucket, a
browsable HTML index, a bucket that can only be asked one key at a time — adds no other code at all;
a venue reachable some other way adds a scanner beside `src/scanners/s3.ts` and `html.ts`, named
after the shape of the thing rather than after the venue. A venue may also appear twice, as bybit
does: one adapter per server, since each has its own shape and its own limiter.

## Environment

| variable | default | |
|---|---|---|
| `PROSPECTOR_VENUES` | all | comma-separated subset to survey |
| `PROSPECTOR_CONCURRENCY` | `200` | requests in flight at once, across every venue |
| `CATALOG_TOKEN` | — | **required.** The shared secret every API request carries in `x-catalog-token` |
| `CATALOG_PORT` | _(any free)_ | host port the API is published on |

**Concurrency is not a rate.** How fast a venue may be asked — its cadence — is a fact about that
venue, so it lives in its adapter and cannot be set from here: one gate per host, inside the fetch
every caller shares. Concurrency only decides whether that cadence is reachable, since a request
spends most of its life waiting; it can never exceed it.

What `PROSPECTOR_CONCURRENCY` covers is the one thing no adapter can know: every venue's figure can
be right while their sum is not. It is a pool of tickets each request takes and returns, so walking,
mapping and probing all draw from it, whichever venue they belong to.

The catalog lives at a fixed `/data/catalog` in the container; `CATALOG_DIR` on the host is
mounted onto it by the compose file. See [docs/services/PROSPECTOR.md](../../docs/services/PROSPECTOR.md)
for how surveying works.

## What it does not do

It fetches no archive data, and it does not select — everything a venue publishes is catalogued,
whether or not anyone has a use for it, because a catalog holding only what someone already wanted
cannot answer what else is there.

It also makes no claim about a calendar month: a listing is ordered by key rather than by date, so
what it can establish is a whole prefix.
