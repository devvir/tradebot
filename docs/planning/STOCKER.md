<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Stocker — moving to the catalog

Stocker was built against trucker: it walks trucker's tree, reads each venue's own path layout, and
builds a month once trucker publishes it as collected. Trucker is replaced by prospector (what
exists) and hauler (what is on disk), so stocker has to read the catalog instead. How stocker works
today is [STOCKER.md](../services/STOCKER.md); this is only the change.

## What is tied to trucker

| | today | why it has to change |
|---|---|---|
| discovery | `sources/trucker.ts` walks `<venue>/<the venue's own layout>` | hauler writes the canonical layout instead |
| identification | `seriesFor(venue, path)`, ~50 regexes over venue paths | the canonical path drops what some series need — see below |
| readiness | `milestones.ts` reads trucker's `archives:complete` fact | nothing publishes it any more |
| grouping | `scattered` gathers bitget's two kline eras across a walk | the catalog files both eras under one key |
| config | `TRUCKER_DATA_DIR`, mounted at `/data/trucker` | the archives are hauler's |

Untouched: containers, formats, the column projections, time inference, the canonical tables, the
vault layout and the build. That is most of the code, and the 71 real-file fixtures still hold.

## Two facts that shape it

**The canonical key loses what the series map needs.** binance's USDⓈ-M and COIN-M perpetuals both
land under `perp/trades,default/…`, and their fourth column means opposite things — `quote_qty` on
one, `base_qty` on the other. Only the catalog still knows which a file is, through its `Url`:
`data/futures/um/monthly/trades/EOSUSDT/EOSUSDT-trades-2020-01.zip`.

**A month directory can hold the same data twice.** binance publishes monthly *and* daily files, a
lens that takes every grain hauls both, and both canonical keys sit in the same month directory —
`…|202001.zip` beside `…|20200101.zip` … `…|20200131.zip`. Built as they are, every row is doubled.

## The plan

1. **Discover from the catalog, not the disk.** A `catalog` source pages the bucket listing, through
   a lens like hauler's. Each object gives the file (`<archives>/<venue>/<Key>`) and the venue's own
   path (`Url`), and `seriesFor(venue, Url)` keeps working — the verified series map survives, with
   its regexes adjusted where `Url` carries a prefix trucker's paths did not. Keys come in partition
   order (market, dataset, month, letter, symbol), so a partition is contiguous by construction:
   the grouping can no longer depend on a venue's layout, and `scattered` goes.
2. **Readiness from a closed lens.** Stocker works through a lens that is fully in the catalog —
   the venue surveyed past everything it covers — and a partition is ready once every file the lens
   lists under its key prefix is on disk. Whether a month is "closed" is never asked of the catalog;
   that the lens is complete is a precondition, and what remains is comparing the listing with what
   hauler has brought. The bucket listing needs two additions for that: `prefix`, and a per-object
   downloaded flag beside `FileId`. `milestones.ts` and the `archives:complete` contract go. Cold
   storage decides what to push and evict the same way.
3. **One grain per partition.** Where the venue's monthly file exists, it is the partition's input
   and the dailies are not; otherwise the dailies are.
4. **Staleness by catalog identity.** A partition's record lists its inputs by `FileId`, ETag and
   size, and it rebuilds when that set changes. A missing input still never counts as stale.
5. **Spill stays**, with the neighbouring month's edge files taken from the listing by prefix.
6. **Config, compose, docs.** `TRUCKER_DATA_DIR` becomes the archives root; `CATALOG_API`,
   `CATALOG_TOKEN` and `STOCKER_LENS` are added; `sources/trucker.ts`, `milestones.ts`,
   `scattered` and its tests go; STOCKER.md and the README are rewritten to the new flow.

**And two defects that come along, because the rewrite touches both:**

- **A partition can be built twice in one sweep without anything noticing.** `settle` never updates
   the in-memory ledger after a build, so a second build in the same sweep compares against the
   record from before the sweep. Update the map after each build, and treat a record written after
   the sweep began as a second build — logged, since the known causes are gone.
- **Grouping must not depend on walk order at all.** okx's daily trades are day-major
   (`trades/daily/20260701/…`), so a symbol-month arrives in 29 places, is refused as contested from
   the second, and — worse — the first emission would build a month from one day's file. Catalog
   discovery removes the cause; the contiguity check should stay as the alarm.

## Open questions

1. **Where the build records live.** `vault:built`, `vault:details` and `logs:vault` are in the
   facts store, and the cold tooling reads them. Keep them there until the cold scripts are reworked,
   or move them to a database of stocker's own now?
2. **The grain rule.** Monthly over daily where both exist — the venue's own consolidation, and one
   file to read — or the other way?
3. **One archive root or several.** Hauler writes to `/data/tradebot/archives`; data from 2021 on
   lives under `/storage`. Does stocker read one root, matching hauler, or a list?
4. **Which module.** Stocker sits in depot, which is unused; hauler moved to catalog.
5. **Scope.** Order books and the unmapped gate datasets after the refactor, against the canonical
   datasets, rather than inside it?
6. **The vault built from trucker's raw.** 76% of its partitions were built before the completion
   gate existed and carry no `closedAt` (measured 2026-08-13), so any of them may be a partial month
   recorded as whole. Rebuild the vault from hauler's archives once the refactor lands, or keep it?

## Not modelled yet

**Order books.** The catalog holds them for okx (400 and 5000 levels), bybit (200 and 500), bitget,
gate, htx and kucoin, and stocker maps none. Every other table is one row per fact, so mapping is a
projection; a book row nests an array of levels — 50 to 5000 — and has to be exploded into one row
per level change to fit the canonical event log. That is a reader concern, not a series entry. The
event-log schema and the `ndjson` reader exist; the explosion, the per-venue projections and the
`depth=`/`type=` levels do not. They will dominate the vault: okx's two depths are ~235 MB per
symbol-day and gate's `futures_usdt` ~765 MB.

**Instruments and canonical symbols.** `@meta/instruments` (base, quote, contract type, margining,
expiry, listing) and `@meta/books` (type, depth, resolution, default) are designed and not written.
`symbol=` holds the venue's own string, so `BTCUSDT` at binance and `BTC-USDT-SWAP` at okx are not
yet one instrument. The mapping has to come from each venue's instrument listing, never from parsing
a symbol, and two pairs producing one canonical id within a venue and market must be a hard error.

**Options are out of scope.** An option is priced off strike, expiry and volatility rather than a
price series, a chain is one contract per strike × expiry × side, and a chain file bundles hundreds
of series. Nothing forecloses them: they need a chain-unpacking reader and a strike/side encoding in
the symbol.

**Verification against source.** Nothing re-reads a built partition against raw. The timestamp
guard catches a wrong unit; a wrong column mapping passes it. Rebinning trades and comparing against
the venue's published klines is the natural check.
