# Gate

Gate as a source of market data: what it publishes, where, and how it behaves when asked.

## Archives

What gate's published archives contain, established from the files themselves. Anything not
established is marked as such.

### The bucket is listable, but only at its origin

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

So gate is addressed at its bucket for everything — listing, probing and downloading. The CDN serves
the same files byte for byte (MD5 = ETag on both), and measured 2026-09-29 the bucket answered HEAD at
up to 1,781/s and LIST at up to 1,710/s, flat at ~270 ms, without a single throttling answer — the
ceiling was the client's. From a remote machine the same requests reached about 1,190 a second.

Symbols need not be enumerated: they fall out of the walk. Gate's public API carries each one's
`launch_time` / `create_time`. The portal's own symbol list sits in a Next.js chunk
(`/cdn/fe/_next/static/chunks/pages/developer/historical_quotes-*.js`) — noted only so it is not
rediscovered as an option.

### The trees, and which are dead

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

#### Keys filed at the wrong depth

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

### The portal understates the archive

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

### The two depth products are different data

"Market depth" and "Depth snapshot" are not two names for one thing:

| | path | fields |
|---|---|---|
| Market depth | `orderbooks` | `timestamp, side, action, price, amount, begin_id, merged` — an event stream, where `set` re-benchmarks a level and `take`/`make` adjust it |
| Depth snapshot | `orderbooks_slice` | `asks[price, qty], bids[price, qty], update, current, id` — whole book states |

Both are hourly, 24 files a day, from 2021-08. The snapshot ships plain `.gz` JSON rows, the delta
stream a `.csv.gz`. The snapshot's `id` exists only for data generated after 2023-04-26.

The delta stream records full depth once, then a change record every 100 ms, with same-price changes
inside the window merged into one row. Its depth is whatever the book has: between 45 and 2,204
levels a side across sampled symbols. The snapshot is twenty levels a side, one book a row.

**What a delta row means, measured.** An hour's file opens with the whole book as `set` rows sharing
one `begin_id`; `make` and `take` rows follow, and each carries an amount that is added to its level
or taken from it, not the level's new size. Rebuilding a book that way from a file never drives a
level below zero and never crosses the sides (`BTC_USD`, 2026-06-01 21h, 18,538 rows; `BTC_USDT`
spot, 2021-08-01 00h, 497,333 rows). `timestamp` is in tenths of a second and `begin_id` rises
through the file, so the id is what orders the rows inside one tenth.

**Spot names the side and futures sign the amount.** A spot row is the seven fields above, and `side`
is `1` for an ask and `2` for a bid — in a file's first image every `2` sits below every `1`. A
futures row has six fields and no side, `timestamp, action, price, size, begin_id, merged`, and its
`size` is negative for an ask.

**The snapshot's shape differs by market and by year.** A spot level is `[price, qty]`; a futures level
is an object, `{"p": price, "s": size}`. `current` and `update` are seconds with a fraction in the
2021 files (`1627808401.603536`) and whole milliseconds in the 2026 ones (`1780343999931`). A
coin-margined file can hold nothing but records with empty sides.

**The snapshot is not collected.** It covers two pairs per market — `BTC_USDT` and `ETH_USDT`, or
`BTC_USD` and `ETH_USD` coin-margined — which gate documents and its contract dropdown confirms. A
20-level snapshot adds little over the delta stream, which carries full depth and every change to
it. If gate widens the pair list that is the thing to re-check; the snapshot's value does not
change, its coverage would.

### Candlesticks: intervals and cadence differ per market

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

### TradFi is candlesticks only

`tradfi/candlesticks_1h/202605/XAUUSD-202605.csv.gz` serves 200. It is the one market with no
trades, no depth and no funding.

It is one flat namespace: 508 equities and leveraged ETFs, 80 FX pairs, 54 indices, and 19 each of
metals and commodities, so `AAPL`, `AUDCAD` and `GER40` are siblings. `tradfi/symbols` lists all
680, and every one matches the archive.

#### Its `status` is a market session, not a listing

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

### Layout

```
gate/spot/deals/<YYYYMM>/<SYMBOL>-<YYYYMM>.csv.gz              spot trades
gate/futures_usdt/trades/<YYYYMM>/<SYMBOL>-<YYYYMM>.csv.gz     USDT-margined perp trades
gate/futures_btc/trades/…                                      BTC-margined perp trades
gate/<market>/candlesticks_<interval>/…                        klines
gate/<market>/orderbooks/…                                     books — hourly, 24 files per day
```

Files are headerless, so every series is read positionally.

#### What the catalog places

