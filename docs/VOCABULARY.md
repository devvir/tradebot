# Vocabulary

What each term means, everywhere in the platform. Definitions only: how anything is built or run
belongs to the doc of whatever builds or runs it.

## Data

**Venue.** An exchange that publishes market data.

**Source.** How data is obtained from a venue: **archives** (bulk files the venue publishes),
**REST** (its request/response API) or **WS** (its websocket streams). A source is a way of
obtaining data, not a kind of data: a trade is a trade whichever source delivered it.

**Raw.** Data exactly as its source published it. Raw is never modified.

**Canonical.** The platform's own name for something, as opposed to the venue's spelling of it.

**Market.** The kind of contract: `spot`, `perp`, `future`, `option`, `tradfi`. Margining is not
part of it: linear and inverse perpetuals are both `perp`.

**Margining.** What a contract settles in: **linear** (its USD-like quote) or **inverse** (the
coin). It changes what a contract's sizes and volumes mean, and it is not part of the market.

**Symbol.** The venue's own name for an instrument within a market.

**Instrument.** A market and a symbol. A symbol alone identifies nothing.

**Chain.** A family of dated contracts published together under the family's name, every expiry in
one file. Its members differ in expiry alone, so as published a chain is one instrument.

**Dataset.** A kind of data: `trades`, `klines`, `books`, `quotes`, `funding`, `markPrice`,
`indexPrice`, `premiumIndex`, and so on. Some boundaries are conventions: a quote is level 1 of a
book, yet `quotes` is a dataset of its own.

**Variant.** A secondary trait of a dataset, one of its flavours: the interval of a kline, the depth
of a book, whether a book is a snapshot or deltas, whether funding is realised or predicted. A
dataset may have none, or several. Some datasets give theirs a specific name, such as a kline's
**interval** or funding's **kind**, but it is the same idea.

**Format.** How a source writes one dataset variant: container, file type, columns and their
meaning, timestamp unit. A variant may have several formats over time, each valid for a span of
dates.

**Era.** A span of dates over which a venue publishes a dataset variant one way: in one format, or
under one path. Where either changes, the data on each side is another era.

## Archives

**Grain.** How much time one archive file covers: `monthly`, `daily`, `hourly`, `minutely`.

**Part.** One of several files a single period is split into.

**Bundle.** How many instruments one file holds: `instrument` (one) or `market` (all of the
market's). The market bundle is spelled `@` in keys and paths. It is a bundle, never a bucket: a
bucket is only ever an S3 bucket.

**Shape.** Venue + market + dataset + variant + grain: one distinct thing a venue publishes, whatever
its instruments and bundle.

**Slice.** Venue + market + dataset + variant + grain + bundle: a shape in one bundle. Picture a
venue's data as long stripes, one per dataset of a market, growing with time: a slice is one
lengthwise cut of a stripe by its finer traits. The same data at another grain or in another bundle
is another slice. A lens is not a slice, and the vault's directories are *vault slices*, defined in
[STOCKER.md](services/STOCKER.md#path-convention).

**Series.** One instrument's files of one shape, or the market bundle's, over time. Stocker's
*series map* is another thing, defined in [STOCKER.md](services/STOCKER.md#one-series-per-format).

**Floor.** The oldest date an archive publishes a dataset, or one series, from.

**Rendering.** One of the ways a venue publishes the same data: the same venue, market, dataset and
variant at a particular grain and bundle. A day's trades published daily and monthly, or per
instrument and as the market bundle, are renderings of one another. A slice is one rendering of its
data.

**Partition.** One month of a slice: every file its attributes and that month select. It is the
unit data is versioned and stocked by.

**Version.** A value per partition that changes whenever a file in it is added, modified or
removed, and is the same wherever the same files are.

**Run.** One pass of discovery over a venue's archives, finding what was published, changed or
withdrawn since the last. A run belongs to the venue, not to one of the hosts it publishes from.

**Backfill.** A venue's first run, which finds everything already published. Every run after it is
an **update**.

**Settled (partition).** A partition whose month ended long enough ago for the venue to have
finished publishing into it, and that no unfinished run has changed. Everything in a settled
partition was found by a run that completed. Settled is not final: a venue can still republish,
withdraw or publish late, and the partition's version changes when it does.

**Canonical key.** A file's key in the platform's own terms, built from what the file is (venue,
market, dataset and variant, symbol or `@`, period) rather than from where the venue put it. Its
layout is in [CATALOG-API.md](services/CATALOG-API.md#the-key).

**Letter folder.** The level of a canonical key holding the symbol's first letter, written `F`. The
market bundle has none.

**The archives.** The local folder holding downloaded archive files under their canonical keys.

## Pipeline

**Catalog.** The record of every file each venue's archives publish, each under its canonical key.

**Lens.** A named selection of the catalog: a set of whole partitions. For whoever reads through it,
what the lens lets through is the whole catalog.

**Hauling.** Bringing catalogued files to the archives.

**Stocking.** Turning raw files, whatever their source and format, into the canonical form of their
dataset in the vault.

**Vault.** The folder of monthly Parquet files stocking produces: the curated product of every
source. In the vault a dataset has one form whatever venue, source, format, grain or bundle it came
from, so the same data stocked from two partitions is identical.

**Table.** The vault's canonical name for what a dataset is stocked into, with its columns. It need
not be the dataset's name: `books` is stocked into book tables such as `orderBook`.

**Revision.** What identifies one stocking of a partition in the vault. It changes when the archives
it is stocked from change, or when what is written of them does (its columns, types, rows or their
order), and not when only how it is built changes.

**Ledger.** The vault's own record of what it holds: for each partition stocked, what it was stocked
from and at which revision.

**Cold storage.** The remote store that is the system of record for the archives and the vault, and
holds a snapshot of the catalog.

**Origin (cold storage).** Which tree something in cold storage belongs to: the archives or the
vault. Not a source.

**Snapshot (of the catalog).** The catalog's database as it was at one moment, whole. Not a book
snapshot, which is a variant of `books`.
