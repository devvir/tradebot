# Gate

What gate's published archives actually contain, established from the files on disk.

## Discovery: the bucket is fully listable, at its origin

`gateio-public-data` is an ordinary S3 bucket that honours `prefix`, `delimiter`, `max-keys` and
`continuation-token`, and carries `Size`, `ETag` and `LastModified` with every key.

```
https://s3-ap-northeast-1.amazonaws.com/gateio-public-data
```

**Ask it through `download.gatedata.org` and none of that is true**, which is why gate was collected
for so long by constructing URLs and probing them. That host is CloudFront, and it serves a *cached*
`ListBucketResult` for the bucket root while discarding the query string:

| sent | echoed back |
|---|---|
| `?prefix=spot/deals/` (raw or percent-encoded) | `<Prefix></Prefix>` |
| `?marker=spot/deals/202001` | `<Marker></Marker>` |
| `?delimiter=/`, `?list-type=2`, `?max-keys=8` | `<MaxKeys>1000</MaxKeys>`, no delimiter applied |

Every request returns the identical first 1,000 keys — all of them
`delivery_usdt/orderbooks/202305/…` — with `IsTruncated` true and no `NextMarker`. The response is
byte-identical whatever is asked, cache-buster included, and `age` in the headers gives it away
along with `x-cache: Hit from cloudfront`.

**This is the failure worth remembering, not the fix.** The edge answered every question
plausibly and wrongly, so the evidence for "gate publishes no index" was a listing that looked
real. A reply that is consistent with a broken venue is also consistent with a cache in front of a
working one, and only the headers separate them.

Files are still best fetched from the CDN. So gate is listed at one host and downloaded from
another — the same split binance already has, for the opposite reason.

Symbols need not be enumerated at all now: they fall out of the walk. Gate's public API carries
each one's `launch_time` / `create_time`, which is what kept *probing* affordable and is no longer
on the critical path. The portal's own symbol list is embedded in a Next.js chunk
(`/cdn/fe/_next/static/chunks/pages/developer/historical_quotes-*.js`); it is recorded here only so
nobody rediscovers it as an option.

## What is in the bucket, and what is dead

Thirteen top-level trees. Seven are live and worth surveying; the rest are not
market data, or are not gate's, or stopped years ago.

| tree | span | |
|---|---|---|
| `spot/` `futures_usdt/` `futures_btc/` `tradfi/` | current | collected |
| `delivery_usdt/orderbooks/` | 202305 → current | **dated-futures books, collected by nothing** |
| `spot_index/` | 202312 → current | **venue-wide index snapshots, hourly** |
| `options_ticker/` | 202509 → current | **venue-wide options ticker, per minute** |
| `v2/` | 202211–202212 | two months, then abandoned. Carries `market_price/`, which exists nowhere else |
| `hk/spot/` | 202305 → 202402 | Gate.HK — a separate entity, closed. Carries `orders/`, unique here |
| `malta/spot/` | 202301 → 202402 | a separate regional book, retired the same month as `hk/` |
| `future_usdt/trades/` | 202203 → 202211 | note the singular, beside the live `futures_usdt/` |
| `futures_usd/orderbooks/` | 202208 → 202212 | |
| `gatepay/` | — | two spreadsheet templates |

`hk/` and `malta/` matter beyond being dead: they are **different order books**, so their
`BTC_USDT` is not gate.com's. If either is ever wanted it is a venue of its own, never a prefix of
this one. Gate OTC Malta launched 2024-11 and is *not* what `malta/` held — that tree had already
stopped nine months earlier.

### 571 keys are filed one level too high

```
spot/201905/            419 keys
futures_usdt/202107/    130 keys
futures_btc/202107/      22 keys
```

A bare month sits where a dataset name belongs. Each is the size of its canonical twin **to the
byte**, with a different ETag and an earlier mtime — the same content under a layout gate
abandoned, re-uploaded hours later in the right place. Identical length with a different hash is
what recompressing the same data gives, since gzip stamps its own header.