Prospector reads a series pattern out of the path. The calendar slots — `{YYYY}` `{MM}` `{DD}` — give
the grain, and `{PART}` is where a period's own files are told apart. **Gate publishes two grains and
splits both of them**, so a day of books is a day, in twenty-four parts, rather than an hourly series:

| shape | grain | parts |
|---|---|---|
| `spot/candlesticks_1h/202607/BTC_USDT-202607.csv.gz` | monthly | one file |
| `spot/candlesticks_1m/202608/BTC_USDT-20260801.csv.gz` | daily | one file |
| `spot/orderbooks/202108/BTC_USDT-2021082503.csv.gz` | daily | `00`–`23`, the hour |
| `spot_index/202312/slice_index_1702857600` | monthly | the instant, in Unix seconds |
| `options_ticker/202509/slice_options_ticker_1756691460` | monthly | likewise, a minute apart |

The two snapshot trees name a file by the moment it covers and nothing else, so the only period in
the path is the month above it and that is what they are dated by. How far apart the instants sit is
gate's `expandParts` hook rather than anything in the name — measured over a month, `spot_index` gave
450 consecutive gaps of 3,600 seconds and `options_ticker` 999 of 60. Both are venue-wide files
covering every instrument, so neither carries a symbol.

**Hour 00 decides a day of books.** Gate publishes continuously rather than by activity: over 40
hourly series, 753 of 769 middle days carried all 24 hours and 767 carried hour 00, so a day whose
first hour is absent is a day the instrument was not listed yet or had stopped. The hook probes hour
00 and names the other 23 only once it answers — which turns a quiet day from 24 requests into one.
**Except on a series with no `first` yet**: a series begins when the instrument was listed, which is
mid-day, and none of forty first days carried hour 00. With nothing yet known, every hour is asked
and probing decides.

Files are `.csv.gz`, or plain `.gz` for depth snapshots. Uncompressed `.csv` appears in a few early
months — 99 beside 482 compressed in `spot/candlesticks_1m/201802` — and is a stray copy of the file
next to it, excluded at every venue.

#### What is refused, and where

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

### A dated future's file carries two dates

`delivery_usdt` names a contract by its expiry, so a file there has a date inside the symbol and
another after it: `ADA_USDT_20260605-2026060100.csv.gz` is the 2026-06-05 expiry, hour 00 of
2026-06-01. The period is whatever follows the last `-`.

### The files named by an instant hold a line an instrument

`spot_index/` and `options_ticker/` files are plain text with no header and no extension. Each line is
one instrument, its values parted by single blanks with one trailing; some lines begin with a blank
as well (` DOGE_USD1 0.1003325 `). Nothing inside says when: the instant is the file's name.

A spot index line is `<pair> <price>`.

An option ticker line is the option's name and twelve values with no names:

```
BTC_USDT-20260603-80000-C 9.2 0.4491 701 4 0.4069 200 17 0.4875 0.01039 0.00001 -15.60348 1.62129
BTC_USDT-20260603-80000-P 6430.4 0.4491 200 6162 0 200 6478 0.5931 -0.9896 0.00001 -15.60287 1.62119
```

Read from the numbers, in order: mark price, mark implied volatility; bid size, bid price, bid
implied volatility; ask size, ask price, ask implied volatility; delta, gamma, theta, vega. The
second value is the same for the call and the put of one strike. The fourth and seventh bracket the
first, and the fifth and eighth bracket the second. The ninth is negative on puts and positive on
calls, and the eleventh is negative on both. Gate documents none of this for the files; its API
names the same quantities.

### 2022-11-30 23:00: one hour filed under the wrong month

**Gate wrote the last hour of November 2022 into December's directory.** In all three book trees,
`<tree>/orderbooks/202212/` holds keys stamped `20221130` — and nothing else out of place:

| tree | keys | hour |
|---|---|---|
| `spot/orderbooks/202212/` | 2,897 | 23, and only 23 |
| `futures_usdt/orderbooks/202212/` | 249 | 23 |
| `futures_btc/orderbooks/202212/` | 6 | 23 |

**They are the only copy of that hour.** The properly filed `<tree>/orderbooks/202211/` stops at hour
22 for that day in every one of the three trees, so refusing these keys would lose an hour of books
for every instrument gate listed. They are catalogued.

The cost is that the directory month and the file's month disagree, which a pattern cannot say: the
shape is `{YYYY}{MM}` in the directory and `{YYYY}{MM}{DD}` in the name, and here they are different
months. So three patterns carry the month as a **literal**:

