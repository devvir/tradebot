# Vocabulary

What each term means, everywhere in the platform. Definitions only: how anything is built belongs
to the doc of whatever builds it.

## Data

**Venue.** An exchange that publishes market data.

**Source.** How data is obtained from a venue: **archives** (bulk files the venue publishes),
**REST** (its request/response API) or **WS** (its websocket streams). A source is a way of
obtaining data, not a kind of data: a trade is a trade whichever source delivered it.

**Raw.** Data exactly as its source published it. Raw is never modified.

**Canonical.** The platform's own name for something, as opposed to the venue's spelling of it.

**Market.** The shape of a contract: `spot`, `perp`, `future`, `option`, `tradfi`. Margining is not
part of it: linear and inverse perpetuals are both `perp`.

**Margining.** What a contract settles in: **linear** (its USD-like quote) or **inverse** (the
coin). It changes what a contract's sizes and volumes mean, and it is not part of the market.

**Symbol.** The venue's own name for an instrument within a market.

**Instrument.** A market and a symbol. A symbol alone identifies nothing.

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

## Archives

**Grain.** How much time one archive file covers: `monthly`, `daily`, `hourly`, `minutely`.

**Part.** One of several files a single period is split into.

**Bundle.** How many instruments one file holds: `instrument` (one) or `market` (all of the
market's).

**Partition.** Venue + market + dataset + variant + bundle + grain + month: every file those
attributes select. The partition is the atom of data: it is downloaded, stocked, cold-stored,
restored and deleted whole, or not at all. The same data at another grain or in another bundle is
another partition.

**Version.** A number per partition that changes whenever a file in it is added, modified or
removed.

**The archives.** The local folder holding downloaded archive files under their canonical keys.

## Pipeline

**Catalog.** The record of every file each venue's archives publish, served as one bucket keyed by
what each file is. Where a venue keeps a file is the catalog's internal business.

**Lens.** A named selection of the catalog. For whoever reads through it, what the lens lets through
is the whole catalog.

**Hauling.** Bringing catalogued files to the archives.

**Stocking.** Turning a partition's raw files, whatever their format, into the canonical form of
their dataset in the vault. It applies to every source.

**Vault.** The folder of Parquet files stocking produces: the curated product of every source. In
the vault a dataset has one shape whatever venue, source, format, grain or bundle it came from, so
the same data stocked from two partitions is identical. Vault files are monthly and one per
instrument.

**Cold storage.** The remote store that is the system of record for raw and vault data. Local disk
holds only what the work in hand needs.
