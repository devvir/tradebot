<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Stocker — what is left

Stocker runs on the catalog: how it works is [STOCKER.md](../services/STOCKER.md), every format is
[STOCKER-PARTITIONS.md](../services/STOCKER-PARTITIONS.md). This is every piece of open work on it.

## Not modelled yet

**Instruments and canonical symbols.** The vault's `symbol` column holds the venue's own string, so
`BTCUSDT` at binance and `BTC-USDT-SWAP` at okx are not yet one instrument. The mapping has to come
from each venue's instrument listing, never from parsing a symbol, and two pairs producing one
canonical id within a venue and market must be a hard error.

**Margining.** `schema/margin.ts` reads it off each venue's symbol until the catalog states it — see
[CATALOG.md](CATALOG.md#instruments-as-an-entity).

**What an option is.** The strike, the expiry and the side of an option are only spelled inside its
symbol; nothing stocked says them as columns.

**The `settlement` table.** `schema/tables.ts` declares it and the `Table` type names it, but no
series writes it. Either a dataset is mapped to it or it goes.

## Not checked against the data

**When binance's option summary stamps its hour.** A row is `date` and `hour`, stored as the start of
that hour. "EOH" in the venue's name for the dataset suggests the row is the state at the hour's end;
which it is has not been settled against another source.

**Which leg bybit's option `amount` is.** The trades are stocked with `size = amount` and neither
`baseSize` nor `quoteSize`. Settle it against the underlying — an option on BTC with `amount` 0.05 —
and fill the leg.

**okx's monthly funding files.** The one okx `funding,realised` entry reads both the daily bundle
(`allswap-fundingrates-…`) and the monthly per-instrument files (`{SYMBOL}-SWAP-fundingrates-…`),
and prefers the monthly one where both are on disk. Only the daily bundle has a fixture. Decode a
monthly file, add it as a fixture, and if its columns differ, give it an entry of its own or restrict
the entry to the bundle.

**okx perpetual trades for 2021-10.** The venue publishes every trade of that month twice, once a
side ([OKX.md](../venues/OKX.md#swap-trades-for-2021-10-list-every-trade-twice)), and they are
stocked as published. The options: keep them so; skip the month with a bound on the series; or keep
one row per `trade_id`, which needs a rule for the side that the data cannot supply. Any change
bumps the series' version so the month is stocked again.

**Series entries no test reads a file through.** Each of these has no fixture:

- read in a way no other entry is, so nothing has checked the mapping against a file: bybit's
  perpetual trades of inverse instruments (`quoteSize = size`), bybit perp `premiumIndex` and bybit
  spot `indexPrice`;
- read the same way as an entry that has one: htx perp `indexPrice` and `markPrice` before 2026-02
  (as htx future `markPrice` of those years), htx future `trades` and `klines` in both eras, htx
  spot and future `books`, gate spot `klines`, okx future `trades` and `klines`, okx perp and option
  `books`, bitget perp `klines`, bitget perp and future `books`, and bitget future `quotes`.

## Not built

**Verification against source.** Nothing re-reads a built partition against raw. Rebinning trades
and comparing against the venue's published klines is the natural check.
