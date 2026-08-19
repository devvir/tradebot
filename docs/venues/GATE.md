# Gate

What gate's published archives contain, established from the files themselves. Anything not
established is marked as such.

## The bucket is listable, but only at its origin

`gateio-public-data` is an ordinary S3 bucket. It honours `prefix`, `delimiter`, `max-keys` and
`continuation-token`, and carries `Size`, `ETag` and `LastModified` on every key.

```
https://s3-ap-northeast-1.amazonaws.com/gateio-public-data
```

**The same bucket through `download.gatedata.org` is not listable.** That host is CloudFront and it
serves a cached `ListBucketResult` for the bucket root, discarding the query string:

| sent | echoed back |
|---|---|
| `?prefix=spot/deals/` (raw or percent-encoded) | `<Prefix></Prefix>` |
| `?marker=spot/deals/202001` | `<Marker></Marker>` |
| `?delimiter=/`, `?list-type=2`, `?max-keys=8` | `<MaxKeys>1000</MaxKeys>`, no delimiter applied |

Every request returns the identical first 1,000 keys — all `delivery_usdt/orderbooks/202305/…` —
with `IsTruncated` true and no `NextMarker`. Byte-identical whatever is asked, cache-buster
included; `age` and `x-cache: Hit from cloudfront` are what give it away.

**Worth remembering, because it cost years of probing:** the edge answered every question plausibly
and wrongly, so "gate publishes no index" rested on a listing that looked real. A reply consistent
with a broken venue is equally consistent with a cache in front of a working one, and only the
headers separate them.

Files are still best fetched from the CDN, so gate is listed at one host and downloaded from
another.

Symbols need not be enumerated: they fall out of the walk. Gate's public API carries each one's
`launch_time` / `create_time`. The portal's own symbol list sits in a Next.js chunk
(`/cdn/fe/_next/static/chunks/pages/developer/historical_quotes-*.js`) — noted only so it is not
rediscovered as an option.

## The trees, and which are dead

Thirteen top-level trees. Seven are live; the rest are not market data, not gate's, or stopped.

| tree | span | |
|---|---|---|
| `spot/` `futures_usdt/` `futures_btc/` `tradfi/` | current | collected |
| `delivery_usdt/orderbooks/` | 202305 → current | dated-futures books, **collected by nothing** |
| `spot_index/` | 202312 → current | venue-wide index snapshots, hourly |
| `options_ticker/` | 202509 → current | venue-wide options ticker, per minute |
| `v2/` | 202211–202212 | two months. Carries `market_price/`, which exists nowhere else |
| `hk/spot/` | 202305 → 202402 | Gate.HK, closed. Carries `orders/`, unique here |
| `malta/spot/` | 202301 → 202402 | a regional book, retired the same month as `hk/` |
| `future_usdt/trades/` | 202203 → 202211 | singular, beside the live `futures_usdt/` |
| `futures_usd/orderbooks/` | 202208 → 202212 | |
| `gatepay/` | — | two spreadsheet templates |

`hk/` and `malta/` are **different order books**: their `BTC_USDT` is not gate.com's. If either is
ever wanted it is a venue of its own, never a prefix of this one. Gate OTC Malta launched 2024-11
and is not what `malta/` held — that tree had stopped nine months earlier.

### Keys filed at the wrong depth

```
spot/201905/            419 keys      a bare month where a dataset name belongs
futures_usdt/202107/    130 keys
futures_btc/202107/      22 keys
spot_index/slice_index_<epoch>   179 keys   a file where a month belongs
```

The 571 high ones match their canonical twin's size **to the byte**, with a different ETag and an
earlier mtime — the same content under an abandoned layout, re-uploaded hours later in the right
place. Identical length with a different hash is what recompressing gives, since gzip stamps its own
header. Having no dataset segment, they cannot be placed in a series at all.

The 179 low ones each have a twin at `spot_index/{YYYYMM}/slice_index_<epoch>` with the **same size
and same ETag** — one object served at two keys, not a re-upload.

