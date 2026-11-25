<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Catalog — what is left

The catalog database is written by prospector and served by the catalog service. How each works is
[PROSPECTOR.md](../services/PROSPECTOR.md) and [CATALOG.md](../services/CATALOG.md), and the API is
[CATALOG-API.md](../services/CATALOG-API.md). This is only the outstanding work on what the catalog
holds. Prospector's own open work is [PROSPECTOR.md](PROSPECTOR.md), hauler's is
[HAULER.md](HAULER.md).

## Instruments as an entity

An instrument is a row of its own — `(venue, market, symbol)` — rather than a string every one of
its series repeats. Its properties are stated once, and series inherit them.

The entity, the link and the state are built — see
[PROSPECTOR-SERIES.md](../services/PROSPECTOR-SERIES.md#instruments). What is left:

**Properties.** `margin` (`linear`/`inverse`/`quanto`), `base`, `quote`, `settle`,
`contract_size`, `expiry`, listed and delisted dates, and one `sources` column — a comma-separated
note of where the values came from (the venue's listing, a rule over the name, a seed, the files).
Adapters return them with the listing for live instruments; rules and seeds cover delisted ones.
Stocker then asks the catalog for margining, and its own symbol rules go.

**Then:** matching instruments across venues, which this opens the door to.

## Slices and partitions

Built — see [PROSPECTOR-STORAGE.md](../services/PROSPECTOR-STORAGE.md#slices-and-partitions), [CATALOG.md](../services/CATALOG.md)
and [CATALOG-API.md](../services/CATALOG-API.md#contents). What is left:

**The live database is a backup, not a catalog.** It is kept as it stands so there is an honest
copy to compare with: its partition counts were copied in rather than computed from its files,
every version is zero, and `file` has no `partition_id`, so prospector cannot run on it. A catalog
built from scratch must arrive at the same place by seeding and discovery; it is the first to hold
real versions, and partition counts are what the two are compared by.

**An audit of the counters.** Nothing recounts a partition from its files. The index on
`file.partition_id` is what makes it one range read; the check itself is unbuilt.