```
spot/orderbooks/202212/{SYMBOL}-{YYYY}{MM}{DD}{PART}.csv.gz
futures_usdt/orderbooks/202212/{SYMBOL}-{YYYY}{MM}{DD}{PART}.csv.gz
futures_btc/orderbooks/202212/{SYMBOL}-{YYYY}{MM}{DD}{PART}.csv.gz
```

**Seeded as retired at 20221130**, because a literal month is a shape that can only ever hold one
day: left live, every series on it would generate keys for a directory that will never gain another
file. Retiring them keeps the files and stops the keyspace. December's own books are ordinary and sit
on the generic pattern, alongside every other month.

A one-off. No other month in any tree has it.

### Misfiled months, beyond the 2022 books hour

**Gate files a period into the wrong month's directory more than once, and everywhere it does the
directory and the filename disagree.** `{YYYY}{MM}` cannot be one month in the path and another in
the name, so path derivation keeps the month literal and every such file grows a shape of its own.

**The shapes cost far more than the files.** A pattern with a literal month can never gain a file
generation could reach — generation fills the filename and leaves the directory fixed — but nothing
marks it finished, so its series stay open and re-ask every day of the patience window for ever.
Measured 2026-09-27: 21 such shapes held 63,506 series, 20,948 still counted active, and produced
**312,336 of gate's 323,229 nightly probes** — 97% of the venue's whole backlog.

**Almost all of the misfiled data is worthless, checked against the archive rather than assumed:**

| where | what it holds | verdict |
|---|---|---|
| `spot/candlesticks_{30s,1m,5m}/2024{07..12}/` | the last day of the previous month | 61,884 of 62,208 have a correctly filed twin of identical size **and** ETag |
| `spot/deals/202108/` | July 2021, truncated | `ADA_USDT` is 1,591 lines against the proper file's 931,801, sharing its opening rows |
| `spot/deals/202106/` | March 2020 of the `_USD` pairs | those are coin-margined **futures** under a spot path; `futures_btc/trades/202003/` holds every one at the same byte count |
| `futures_btc/trades/202106/` | March 2020 again | same size as the proper file, different ETag — recompressed, which the gzip header explains |

All of it is refused by `accepts`, so no shape is created for it.

**324 klines have no correctly filed copy and are kept.** 108 instrument-days at three bar lengths,
822 KB in total, for instruments that barely traded on the day they stopped. What separates them
from the 61,884 duplicates is whether the same file exists in the right directory — a fact about the
archive, not about the path — so no rule recovers it and `adapters/gate/misfiled.ts` enumerates
them. It is a closed list: the misfiling stopped in December 2024 and has not recurred.

Their 18 shapes are **seeded retired**, each at the single day it holds (`20240630` … `20241130`),
for the same reason the 2022 book shapes are: a literal month can hold nothing else.

### Files under the BTC tree that are not its own

**`futures_btc/` is BTC-settled, and its instruments are all `*_USD`.** Every other file under it is
refused by `accepts`, whatever dataset it is filed as. Checked file by file against the archive on
2026-10-01 and 2026-10-03, each one is a copy, a fragment or nothing:

| where | what it holds | verdict |
|---|---|---|
| `trades/202203/`, 2,509 `*_USDT`, `*_ETH`, `*_BTC` | **spot weekly candles**, written 2022-04-03: a week from February and a partial last week | every week is at `spot/candlesticks_7d/`, republished complete in 2024 |
| `trades/202203/`, 4 | spot trades | row for row and byte for byte the `spot/deals/202203/` file |
| `trades/202208/`, 144 | about five minutes of futures trades from 2022-08-05 | every row is inside the month's `futures_usdt/trades/` file |
| `funding_updates/`, `mark_prices/` of `201911`, 4 | the first minutes of 2019-11-20 for EOS and ETH | missing from the properly filed month; refused all the same, since a month split across two files is not one a consumer is asked to stitch |
| `funding_applies/` from `202410`, `dummy` | an instrument named `dummy`, applying a funding rate of exactly zero about hourly | a placeholder |

### Two trade shapes, not interchangeable

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

### 2021-07: spot data at the futures URL

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

Only 78 of that month's futures trade files are genuine 4-column files. Gate still serves the 85
copies, so they are there to be fetched for as long as it keeps them.

### Known gap: `SUN_USDT`, 2021-07 to 2021-09

The archive cannot supply it. Asked of gate directly:

| month | gate's answer | |
|---|---|---|
| 2021-06 | 200, 533,952 B | real data |
| 2021-07 | 200, 84,860 B | the spot copy |
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

### Smaller facts

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

## REST

