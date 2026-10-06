<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Stocker — what is left

Stocker runs on the catalog: how it works is [STOCKER.md](../services/STOCKER.md), every format is
[STOCKER-PARTITIONS.md](../services/STOCKER-PARTITIONS.md). What follows is not done.

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

**Options.** Option trades and klines are stocked where they are the other markets' shapes (htx,
okx, bybit trades). What an option has that nothing else does has no place yet: the greeks, implied
volatility, and the strike, expiry and side that are only spelled inside the symbol. Three datasets
wait on that, and want deciding together — one table for an option's mark and greeks, or columns on
`markPrice` that everything else leaves empty:

- **bybit option `markPrice`, 1m.** `instrument_name, open_time, open, high, low, close, delta,
  gama, vega, theta`. The bars fit `markPrice`; the four greeks do not.
- **binance `optionSummary`, 1h.** An hour's summary per option: OHLC, volumes in contracts and in
  USDT, best bid and ask with their sizes and implied volatilities, mark price and mark iv, the four
  greeks, open interest.
- **gate `optionTicker`, ticks.** A line per option of 13 space-separated values with no names. What
  each is has to be settled from gate's own API fields before it is read.

**A format whose time is in the file's name.** Gate publishes its spot index and its option ticker
as one small file per moment, named `slice_index_<epoch>` and `slice_options_ticker_<epoch>`, every
instrument a line. No row carries a time, so a format has to take it from the name; none does. The
spot index is otherwise `<symbol> <price>` and fits `indexPrice` as ticks.

**binance `volatilityIndex`.** `calc_time, symbol, base_asset, quote_asset, index_value`, a value a
second. It is an index and not a price of anything stocked; it needs a table, or a decision that
`indexPrice` holds it.

**binance liquidations on USDⓈ-M perpetuals and on futures.** Only the coin-margined files are
mapped. The others have not been read.

**bitget future quotes.** Not read.

**Which leg bybit's option `amount` is.** The trades are stocked with `size = amount` and neither
`baseSize` nor `quoteSize`. Settle it against the underlying — an option on BTC with `amount` 0.05 —
and fill the leg.

**Whether htx counts both sides in a contract's kline volume, always.** On every minute checked the
published `vol` and `amount` are exactly twice the day's trades: `BTC-USDT` and `BTC-USD` perpetuals
on 2020-11-14, and two option days in 2020-11. That is three instruments and one month, and the
vault stores the klines as published. Before anything is changed it wants checking across the whole
history and every contract market: whether it holds in every year, whether it stops at the
2026-02-01 export or anywhere before it, whether dated futures do it, whether spot ever does, and
whether there is another reading — two files of one trade, a per-side feed — that explains a factor
of two without it being double counting. Only then is halving a correction and not a corruption.

**Verification against source.** Nothing re-reads a built partition against raw. Rebinning trades
and comparing against the venue's published klines is the natural check.

## A lens that is cut in time never completes on a venue that spills

Stocking a month of a spilling dataset reads the edge of the month next to it. Under a lens that
stops at 2020-12, htx's 2020-12 waits for 2021-01, which the lens never lets through; under one that
starts at 2021-01 the same edge is missing from the other side. So the last month of every such lens
is never stocked, and the month before it is never evicted. Ways out, none chosen:

- **Take the lens out of stocker.** What to download is the costly decision and the lens makes it;
  stocker can stock whatever is downloaded and settled. It does not by itself bring the neighbouring
  month to disk: some lens that is hauled still has to let it through.
- **Have a lens extend itself**: an option on the lens, or on the request, that adds one month
  before, after or both to every unbroken run of months of a slice.
- **Have `cold push` notice**: where the vault's ledger is missing a month only for want of its
  neighbour, offer to add that month to the lens.

Only the neighbour's edge is read — the first or last day's files of it — while the whole
neighbouring partition has to be downloaded and settled for it to count.