One rule covers both: what sits directly below a tree is a month for `spot_index/` and
`options_ticker/`, and a dataset name for every other tree. Either in the other's place is a
misfiling.

**Unverified:** whether the symbols in `futures_usdt/202107/` overlap those of the
[2021-07 substitution](#2021-07-spot-data-at-the-futures-url).

## The portal understates the archive

The download form ([announcement](https://www.gate.com/announcements/article/21688)) offers one
floor per business type, not per symbol: filled orders and candlesticks from **2023-01**, market
depth and depth snapshot from **2021-08**, TradFi from **2024-01**.

The CDN serves five years more. Bisected on `BTC_USDT` spot deals:

| | |
|---|---|
| 201601, 201701, 201704, 201707, 201710, 201711, 201712 | 404 |
| **201801** onward (201901, 202101, 202207, 202301 sampled) | 200 |

So the real floor for spot deals is **2018-01**, and it is a floor rather than a rolling window —
201801 is still served. The form's book floor of 2021-08 does match the CDN; that is the only
business type where the two agree.

A download form is evidence that data exists from a date, never evidence that nothing older is
served.

## The two depth products are different data

"Market depth" and "Depth snapshot" are not two names for one thing:

| | path | fields |
|---|---|---|
| Market depth | `orderbooks` | `timestamp, side, action, price, amount, begin_id, merged` — an event stream, where `set` re-benchmarks a level and `take`/`make` adjust it |
| Depth snapshot | `orderbooks_slice` | `asks[price, qty], bids[price, qty], update, current, id` — whole book states |

Both are hourly, 24 files a day, from 2021-08. The snapshot ships plain `.gz` JSON rows, the delta
stream a `.csv.gz`. The snapshot's `id` exists only for data generated after 2023-04-26.

The delta stream records full depth once, then a change record every 100 ms, with same-price changes
inside the window merged into one row.

**The snapshot is not collected.** It covers two pairs per market — `BTC_USDT` and `ETH_USDT`, or
`BTC_USD` and `ETH_USD` coin-margined — which gate documents and its contract dropdown confirms. A
20-level snapshot adds little over the delta stream, which carries full depth and every change to
it. If gate widens the pair list that is the thing to re-check; the snapshot's value does not
change, its coverage would.

## Candlesticks: intervals and cadence differ per market

Documented at `gate.com/developer/historical_quotes`:

| market | intervals | file per |
|---|---|---|
| spot | 30s, 1m, 5m | **day** — `BTC_USDT-20260701.csv.gz` |
| spot | 1h, 4h, 1d, 7d | month |
| `futures_usdt`, `futures_btc` | 10s, 1m, 5m, 1h, 4h, 1d, 7d | month |
| `tradfi` | 10s, 1m, 15m, 1h, 4h, 1d | month |

**A monthly URL for a daily-generated interval answers `NoSuchKey`.** Gate's own form builds the
monthly URL for spot's short intervals and links to a file that does not exist — which is why they
read as unpublished until the cadence was known.

The recipe the page states:

```
$(biz)/$(type)/$(year)$(month)/$(market)-$(year)$(month).csv.gz
```

7d months are generated on the **7th** of the following month, everything else on the 1st, so a
freshly turned month is incomplete for weekly bars. K-lines are derived from trades, so a period
with no trade has no row rather than an empty one.

## TradFi is candlesticks only

`tradfi/candlesticks_1h/202605/XAUUSD-202605.csv.gz` serves 200. It is the one market with no
trades, no depth and no funding.

### Its `status` is a market session, not a listing

`/api/v4/tradfi/symbols` reports `status: open | closed` per symbol, meaning **the exchange
session**. These are tokenised equities and ETFs on US market hours; the payload carries
`open_time`, `close_time` and `next_open_time` beside the status. Measured on a Monday at 16:18 UTC:
646 open, 34 closed, of 680. Outside 14:30–21:00 UTC — two thirds of every weekday, every weekend,
every market holiday — **all 680 report `closed`**.

Reading it as a listing retires the whole market on any pass that runs out of hours, and the next
pass inside them revives it: tips drop to the floor and a backfill re-walks years of already
catalogued files. The log signature is a run of *"A newly listed instrument has data below where
probing starts"* for symbols that are not new.

**Appearing in the listing is the listing.** A withdrawal is a symbol leaving that list.

Gate's other three markets do carry listing state and are read as such: spot's `trade_status` is
2,232 tradable against 2 untradable, and `in_delisting` is false for all 981 contracts.

## Layout

```
gate/spot/deals/<YYYYMM>/<SYMBOL>-<YYYYMM>.csv.gz              spot trades
gate/futures_usdt/trades/<YYYYMM>/<SYMBOL>-<YYYYMM>.csv.gz     USDT-margined perp trades
gate/futures_btc/trades/…                                      BTC-margined perp trades
gate/<market>/candlesticks_<interval>/…                        klines
gate/<market>/orderbooks/…                                     books — hourly, 24 files per day
```

Files are headerless, so every series is read positionally.

### What the catalog places

Prospector reads a series pattern out of the path. The slots are a calendar — `{YYYY}` `{MM}`
`{DD}` `{HH}` `{MI}` — and the finest one a pattern carries is the series' grain, so gate's four
cadences fall out of the paths with nothing declared:

| shape | grain |
|---|---|
| `spot/candlesticks_1h/202607/BTC_USDT-202607.csv.gz` | monthly |
| `spot/candlesticks_1m/202608/BTC_USDT-20260801.csv.gz` | daily |
| `spot/orderbooks/202108/BTC_USDT-2021082503.csv.gz` | hourly |
| `spot_index/202312/slice_index_1702857600` | hourly, named by the instant |
| `options_ticker/202509/slice_options_ticker_1756691460` | per minute, likewise |

The two snapshot trees name a file by the moment it covers in Unix seconds and nothing else, so
their patterns carry no date — only `{EPOCH_HH}` or `{EPOCH_MI}`, filled by gate's `slotsFor` hook.
Two names are needed because the number cannot say whether the next file is an hour or a minute
away; over a month, `spot_index` gave 450 consecutive gaps of 3,600 seconds and `options_ticker` 999
of 60. Both are venue-wide files covering every instrument, so neither carries a symbol.

Files are `.csv.gz`, or plain `.gz` for depth snapshots. Uncompressed `.csv` appears in a few early
months — 99 beside 482 compressed in `spot/candlesticks_1m/201802` — and is a stray copy of the file
next to it, excluded at every venue.

### What is refused, and where

Nothing is skipped for being hard to parse. Refusals are deliberate, each in the tier that fits it.

The adapter's `accepts` — shapes, so it holds for keys nobody has published yet, and it is asked
about directories, which are then never descended into:

- the six dead or foreign trees above: `v2/`, `hk/`, `malta/`, `future_usdt/`, `futures_usd/`,
  `gatepay/`;
- the keys filed at the wrong depth, by the one rule above;
- `spot/candlesticks_1d/201802/s3deals/`, spot deals filed inside one month's daily candlestick
  tree — 227 keys.

The `exclusion` table — two specific files, with no shape to describe:

- `futures_usdt/candlesticks_10s/202107/123`
- `futures_btc/mark_prices/202107/hello/123`

Both zero bytes, uploaded four minutes apart on 2021-08-11.

## Two trade shapes, not interchangeable

```
futures   ts, id, price, size            4 columns; size is SIGNED — the sign is the side
spot      ts, id, price, size, side      5 columns; size unsigned, side is 1=buy 2=sell
```

Both established from rows, not documentation. Futures size is negative on roughly half of all
trades (162,517 of 314,987 in one sampled month); spot size is never negative, and `1` is a buy —
settled by price impact over 7.5 M `BTC_USDT` trades.

They differ by exactly one column, so reading a spot file with the futures map still "works": it
takes the first four columns and puts the unsigned spot size where the signed futures size belongs,
and every trade reads as a buy because the side comes from a sign that is never negative.

Stocker **refuses any file wider than its series declares**, naming it, rather than truncating to
the declared width — a loud repeating failure by design. Without that rule this venue produced 65
silently wrong partitions, and 20 failures that tripped only by luck, on a truncated timestamp
rather than on the column mismatch.

## 2021-07: spot data at the futures URL

**For 85 symbols, `futures_usdt/trades/202107/` holds truncated copies of the corresponding spot
file.** The futures file is byte-identical to the first 3,544 lines of the spot file for the same
symbol and month (the spot file has 40,577), and has 5 columns where every other month of gate
futures has 4. Re-fetching returns the same bytes (`md5 1fb163c4da` for `FIDA_USDT`), so gate
publishes this; nothing was mangled in transit.

A scan of all 16,898 gate futures trade files found it in **2021-07 only**.

What it cost, checking each of the 85 against its own history:

| | |
|---|---|
| Perp market did not exist yet — first real file 2021-08 or later | 83 |
| `BAC_USDT` — no gate perp file in any month, ever | 1 |
| `SUN_USDT` — an established perp, trading 2020-12 → 2021-06 | 1 |

So for 84 of 85 gate answered a URL for a market that had not launched with the wrong file instead
of nothing. `SUN_USDT` is the only real gap.

`futures_usdt/trades/202107/` keeps only the 78 genuine 4-column files. **The exclusion lives in
code**, at `services/trucker/src/venues/gate.excluded.ts`, filtering those 85 symbols out of
`futures_usdt-trades` for 2021-07 and nothing else. It has to be code rather than an absence,
because gate still serves the same bytes — any walk fetches them again unless something refuses.
Collection bookkeeping is disposable by design, so a rule about what must never be fetched cannot
live there.

## Known gap: `SUN_USDT`, 2021-07 to 2021-09

The archive cannot supply it. Asked of gate directly:

| month | gate's answer | |
|---|---|---|
| 2021-06 | 200, 533,952 B | real data |
| 2021-07 | 200, 84,860 B | the spot copy; deleted, and re-fetching restores it |
| **2021-08** | **404** | gate publishes nothing |
| **2021-09** | **404** | gate publishes nothing |
| 2021-10 | 200, 1,013,625 B | real data |

Not a collection gap — there was nothing to take. `SUN_USDT` traded as a perp throughout (files run
2020-12 → 2026-06 either side), so these are real trades absent from the archive tier. **REST is the
only route**, and this is the concrete item for when the REST collector covers gate.

**Unverified:** whether other gate perp symbols have gaps of this kind. This one surfaced only
because the 2021-07 substitution led to it. A sweep comparing each symbol's month coverage against
its first and last file would find the rest, and is worth doing before the REST backfill is designed
so it is sized against the real list.

## Smaller facts

**Truncated final lines.** The 2021-07 files are cut mid-row, ending inside a field (`1`, `16275`,
`1627570`, or a complete timestamp with the rest missing). Where the cut lands decides whether the
build fails: inside the timestamp yields a value resolving to 1970 and trips the plausibility guard;
after it leaves a valid timestamp and the row survives with NULLs. **Unverified:** whether
truncation is general to gate or specific to these files.

**Zero-byte files.** `futures_usdt/trades/{202604,202605,202606}/OPENAI_USDT` are 0 bytes — every
month that symbol appears — and are not valid gzips. Stocker treats zero length as empty and skips
the month. **Unverified:** whether the symbol ever traded.

**Timestamps** are seconds with a fractional part (`1627775982.133299`), so microsecond resolution.
Stocker infers the unit from the value.

**Candlestick column order** is `ts, volume, close, high, low, open` — open and close are the
reverse of the obvious reading. Nothing about a single bar reveals it; settled by bar alignment
across intervals, where 1m, 5m, 1h and 1d bars sharing a start share an open and differ in close.
Spot and futures share the shape exactly.

**Candlestick `volume` is the base leg**, on spot as well as futures. Settled by summing
`spot/deals` per hour and reproducing the candle to six decimal places on every hour of BTS_USDT
201812; the quote sum misses by a factor of the price.
