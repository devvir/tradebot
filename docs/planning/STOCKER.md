<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Stocker — what is left

Stocker runs on the catalog: how it works is [STOCKER.md](../services/STOCKER.md), every format is
[STOCKER-PARTITIONS.md](../services/STOCKER-PARTITIONS.md). What follows is not done.

## A first run on real data

The layout and the sweep are tested on fixtures only. Nothing has been stocked through the
partitions endpoint yet: the fresh catalog has no downloaded partitions until prospector and
hauler have run on it. The first real run should check a month stored whole against one stored
per instrument, and a books month's stocked size against its archive size, which is what the
split is decided by.

## Cold storage and the revision

A stocked partition's files are its whole record, so evicting one must leave something behind or
stocker restocks it the next time its raw is on disk. What that is — an empty file at the same
name, a marker beside it — is undecided. `tools cold` still packs and evicts an older layout and
reads the facts store; it is the next piece to move onto partitions.

## Not modelled yet

**Order books.** No venue's books are mapped. A book row nests an array of levels and has to be
exploded into one row per level change to fit the canonical event log; the explosion, the
per-venue projections and the depth and snapshot/delta levels do not exist. They will dominate the
vault.

**Instruments and canonical symbols.** `symbol=` holds the venue's own string, so `BTCUSDT` at
binance and `BTC-USDT-SWAP` at okx are not yet one instrument. The mapping has to come from each
venue's instrument listing, never from parsing a symbol, and two pairs producing one canonical id
within a venue and market must be a hard error. The same listing is where margining belongs —
`schema/margin.ts` reads it off symbols until then.

**Options.** A chain bundles hundreds of series; they need a chain-unpacking reader and a
strike/side encoding in the symbol.

**Verification against source.** Nothing re-reads a built partition against raw. Rebinning trades
and comparing against the venue's published klines is the natural check.

## Smaller

- **The newest month of a lens waits for back-spilling venues**: bitget's 2020-12 under
  `backfill-20` needs 2021-01's first bucket, which the lens does not include.