**How to read this section.** A statement with no mark is what the API answered when it was asked,
in October 2026. *(documented)* marks what gate's documentation or its SDK's reference states and
was not tried. *(not known)* marks what neither settled. Nothing here is inferred from another
venue.

### The API

**One API**: `https://api.gateio.ws/api/v4`, a family per path — `/spot`, `/futures/{settle}`
(`usdt`, `btc`), `/delivery/{settle}`, `/options`.

- **`fx-api.gateio.ws` answers the futures too** *(documented)*.
- **No edge in front of it**: the host resolves to addresses in AWS `ap-northeast-1`, 27 of them
  seen.
- **Times are seconds** in requests and in most answers; trades also carry milliseconds
  (`create_time_ms`).
- **A successful answer is the data itself**, a bare JSON array or object.
- **An error is HTTP 400 with `{label, message}`.** Seen: `INVALID_PARAM_VALUE` (a `limit` over the
  maximum, a window too old), `MISSING_REQUIRED_HEADER` (an endpoint that wants a signature),
  and on 429 `TOO_MANY_REQUESTS`.
- **Futures answers are not compressed**, whatever `Accept-Encoding` asks; spot's are gzip. A page
  of 2,000 statistics is 1.24 MB on the wire.

### Its limits

- **200 calls per 10 seconds for each endpoint, by address** *(documented: "All public endpoints —
  200r/10s per endpoint — IP")*.
- **Every answer counts it down**: `x-gate-ratelimit-limit: 200`,
  `x-gate-ratelimit-requests-remain`, `x-gate-ratelimit-reset-timestamp` (seconds). Also
  `x-in-time` and `x-out-time`, in microseconds.
- **Beyond it**: the 200th call to an endpoint inside ten seconds is the last; the next is HTTP 429,
  `{"label":"TOO_MANY_REQUESTS","message":"Request Rate Limit Exceeded (003)"}`, with zero remaining.
  Two seconds later it answered again.
- **The budget is the endpoint's, whatever is asked of it**: with `/spot/candlesticks` refused for
  one pair it was refused for another, while `/spot/trades` and `/futures/usdt/candlesticks` answered
  with 199 remaining.

### How it is paged

- **By a window**: `from` and `to`, in seconds. Bars and statistics come oldest first; trades and
  liquidations newest first.
- **`limit` and a window exclude each other on bars** *(documented)*: `limit` alone gives the newest
  bars.
- **A `limit` over the maximum is refused**, 400 — 1,001 on spot bars and on funding.
- **Listings page by `limit` and `offset`**; `limit` is at most 100 on `contracts` ("invalid limit,
  must in (0, 100]").

### Endpoints, and how far back each goes

**Nearly every one of them is a window.** The index bars of the option underlyings and the option
settlements are the exceptions.

**Index bars of the option underlyings — `GET /options/underlying/candlesticks`**
- **Ask**: `underlying` (`BTC_USDT`; the twelve there are come from `GET /options/underlyings`),
  `interval`, `from`, `to`, or `limit`.
- **Answer**: `{t, o, h, l, c}`, oldest first.
- **No 10,000-point limit here**: `1m` bars of BTC_USDT answer 1,600 days back (2022-05) and not
  1,700; ETH_USDT has none in 2022-08. A window of 2,001 minutes returned 2,001 bars.
- **With `limit` alone it returned 31 daily bars** for a `limit` of 1,000.

**Bars — `GET /spot/candlesticks`**
- **Ask**: `currency_pair`, `interval` (`1s 10s 30s 1m 5m 15m 30m 1h 4h 8h 1d 7d 30d`), `from`, `to`,
  or `limit` ≤ 1,000.
- **Answer**: rows of strings `[time, quoteVolume, close, high, low, open, baseVolume, closed]`.
- **Reaches 10,000 points of the interval asked**: older is 400 "Candlestick too long ago. Maximum
  10000 points ago are allowed". At `1m` that is a week; at `1d` it is everything — BTC_USDT's
  daily bars start on 2014-05-13.

**Bars — `GET /futures/{settle}/candlesticks`, `GET /delivery/{settle}/candlesticks`**
- **Ask**: `contract`, `interval`, `from`, `to`, or `limit` ≤ 2,000. `contract=mark_BTC_USDT` gives
  mark price bars, `index_BTC_USDT` index bars.
- **Answer**: `{t, o, h, l, c, v, sum}`.
- **Reaches 10,000 points**, the same refusal, for trade, mark and index bars alike.

**Premium index — `GET /futures/{settle}/premium_index`**: `contract`, `interval`, `from`, `to`, or
`limit` ≤ 1,000; `{t, o, h, l, c}`. A window answered 100 bars, `limit=1000` alone 1,000. **Reaches
180 days**: older is 400 "from time exceeds 180-day limit".

**Trades — `GET /spot/trades`**
- **Ask**: `currency_pair`, `from`, `to`, `limit` ≤ 1,000; also `last_id` with `reverse`, and `page`
  *(documented)*.
- **Answer**: `{id, create_time, create_time_ms, currency_pair, side, amount, price, sequence_id}`.
- **Reaches 30 days**: older is 400 "for public trades older than 30 days, download from historical
  data instead". The other ways of paging reach no further: `last_id=1` returned trades of seven
  days before, and `page=100` stays inside the month.

**Trades — `GET /futures/{settle}/trades`**
- **Ask**: `contract`, `from`, `to`, `limit` ≤ 1,000.
- **Answer**: `{id, contract, create_time, create_time_ms, size, price}`; `size` is signed.
- **Reaches 180 days**: 179 answers, 185 is 400 "from time exceeds 180-day limit".

**Funding — `GET /futures/{settle}/funding_rate`**
- **Ask**: `contract`, `from`, `to`, `limit` ≤ 1,000.
- **Answer**: `{t, r}`, newest first.
- **An answer holds 30 days at most**, whatever `limit` says: 90 records at 8 hours, starting at
  `from`.
- **Reaches 180 days**: `from` 179 days back answers, 181 is refused.

**Contract statistics — `GET /futures/{settle}/contract_stats`**
- **Ask**: `contract`, `interval` (`5m` … `1d`), `from`, `limit` ≤ 2,000.
- **Answer**, oldest first: `{time, open_interest, open_interest_usd, mark_price, last_funding_rate,
  lsr_taker, lsr_account, long_users, short_users, long_taker_size, short_taker_size, top_lsr_account,
  top_lsr_size, top_long_account, top_short_account, top_long_size, top_short_size, long_liq_size,
  short_liq_size, long_liq_amount, short_liq_amount, long_liq_usd, short_liq_usd, long_liq_usd_new,
  short_liq_usd_new}` — about 620 bytes.
- **Reaches 180 days**: `from` 179 days back answers, 181 is refused.

**Liquidation orders — `GET /futures/{settle}/liq_orders`**
- **Ask**: `contract` (optional), `from`, `to` — at most 3,600 seconds apart *(documented)* —
  `limit` ≤ 1,000.
- **Answer**, newest first: `{contract, size, order_size, fill_price, order_price, left, time}`.
- **Without `contract` it returns the venue's**, every contract together.
- **A window returns 1,000 at most**, and an hour can hold more: one did.
- **Reaches about 11 months**: 330 days back answers, 350 is empty.

**Insurance — `GET /futures/{settle}/insurance`, `/delivery/{settle}/insurance`,
`/spot/insurance_history`**: a balance a day — `{t, b}`; 31 came back on futures for a `limit` of
1,000, 100 on delivery. Spot's takes `business`, `currency`, `from`, `to`, `limit` ≤ 30 and answers
`{currency, balance, time}`.

**Option settlements — `GET /options/settlements`**: `underlying`, `from`, `to`, `limit` ≤ 1,000;
`{time, contract, strike_price, settle_price, profit, fee, …}`, newest first. **Reaches 2022-09**:
1,500 days back answers, 1,800 does not.

**Loan rates — `GET /unified/history_loan_rate`**: `currency`, `tier`, `page`, `limit` ≤ 100;
`{currency, tier, tier_up_rate, rates: [{time, rate}]}`, one an hour, `time` in milliseconds. Page
200 answers (2024-06).

**The listings**
- `GET /futures/{settle}/contracts`: `{name, type, create_time, launch_time, funding_interval,
  in_delisting, status, delisting_time, delisted_time, …}`. Listed contracts only; none carried a
  delisting time when asked.
- `GET /spot/currency_pairs`: `{id, base, quote, trade_status, buy_start, sell_start, …}`, all in
  one answer.
- `GET /delivery/{settle}/contracts`: `{name, expire_time, cycle, …}`.

### Endpoints that do not, or could not be read

- **`/futures/{settle}/index_constituents/{index}`**: an index's exchanges, prices and weights now.
- **`/delivery/{settle}/settlements`**: asks for a signature ("Missing required header:
  Timestamp").
- **`/options/candlesticks`, `/options/trades`**: empty for the one listed contract tried; how far
  back they go *(not known)*.
- **What needs no signature**, by the SDK's reference: 10 endpoints on spot, 14 on futures, 8 on
  delivery, 12 on options, and the lists and rates of the lending products.