With no dataset segment nothing can say which series they are, so they are unplaceable rather than
merely superseded. `futures_usdt/202107/` is the same month as the
[spot-served-at-futures fault](#2021-07-spot-data-served-at-the-futures-url) below; whether the
symbol sets overlap has not been checked.

## The portal understates the archive

The download form ([announcement](https://www.gate.com/announcements/article/21688)) offers one
floor per business type, not per symbol: filled orders and candlesticks from **2023-01**, market
depth and depth snapshot from **2021-08**, TradFi from **2024-01**.

The CDN serves five years more than the form will hand out. Bisected on `BTC_USDT` spot deals:

| month | |
|---|---|
| 201601, 201701, 201704, 201707, 201710, 201711, **201712** | **404** |
| **201801** | **200** |
| 201901, 202101, 202207, 202301 | 200 |

So the real floor for spot deals is **2018-01**, and it is a floor rather than a rolling window —
files from 201801 are still served. The form's book floor of August 2021 does match what the CDN
serves, so the two sources agree there and only there.

The lesson generalises: a venue's download form is evidence that data *exists* from a date, never
evidence that nothing older is served.

## The two depth products are different data

The portal offers "Market depth" and "Depth snapshot" and they are not two names for one thing:

| | path | fields |
|---|---|---|
| Market depth | `orderbooks` | `timestamp, side, action, price, amount, begin_id, merged` — an event stream, where `set` re-benchmarks a level and `take`/`make` adjust it |
| Depth snapshot | `orderbooks_slice` | `asks[price, qty], bids[price, qty], update, current, id` — whole book states |

Both are hourly, 24 files a day, from 2021-08. The snapshot ships a plain `.gz` of JSON rows; the
delta stream a `.csv.gz`. The snapshot's `id` field exists only for data generated after
2023-04-26.

**The snapshot is not collected.** It covers two pairs per market and no more — `BTC_USDT` and
`ETH_USDT`, or `BTC_USD` and `ETH_USD` on the coin-margined side — which gate documents and its
contract dropdown confirms. Against that, a 20-level snapshot every second adds little on top of
the delta stream, which already carries the full depth and every change to it, and from which any
state can be reconstructed. Two pairs of a redundant view is not worth a series.

If gate ever widens the pair list, that is the thing to re-check — the snapshot's own value
does not change, but its coverage would.

The delta stream records the full depth once, then a change record every 100 ms in which
same-price changes within the window are merged into one row.

## Candlesticks: intervals differ per market, and so does the cadence

Gate documents this at `gate.com/developer/historical_quotes`, and the cadence is the part no
amount of probing would have explained:

| market | intervals | file per |
|---|---|---|
| spot | 30s, 1m, 5m | **day** — `BTC_USDT-20260701.csv.gz` |
| spot | 1h, 4h, 1d, 7d | month |
| `futures_usdt`, `futures_btc` | 10s, 1m, 5m, 1h, 4h, 1d, 7d | month |
| `tradfi` | 10s, 1m, 15m, 1h, 4h, 1d | month |

**A monthly URL for a daily-generated interval answers `NoSuchKey`.** That is why spot's short
intervals read as "not published" through several rounds of probing — including gate's own form,
which builds the monthly URL for them and links to a file that does not exist.

The general recipe the page states:

```
$(biz)/$(type)/$(year)$(month)/$(market)-$(year)$(month).csv.gz
```

7d months are generated on the **7th** of the following month, everything else on the 1st — so a
month that has just turned is not yet complete for weekly bars. K-lines are derived from trades,
so a period with no trade has no row rather than an empty one.

## TradFi is real, and it is candlesticks only

`tradfi/candlesticks_1h/202605/XAUUSD-202605.csv.gz` serves 200. It is the one market with no
trades, no depth and no funding — candlesticks and nothing else.

## Layout

```
gate/spot/deals/<YYYYMM>/<SYMBOL>-<YYYYMM>.csv.gz              spot trades
gate/futures_usdt/trades/<YYYYMM>/<SYMBOL>-<YYYYMM>.csv.gz     USDT-margined perp trades
gate/futures_btc/trades/…                                      BTC-margined perp trades
gate/<market>/candlesticks_<interval>/…                        klines
gate/<market>/orderbooks/…                                     books — hourly, 24 files per day
```

Everything is monthly except order books. Files are headerless, so every series is read
positionally.

## Two trade shapes, and they are not interchangeable

```
futures   ts, id, price, size            4 columns; size is SIGNED — the sign is the side
spot      ts, id, price, size, side      5 columns; size unsigned, side is 1=buy 2=sell
```

Both were established from real rows, not documentation. Futures size is negative on roughly
half of all trades (162,517 of 314,987 on one sampled month); spot size is never negative and
carries the side in its own column, where `1` is a buy — settled by price impact over 7.5 M
`BTC_USDT` trades.

The shapes differ by exactly one column, so reading a spot file with the futures map still
"works": it takes the first four columns and puts the *unsigned spot size* where the signed
futures size belongs. Every trade then reads as a buy, because the side is derived from a sign
that is never negative. This is not hypothetical — see below.

## 2021-07: spot data served at the futures URL

**For 85 symbols, `futures_usdt/trades/202107/` held truncated copies of the corresponding
spot file.** Verified three ways:

- the futures file is byte-identical to the first 3,544 lines of the spot file for the same
  symbol and month (the spot file has 40,577);
- it has 5 columns, the spot shape, where every other month of gate futures has 4;
- re-fetching from `download.gatedata.org` returns **the same bytes** — `md5 1fb163c4da` for
  `FIDA_USDT`, matching what was on disk. Gate publishes this; nothing was mangled in transit.

A full scan of all **16,898** gate futures trade files found the anomaly in **2021-07 only**.

### What it cost: almost nothing

The obvious fear is that garbage stood in for real perp data. It did not. Checking each of the
85 symbols against the rest of its own history:

| | |
|---|---|
| Perp market did not exist yet — first real file is 2021-08 or later | **83** |
| `BAC_USDT` — no gate perp file in any month, ever | 1 |
| `SUN_USDT` — an established perp, trading 2020-12 → 2021-06 | 1 |

So for 84 of 85, gate served spot data where a perp market did not exist. It answered a URL
for a market that had not launched with the wrong file instead of nothing.

**`SUN_USDT` is the only real gap.** See *Known gaps* below.

### How it is handled

`futures_usdt/trades/202107/` holds only the 78 genuine 4-column futures files. The 85 substituted
ones are not collected, and no partition is built from them.

**The exclusion lives in code**, at `services/trucker/src/venues/gate.excluded.ts`: those 85 symbols
are filtered out of `futures_usdt-trades` for 2021-07 and nothing else. It has to be code rather
than an absence, because **gate still serves the same bytes** — any walk of that month fetches the
garbage again unless something refuses it. Collection bookkeeping is disposable by design, so a rule
about what must never be fetched cannot live there; it is versioned and tested (`never offers the
2021-07 futures files that are really spot data`).

Stocker **refuses any file wider than its series declares**, naming it, rather than truncating it to
the declared width. That is a loud, repeating failure by design: a venue serving a wrong-shaped file
is worth knowing about. The alternative is what this case produced before the rule existed — 65
silently wrong partitions, and 20 failures that tripped only by luck, on a truncated timestamp
rather than on the column mismatch itself.

## Known gaps — to fill from REST

**`futures_usdt` trades, `SUN_USDT`, 2021-07 through 2021-09 — three months.**

The archive cannot supply them. Confirmed by asking gate directly rather than inferring from
what trucker holds:

| month | gate's answer | |
|---|---|---|
| 2021-06 | `200`, 533,952 B | real data, collected |
| **2021-07** | `200`, 84,860 B | the **spot copy** — deleted, and re-fetching restores it |
| **2021-08** | **`404`** | gate publishes nothing |
| **2021-09** | **`404`** | gate publishes nothing |
| 2021-10 | `200`, 1,013,625 B | real data, collected |

So this is not a collection gap — trucker walked those months and there was nothing to take.
`SUN_USDT` traded as a perp throughout (files run 2020-12 → 2026-06 either side of the hole),
so these are real trades that exist nowhere in the archive tier.

**REST is the only route**, and this is the concrete item to fill when the REST collector
covers gate. One symbol, three months.

Whether other gate perp symbols have archive gaps of this kind has **not** been surveyed — this
one surfaced because the 2021-07 substitution led to it. A sweep comparing each symbol's
month coverage against its first and last file would find the rest, and is worth doing before
the REST backfill is designed, so it is sized against the real gap list rather than this one
example.

## Truncated final lines

The 2021-07 files are cut mid-row: their last line ends inside a field (`1`, `16275`,
`1627570`, or a complete timestamp with the rest missing). Where the cut landed decided whether
the build failed — a cut inside the timestamp yields a tiny number that resolves to 1970 and
trips the plausibility guard; a cut after it leaves a valid timestamp and the row survives with
NULLs.

Whether truncation is general to gate or specific to these files has **not** been established.

## Zero-byte files

`futures_usdt/trades/{202604,202605,202606}/OPENAI_USDT` are 0 bytes — every month that symbol
appears. They are not valid gzips. Stocker treats a zero-length file as empty and skips the
month rather than failing, so they cost nothing; they are still on disk. Whether the symbol
ever traded has not been checked.

## Sentinel and unit notes

- Gate timestamps are **seconds with a fractional part** (`1627775982.133299`), so they carry
  microsecond resolution. Stocker's inference reads the unit from the value.
- Gate candlesticks are `ts, volume, close, high, low, open` — **open and close are the reverse
  of the obvious reading**. Nothing about a single bar reveals it; it was settled by bar
  alignment across intervals, where 1m, 5m, 1h and 1d bars sharing a start share an open and
  differ in close. Spot and futures share the shape exactly.
- A candlestick's `volume` is the **base** leg on spot as well as futures. Settled by summing
  `spot/deals` per hour and reproducing the candle's figure to six decimal places on every hour
  of BTS_USDT 201812; the quote sum misses by a factor of the price.
