<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Stocker — what is left

Stocker runs on the catalog: how it works is [STOCKER.md](../services/STOCKER.md), every format is
[STOCKER-PARTITIONS.md](../services/STOCKER-PARTITIONS.md). What follows is not done.

## bybit's MT4 klines are filed under the wrong market

They are perpetual klines (verified against the perp trades); the catalog files them as `spot`, and
stocker reads them as `perp`, so they are not stocked. Fixing it is a prospector change plus a
change to the live catalog and to hauler's files on disk — prepared, not applied:
[STOCKER-NIGHT.md](STOCKER-NIGHT.md#the-bybit-mt4-catalog-fix).

## Cold storage and the version

A partition's version directory is its whole record, so evicting a stocked partition must leave
something behind or stocker restocks it the next time its raw is on disk. The simplest contract:
**eviction deletes the parquet files and keeps the empty `…/YYYYMM/<version>/` directory**.
Stocker then reads it as stocked; restoring from cold storage puts the files back under the same
directory. `tools cold` still packs and evicts the old layout and reads the facts store; it is
the next piece to move onto partitions.

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
