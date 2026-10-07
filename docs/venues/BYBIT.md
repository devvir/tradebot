# Bybit

What bybit's published archive contains, and why it is surveyed at the bucket rather than at the
address bybit publishes.

**Bybit is two servers, not one.** Everything below except the order books comes from
`public.bybit.com` and its bucket; the order books live on `quote-saver.bycsi.com`, with a different
tree, a different format and a limiter of its own. The catalog models that as two rows sharing a
name — see [A second host: the order books](#a-second-host-the-order-books).

## The CDN answers no listing API; the bucket does

`public.bybit.com` is CloudFront, and **every query parameter is ignored**: `?prefix=`,
`?list-type=2`, `?marker=` all return the same thing as `/` — the browsable HTML index a plain file
server renders. It names files and says nothing about them, and it bans an address that asks too
fast.

The bucket behind it is **publicly listable**, and answers the ordinary S3 listing API with `prefix`,
`delimiter`, `max-keys` and `marker` all honoured:

```
https://s3.ap-southeast-1.amazonaws.com/public.bybit.com/?prefix=trading/&delimiter=/&max-keys=1000
```

So bybit is surveyed and served there. Three things follow:

- **Listings carry metadata.** Size, last-modified and a real md5 ETag arrive with every key, so the
  walk settles the catalog on its own. There is nothing for a probe to ask, and the ~1.5 M HEAD
  requests one would have cost do not happen.
- **A partition is a straight line**, resumed by a marker, so bybit uses the shared `s3` scanner with
  no dialect of its own.
- **The block is a property of the edge, not of the bucket.** Both were observed at the same instant:
  CloudFront refusing every request from this address while the bucket answered normally.

**Path-style, deliberately.** `public.bybit.com.s3-ap-southeast-1.amazonaws.com` puts the bucket's
own dots into the hostname, where the wildcard certificate does not reach and TLS fails outright.
Addressing the bucket as a path keeps the hostname clean.

**No limit found on the bucket.** Measured 2026-09-30 with `HEAD` requests: about 1,190 a second
from a remote machine and 1,800 from a home link, without a single throttling answer.

This is bybit's setting and it could be revoked. The HTML scanner it used to need stays in the
codebase for that reason and for the next venue that publishes indexes — it is infrastructure for a
platform, not a property of one venue.

## What is in the bucket but is not archive

- `backup/` is a copy: one symbol's `trading/` files, served correctly under `trading/` as well.
- Keys with no `/` in them sit at the bucket root and serve the browsing UI. `index.html` also
  appears *inside* directories — `kline_for_metatrader4/BTCUSDT/2020/index.html` — one per
  instrument per dataset. It is excluded at every venue, so none of them is catalogued or counted
  as a shape still to be read.

No checksums anywhere: every tree holds `.csv.gz` or `.csv.zip` and nothing else. That matters
because bybit's `dateOf` takes the first date wherever it falls in a filename — it has to, since
`premium_index` puts a suffix after the date — so unlike the other S3 venues it would not decline a
name that continued past one.

## Four shapes, and none of them is the obvious one

Every tree names its instrument and its date differently, which is why bybit needs four expressions
where other venues need one:

| tree | shape |
|---|---|
| `trading/`, `premium_index/`, `spot_index/` | the instrument runs **straight into** the date — `BTCUSD2019-10-01_premium_index.csv.gz` |
| `spot/` | both grains in one directory, told apart by the separator — `-2026-08` monthly, `_2026-08-03` daily |
| `trade/option/`, `mark_kline/option/` | dated **first**, keyed by the underlying coin — `2026-08-03_BTC_USDT.trades.csv.zip` |
| `kline_for_metatrader4/` | a whole month named by **both its ends** — `ADAUSDT_15_2021-01-01_2021-01-31.csv.gz` |
| `quote-saver.bycsi.com` (second host) | market, instrument, then date first and the depth last — `linear/BTCUSDT/2025-08-21_BTCUSDT_ob200.data.zip` |

**An instrument's name is letters, digits, dashes and underscores** — match-outcome markets are
listed as `WC_ARG_ALG_USDT-17JUN26` — so its own punctuation says nothing about where it ends. The
date does.

Two of these are worth keeping in mind.

**The metatrader tree is monthly, not a range.** All 4,423 files in the archive cover exactly a
whole calendar month, across five intervals, with no exceptions — so it is an ordinary monthly
series that happens to spell out its own last day. The pattern says so with `{MONTH_LAST_DAY}`, which bybit's
adapter fills in; February is why it cannot be a literal.

**The metatrader klines are the USDT perpetuals, stamped in UTC+3.** The datetimes (`2024.11.01 00:00`)
are the MetaTrader server's zone, with no daylight-saving switch: `BTCUSDT`'s 1h bars equal the perpetual
trades summed per hour, exactly, on every hour of 2020-10 and 2020-12 (over 1,000 hours), and only with
the bar labelled 03:00 holding the trades of 00:00–01:00 UTC. A month's file is therefore a UTC+3 month:
it opens with the previous UTC month's last three hours.

**Four metatrader months are truncated.** `BTCUSDT`'s 1h files for 2023-12, 2024-01 and 2024-03
hold 200 bars and 2024-02 holds 400, against 721–745 for a whole month; the 1m file of 2024-03 holds
200 bars (2024-03-01 00:00 → 03:19). Every other month from 2021-01 to 2024-11 is complete.
Checked on `BTCUSDT` only, on 2026-10-04.

**The order-book host changed depth.** Bybit moved from 500 levels to 200, so a symbol has files of
both and the depth stays literal in the pattern — different depth, different series, exactly as an
interval is treated elsewhere. The host carries `linear/` and `inverse/` and no third market.

## The 2021 expiries are abandoned, and are refused

`trading/` holds 44 dated futures directories. Forty of them — every expiry from 2022 on — carry
197 to 205 daily files each, a contiguous history. **The four 2021 ones do not**, and bybit's own
download form offers nothing older than 2022:

| directory | files | what is in them |
|---|---|---|
| `BTCUSDU21`, `ETHUSDU21` | 2 | one day, 2021-07-26, and nothing else |
| `BTCUSDZ21`, `ETHUSDZ21` | 29 | that same day, 27 days from 2021-12-06, one empty file |

A December-2021 contract traded for months before December, so 27 days is a fragment of it, and a
September-2021 contract with one July day is not a series at all.

**The single day is served twice and the two copies disagree.** `…2021-07-26_v2.csv` is the whole
day, 28,828 rows; `…2021-07-26_v2.csv.gz` beside it holds 307 rows, of which 137 carry a different
`tickDirection` for the same `trdMatchID`. Whatever `_v2` meant, one of the two is wrong and nothing
says which.

All four directories are refused in the adapter's `accepts`, so descent never enters them.

### Eight empty files, all written on one day

Across all 7,424 files in those 44 directories, exactly eight are under 100 bytes. Every one is 44
bytes, is a gzip of **nothing**, and is stamped **2022-12-12** — one per contract live or recent
that day, in `BTCUSDZ21`, `ETHUSDZ21` and the six 2022 expiries. A job that ran once and was never
cleaned up.

Two of them fall inside the refused 2021 directories. Note the size: 44 bytes rather than zero, so
no size rule finds them — only the file itself says it is empty.

## A directory can be renamed out from under its files

`trading/DATAOLD01USDT/` holds files named `DATAUSDT2024-08-23.csv.gz` — 527 of them, from
2023-12-20 to 2025-05-29 — and there is no `trading/DATAUSDT/` at all. Bybit renamed the instrument,
moved the directory and left every filename as it was.

So **the directory is not evidence of the instrument's name**, and a reader that anchored on the two
agreeing read none of these. The date is the anchor instead.

## It bans an address that asks too fast

Bybit's API documents **600 requests per 5 seconds per IP**, answers `403, access too frequent` past
that, and lifts the ban on its own after "at least 10 minutes". Those numbers are published for
`api.bybit.com`, not for the archive — and the archive is stricter in the way that matters: it sits
behind CloudFront, which refuses with its own HTML error page, names no key, and gives no budget away
in any header.

It has been triggered repeatedly, and each time the whole host — file downloads *and* directory
listings — answered 403 "Request blocked" until it lapsed, roughly ten minutes later. Nothing
distinguishes that from a permanent block while it is happening, and the address is static.

**Where the line falls is not known, and no rate this venue has been observed refusing was ever a
measured one.** Until the gate moved into the fetch, the only limiter in the prospector belonged to
the probe — so the walk, which issues most of the requests, was capped by nothing at all. Its rate
was twenty lanes divided by whatever latency allowed that minute, which is not a number anybody had.
The one block that arrived with no probe running (a walk resuming `spot/` and `trading/`) is the
clearest evidence of that: it is attributable to the unlimited half.

The adapter's figure is **30 requests a second**, standing down 10 minutes and doubling from there.

That number is measured rather than guessed. Run at a cap of 50 with the gate applied to every
caller for the first time, the archive refused after **3,855 requests in about 103 seconds**, and the
refusal itself reported the rate at that instant: 39 in the last second, 39 averaged over five, 40
over ten, having peaked at the cap of 50.

```
Blocked by venue — every request to it is paused
    url: "https://public.bybit.com/trading/ANKRUSDT/ANKRUSDT2021-12-12.csv.gz"
    server: "CloudFront"   cache: "Error from cloudfront"   amzError: null
    lastSecond: 39   last5Seconds: 39   last10Seconds: 40
    peakPerSecond: 50   inFlight: 22   sentTotal: 3855   capPerSecond: 50
```

So the **edge** tolerates neither 50 nor a sustained 40. Whether the trigger is the rate, the total
over a window, or the burst to the cap is still not separated — 3,855 in under two minutes is
consistent with all three.

**Tested directly on 2026-10-07**, to see the ban rather than infer it. Paced `GET`s of real files of
about 25 KB (`premium_index` and `spot_index`, 2021), over HTTP/2 on four connections to
`public.bybit.com`, thirty seconds at each rate:

| asked | answered |
|---|---|
| 10, 20, 30 a second | every request `200` |
| 40 a second | every request `200`, 124 ms at the median once the edge had the files |
| 50 a second | 256 answered `200`, then `403` for the remaining 1,244 |

- **Where it tripped:** about five seconds into the 50-a-second stage, after roughly 3,250 requests in
  128 seconds. That does not separate a rate from a total: "more than 40 a second" and "about 3,000 in
  two minutes" both fit, as they fit the earlier 3,855 in 103 seconds.
- **How long it lasted:** refused from about 14:13:20 UTC and answering `200` again by 14:18:39 — some
  five minutes, not ten.
- **What it covered:** `public.bybit.com` alone. The bucket,
  `s3.ap-southeast-1.amazonaws.com/public.bybit.com`, answered `200` for the same file throughout.
- **A request with no `User-Agent` is refused outright**: the first attempt, at 10 a second from a
  client that sent none, got `403` on every one of 300 requests, with no ban involved — curl was
  answered `200` at the same moment.

**None of that measures the bucket**, which is a different host with a different limiter: S3 asks for
a slower pace with a retryable 503 rather than turning an address away. 30 is carried over because it
is below every figure in that line and nothing yet says the origin is more permissive. If it refuses,
the block states its own numbers and the answer moves from those.

What protects the address, though, is not the number but the response. One `Pace` per venue sits
inside the fetch every caller shares, so a refusal naming no key latches the whole venue at once —
walk, mapping and probe together, including requests already queued — and it is not retried, because
a ban lapses only while nothing is asking.

## Eight trees

```
trading/<SYMBOL>/<SYMBOL><yyyy-mm-dd>.csv.gz                    derivatives trades
spot/<SYMBOL>/<SYMBOL>-<yyyy-mm>.csv.gz                         spot, monthly
                <SYMBOL>_<yyyy-mm-dd>.csv.gz                    spot, daily
premium_index/<SYMBOL>/<SYMBOL><date>_premium_index.csv.gz
spot_index/<SYMBOL>/<SYMBOL><date>_index_price.csv.gz
kline_for_metatrader4/<SYMBOL>/<year>/<SYMBOL>_<interval>_<from>_<to>.csv.gz
trade/option/<UNDERLYING>/<date>_<UNDERLYING>_USDT.trades.csv.zip
mark_kline/option/<UNDERLYING>/<date>_<UNDERLYING>_USDT.OHLC.csv.zip
```

**The last two are options, and the HTML indexes expose neither.** They are reachable and promised to
nobody, which is a reason to take them sooner rather than to skip them — the same judgement as
binance's `data3/` and htx's `data/`. They are keyed by underlying rather than by symbol, and are the
only trees here in `.csv.zip`.

**The index and mark trees are one-minute bars, and say so.** Each `premium_index` and `spot_index`
file carries a `period` column reading `1`, and its rows are 60 seconds apart — 1,440 a day, checked
across twelve files of each. Option mark bars are a uniform 60,000 ms between `open_time` values.

Everything below the root is discovered rather than declared, so the adapter names none of it.

## A second host: the order books

Order books are not in the eight trees above and are not on that host at all:

```
base    https://quote-saver.bycsi.com
root    orderbook/
layout  orderbook/{linear,inverse}/<SYMBOL>/<yyyy-mm-dd>_<SYMBOL>_ob<depth>.data.zip
```

**A separate server means a separate everything.** Different address, different tree, browsable HTML
indexes instead of a bucket listing, and its own limiter — so it is a second adapter
(`bybit.secondary.ts`) and a second `venue` row rather than a branch inside the first. The pair
`(name, host)` identifies a server while `name` still identifies the venue, so asking for "bybit"
selects both and a stand-down earned on one cannot stop the other.

The host labels are `primary` and `secondary`, and are deliberately fact-free. They name neither the
technology nor the contents, because both move: both hosts are CloudFront today, either would be S3
the day an origin bucket is found, and data served from one could be served from the other.

**The depth changed mid-history, and the tag records it.** `linear/BTCUSDT/` holds:

```
ob500     946 files   2023-01-18 → 2025-08-20
ob200     353 files   2025-08-21 → 2026-08-08
```

No date carries both, so bybit switched from 500 levels to 200 on 2025-08-21. `tagOf` reads the
depth out of the name rather than answering a constant — tagging everything `ob500` would record a
quarter of the archive as something it is not, and a 200-level book is not a 500-level one. That
distinction is invisible once stored as fact and unrecoverable afterwards.

It **probes**: an index names files and states nothing else — no size, no last-modified, no
checksum — so every row it yields arrives unsettled. This is the case the `html` scanner and the
probe were both kept for when the primary host moved to bucket listings. The indexes are generated
rather than stale; `orderbook/linear/` was rewritten the morning it was checked.

**No limit found.** Measured 2026-09-30: 5,496 `HEAD`s a second from the remote on keys the edge had
cached, and 3,870 a second from here on missing ones, which the edge passes to the origin (~220 ms),
without a single throttling answer.

**A missing key's `404` carries neither a length nor chunking**, which Node's HTTP/1.1 client answers
by closing the connection. The host speaks HTTP/2, where a probe is a stream and the question does
not arise — prospector probes it that way.

### What a book file holds

The `.data.zip` holds one file of a JSON record a line:

```
{"topic":"orderbook.200.XAUTUSDT-19JUN26","type":"snapshot","ts":1780272001020,
 "data":{"s":"XAUTUSDT-19JUN26","b":[["4518.3","1.178"],…],"a":[…],"u":1,"seq":13314825492},"cts":…}
```

`type` is `snapshot` where the stream opens — twice in each of three files read — and `delta` after.
`b` and `a` are `[price, size]` levels, and a size of `0` removes the level. `ts` is in milliseconds,
unique and rising through a file. `seq` rises through a file; `u` starts over at each snapshot.

### Its origin bucket is not findable

Repeating the search that worked for the primary is a waste of time:

- A missing key returns S3's own 404 through the edge, but it carries only `Code`, `Key`,
  `RequestId` and an opaque `HostId`. There is no `BucketName` field — the leak that gave up okx's
  bucket has no S3 equivalent.
- The sibling convention does not hold. `public.bybit.com` is literally a bucket name, but
  `quote-saver.bycsi.com`, `quote-saver`, `bycsi.com` and `bybit-quote-saver` all answer
  `NoSuchBucket` from `s3.amazonaws.com`, where a bucket in another region would answer
  `PermanentRedirect` and name itself. The S3 namespace is global, so those names exist nowhere.

The cost of staying on the CDN here is a HEAD per file, which the probe supplies. It is not the cost
the primary faced, where listings saved roughly 1.5 M of them.

## The venue that makes `tag` necessary

Two separate cases, and neither can be expressed as a prefix.

**`spot/` publishes the same month twice in one directory**, told apart by nothing but the filename:

```
spot/BTCUSDT/  BTCUSDT-2022-11.csv.gz      monthly
               BTCUSDT_2026-08-03.csv.gz   daily
```

Hyphen against underscore. Binance separates its two renderings with a path segment and gate implies
it by dataset name; here the tag comes from whether the name carries a day at all.

**MetaTrader klines publish one period at five intervals at once** — `1`, `5`, `15`, `30`, `60`,
which MetaTrader counts in minutes — all in the same year directory. There the interval is what tells
two files for one period apart, so it is the tag.

## Dates are not at the end of a name

Every other venue puts the date last. Bybit puts a suffix after it (`_premium_index`,
`_index_price`), runs the symbol straight into it (`BTCUSDT2020-03-25`), and gives MetaTrader files
two dates. So the **first** date in the filename is the one that counts, and a range is dated by
where it starts. A month with no day is stamped at the first of that month, as everywhere else, so a
query for a month catches it alongside that month's days.

## The instrument listing

`api.bybit.com/v5/market/instruments-info`, asked a category at a time: `spot`; `linear` and
`inverse`, which are both perpetual swaps, settled in stablecoin and in the base coin; and `option`,
answered one underlying at a time. Option defaults to `baseCoin=BTC` and there is no public way to
enumerate the underlyings — there are eight.

**Names are the archive's.** All 549 live spot symbols and 859 of 862 live perpetuals are in the
archive under exactly the name the API returns; the three that were not had been listed that day.

**Derivatives state an ending; spot does not.** Asked for `status=Closed`, a derivative category
answers 955 contracts that share nothing with its 836 live ones. Spot answers the live list again,
byte for byte, so there an ending is only ever an absence.

## The misfiled file

`trading/DOTUSD/DOTUSDT2021-12-06.csv.gz` is genuinely served: a file named for `DOTUSDT`, in
`DOTUSD`'s folder. It holds DOTUSDT rows and is a shorter copy of the day served whole at
`trading/DOTUSDT/DOTUSDT2021-12-06.csv.gz`:

| | bytes | trades | from | timestamps |
|---|---|---|---|---|
| under `DOTUSDT/` | 2,185,333 | 55,249 | 00:00:02 UTC | with fractions of a second |
| under `DOTUSD/` | 1,758,646 | 45,780 | 06:06:23 UTC | whole seconds |

Every trade id of the shorter one is in the whole one (2026-10-07). One misfiled artifact, not a
pattern.

## WebSocket

Verified live on 2026-07-26.

```json
publicTrade.BTCUSDT  {"T":1785060230817,"s":"BTCUSDT","S":"Buy","v":"0.001","p":"64474.20",
                      "L":"PlusTick","i":"f520fc20-…","BT":false,"RPI":false,"seq":715964329311}
orderbook.1.BTCUSDT  {"s":"BTCUSDT","b":[["64474.1","1.4"]],"a":[["64474.2","7.108"]],"u":4030692,"seq":715964319629}
tickers.BTCUSDT      {"symbol":"BTCUSDT","markPrice":"64475.28","indexPrice":"64510.19",
                      "openInterest":"57733.175","openInterestValue":"3722362623.41",
                      "fundingRate":"0.00001534","nextFundingTime":"1785081600000","fundingIntervalHour":"8",
                      "fundingCap":"0.005","turnover24h":…,"volume24h":…,"bid1Price":…,"ask1Price":…}
```

**The archive's trades are at least as good as the feed.** The perpetual trade files carry every
field `publicTrade` does — `tickDirection` is `L`, `trdMatchID` is `i`, and `RPI` — with a
sub-millisecond timestamp (`1784851200.0547`) where the feed's `T` is whole milliseconds. The feed
adds only `seq` and the block-trade flag `BT`.

**`tickers` is the only source of open interest and funding.** Mark and index price, open
interest and its value, the funding rate, its cap, interval and next time all arrive in one
payload, and none of them is in the archive — only premium-index and spot-index klines are.
Whether the REST API serves their history (`/v5/market/funding/history`, the open-interest
endpoints) is not established.
