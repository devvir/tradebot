# Gate

What gate's published archives actually contain, established from the files on disk.

## Discovery: there is no usable index

`download.gatedata.org` is an S3 bucket — `gateio-public-data` — and its root does answer a
`ListBucketResult`. It is still not an index, because **every query parameter is ignored**:

| sent | echoed back |
|---|---|
| `?prefix=spot/deals/` (raw or percent-encoded) | `<Prefix></Prefix>` |
| `?marker=spot/deals/202001` | `<Marker></Marker>` |
| `?delimiter=/`, `?list-type=2`, `?max-keys=8` | `<MaxKeys>1000</MaxKeys>`, no delimiter applied |

Every request returns the identical first 1,000 keys — all of them
`delivery_usdt/orderbooks/202305/…` — with `IsTruncated` true and **no `NextMarker`**, so there is
no way to page past them. A directory URL such as `/spot/deals/201801/` answers `404 NoSuchKey`.

So gate's URLs have to be constructed and probed, and that is a property of the venue rather than
a shortcut. The listing does carry `Size` and an md5 `ETag` per key, which would be worth having
if the bucket ever starts honouring `prefix` and `marker`.

Symbols come from gate's public API, which gives each one its `launch_time` / `create_time` — that
is what keeps probing affordable, since most symbols listed long after the archive floor. The
portal's own symbol list is embedded in a Next.js chunk
(`/cdn/fe/_next/static/chunks/pages/developer/historical_quotes-*.js`); it is recorded here only
so nobody rediscovers it as an option, since the API answers the same question properly.

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

### What was done

- The 85 files were deleted from `futures_usdt/trades/202107/`, leaving the 78 genuine
  4-column futures files in that month.
- 65 partitions built from them — spot trades filed as `market=perp`, all-`buy`, wrong `size`,
  plus one junk trailing row each — were deleted with their ledger entries.
- **The exclusion lives in code**, at `services/trucker/src/venues/gate.excluded.ts`: those 85
  symbols are filtered out of `futures_usdt-trades` for 2021-07 and nothing else.

  It was originally kept only by *not touching trucker's progress ledgers* — gate still serves
  the same bytes, so any re-walk of that month restores the garbage. That held until the ledgers
  were cleared for an unrelated reason, at which point the cleanup would have silently undone
  itself. A ledger is disposable by design; a rule about what must never be fetched is not, so it
  is versioned and tested (`never offers the 2021-07 futures files that are really spot data`).
- Cold storage note: `@cold/trucker/gate/gate.202107.p01.tar` was built before the cleanup and
  still contains all 85.

Stocker now **refuses any file wider than its series declares**, naming it, rather than
truncating it to the declared width. That is a loud, repeating failure by design: a venue
serving a wrong-shaped file is worth knowing about, and the alternative is what happened here —
65 silently wrong partitions and 20 failures that only tripped by luck, on a truncated
timestamp rather than on the column mismatch itself.

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
