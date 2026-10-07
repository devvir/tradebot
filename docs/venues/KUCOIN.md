# KuCoin

What kucoin's published archive holds, measured against the bucket.

## One bucket, listed where it is served

`historical-data.kucoin.com` answers the standard S3 listing API on the same host that serves the
files, with a size, a last-modified and an md5 ETag for every key. Everything sits under `data/`,
and every file is a day: there is no monthly tree. A `.CHECKSUM` sits beside every archive.

**No limit found.** Measured 2026-09-29 and 30 with `HEAD` requests: 3,951 a second from one machine
and 3,602 from a remote one, without a single throttling answer, on keys the edge had cached. A
missing key goes to the origin and takes 270–700 ms.

## The tree

```
data/<market>/daily/[depth/]<dataset>/<SYMBOL>/[<interval>/]<file>-<yyyy-mm-dd>.zip
```

| market | datasets |
|---|---|
| `spot` | `klines`, `trades`, `depth/orderbooklv50` |
| `futures` | `klines`, `index`, `mark`, `trades`, `fundingRates`, `depth/orderbooklv50` |

`klines`, `index` and `mark` have a directory for each interval.

**`futures` is kucoin's perpetuals** — `XBTUSDTM` and the rest, with the `M` suffix it gives them —
and a handful of quarterly contracts in the same tree, named by a month code and a two-digit year
(`XBTMU26`). Nothing in a path separates the two.

**The books are whole books**, one a row: fifty levels a side, and no deltas. The depth is in the
dataset's name, and `depth/` is the only place this tree is three deep before the instrument.

## Futures klines at `1d` are published broken

Every file under `futures/daily/klines/<SYMBOL>/1d/` declares `time,open,high,low,close,volume` and
then writes five fields a row: the volume is not empty, it is absent. A file fetched fresh is
byte-identical to an earlier copy and matches the MD5 kucoin publishes beside it, so it is the
archive that is wrong.

It is the interval and not the venue. Futures klines at every other interval carry six fields and
six values, spot klines seven and seven, and `index` and `mark` five and five at every interval —
correctly, since a mark-price bar has no volume. Checked across forty symbols: `1d` is six and five
everywhere. The `1m` series is published whole over the same range.

## A name in the API is not always the name in a path

| | the API | the archive |
|---|---|---|
| spot, `klines` and `trades` | `0G-USDT` | `0GUSDT` — no dash |
| spot, books | `0G-USDT` | `0G-USDT` |
| bitcoin perpetuals | `XBTUSDTM`, `XBTUSDM`, `XBTUSDCM` | `BTCUSDTM`, `BTCUSDM`, `BTCUSDCM`, in every tree |
| dated bitcoin contracts | `XBTMU26` | `XBTMU26`, and `BTCMU26` under books |

No contract the API lists begins with `BTC`. The spellings above are as the bucket lists them on
2026-10-08.

**The dash goes back in from the quote currency.** All 1,775 dashed names in the archive, and all
1,007 the API lists, are rebuilt exactly from their dashless form by splitting off the longest quote
that fits: `USDT`, `USDC`, `USD1`, `USDG`, `TUSD`, `DOGE`, `BTC`, `ETH`, `KCS`, `EUR`, `TRX`, `BRL`,
`DAI`, `GBP`, `THB`, `TRY`. The last four are retired — no listed pair uses them — and the archive
still does. 23 of the archive's 2,419 dashless spot names end in a quote kucoin no longer lists at
all, and cannot be split.

## The listings

Spot is `api.kucoin.com/api/v2/symbols` and futures `api-futures.kucoin.com/api/v1/contracts/active`.

**Neither states an ending.** Spot's `enableTrading` is a halt rather than a delisting — one symbol
of a thousand — and the futures endpoint returns only what is active. A symbol leaving the list is
the only ending either of them states.
