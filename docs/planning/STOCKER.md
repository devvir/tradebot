<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Stocker — what is left

Stocker runs on the catalog: how it works is [STOCKER.md](../services/STOCKER.md), every format is
[STOCKER-PARTITIONS.md](../services/STOCKER-PARTITIONS.md). What follows is not done.

## Not modelled yet

**Instruments and canonical symbols.** `symbol=` holds the venue's own string, so `BTCUSDT` at
binance and `BTC-USDT-SWAP` at okx are not yet one instrument. The mapping has to come from each
venue's instrument listing, never from parsing a symbol, and two pairs producing one canonical id
within a venue and market must be a hard error. The same listing is where margining belongs —
`schema/margin.ts` reads it off symbols until then.

**What an option is.** The strike, the expiry and the side of an option are only spelled inside its
symbol; nothing stocked says them as columns.

**When binance's option summary stamps its hour.** A row is `date` and `hour`, stored as the start of
that hour. "EOH" in the venue's name for the dataset suggests the row is the state at the hour's end;
which it is has not been settled against another source.

**Which leg bybit's option `amount` is.** The trades are stocked with `size = amount` and neither
`baseSize` nor `quoteSize`. Settle it against the underlying — an option on BTC with `amount` 0.05 —
and fill the leg.

**Verification against source.** Nothing re-reads a built partition against raw. Rebinning trades
and comparing against the venue's published klines is the natural check.
