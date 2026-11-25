# Bitget

Bitget as a source of market data: what it publishes, where, and how it behaves when asked.

## Archives

What bitget's published archives contain, and how its several catalogues name the same instrument.
Everything here is measured against the venue unless marked **Unverified** or **Assumption**.

### Where it is served

#### The archive

Files sit under `https://img.bitgetimg.com/online/`, always `.zip`, never with a query string. The
first path segment is the dataset — `kline`, `trades` or `depth` — and the date appears exactly once,
in the last segment, never in a directory.

#### A missing key answers 403, and that is the venue's defining fact

The bucket grants `GetObject` and not `ListBucket`, so S3 answers an object it never held exactly as
it answers one it refuses:

```
HTTP/2 403
server: AmazonS3
<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>
```

By status alone a missing key is indistinguishable from a forbidden one.

**Who answered separates them.** A `403` with `server: AmazonS3` means no such key. A `403` or `503`
from the CloudFront edge under its own `server` never reached the origin, and is a refusal of the
client. That is the only distinction available on a `HEAD`.

### Limits

#### Its edge limits the rate, near 2,900 a second

Keys known to exist answer from CloudFront's cache: **597,000 `HEAD`s in one afternoon, not a single
non-200**, at up to ~3,500/s.

```
 workers       rate        n     p50      p95   client CPU
      40     977.2/s    29318     37ms      51ms     4.3%
      80    2005.1/s    60177     37ms      47ms     8.5%
     400    3506.5/s   140325     55ms     313ms    27.8%
```

**A missing key is a different request.** The edge has nothing cached for it and asks the origin, so
it takes ~235 ms rather than ~15. Measured 2026-09-30 over HTTP/2: 539/s at 250 in flight, 732/s at
500.

**The limit is CloudFront's own.** Measured 2026-09-30: at 500 in flight, `HEAD`s reached ~2,900/s
over ten seconds, with one second at 3,940, and the edge answered
`503 — x-cache: LimitExceeded from cloudfront` until the requests stopped. Capped at 2,500/s, they
held ~2,300/s without a single refusal for as long as they were watched.

**A missing key's `403` carries neither a length nor chunking**, which Node's HTTP/1.1 client answers
by closing the connection: 1,000 such probes opened 1,000 connections, and each paid a TLS handshake.
The host speaks HTTP/2, where a probe is a stream and the question does not arise.

**The web endpoints are the opposite.** Everything on `www.bitget.com` is rate limited and sits
behind Cloudflare: roughly one request a second sustained, 429 above that, and a challenge page
instead of JSON without a browser `User-Agent` and a `cf_clearance` cookie. A client that treats a
challenge or a 429 as "no results" records silence as fact.

### Layout

#### The three naming eras

The same series is published under different shapes over time. Both boundaries are exact and apply
across the archive, not per symbol; the exceptions are the kline keys described below.

| era | from | to |
|---|---|---|
| 1 | the archive's start | 2024-04-18 |
| 2 | 2024-04-19 | 2026-08-17 |
| 3 | 2026-08-18 | current |

Era 1 folds the symbol and market token into the filename; era 2 takes them out, leaving a bare date;
era 3 puts the symbol back while keeping era 2's directory layout.

```
spot   kline    kline/{S}/SP/20260817.zip         ->  kline/{S}/SP/{S}_SP_1min_20260818.zip
spot   trades   trades/SPBL/{S}/20260817_001.zip  ->  trades/SPBL/{S}/{S}_20260818_001.zip
spot   depth    depth/{S}/1/20260817.zip          ->  depth/{S}/1/{S}_1_20260818.zip
perp   kline    kline/{S}/UMCBL/20260817.zip      ->  kline/{S}/UMCBL/{S}_UMCBL_1min_20260818.zip
perp   trades   trades/DMCBL/{S}/20260817_001.zip ->  trades/DMCBL/{S}/{S}_20260818_001.zip
perp   depth    depth/{S}/2/20260817.zip          ->  depth/{S}/2/{S}_3_20260818.zip
```

The era-3 filename differs per dataset, so one rule does not cover the change: klines take symbol +
token + `1min` + date, trades take symbol + date + part with **no token**, depth takes symbol +
market digit + date. And **perp depth writes `3` where its own directory writes `2`**; spot depth
writes `1` in both. There is no `3` anywhere else in the archive.

At the 2024 boundary, **trades overlap on exactly one day**: 2024-04-18 is served under both names
with identical row counts, first and last timestamps, and md5 of the uncompressed payload. Only the
zip containers differ. The download index consistently attributes that day to the old name.

**Klines do not cut cleanly at all**: era-2 candlestick keys exist for scattered days years before
that era began, so a day can be served under both eras' names.

**440 era-2 kline keys are dated before 2024-04-19** (237 perp, 203 spot): 417 duplicate an era-1
key for the same day, and 23 are that day's only copy. Measured on 2026-10-02 (klines `1m`, both
lines):

| | perp | spot |
|---|---|---|
| era-2 kline keys dated before 2024-04-19 | 237 | 203 |
| … with an era-1 key for the same day | 229 | 188 |
| … the only copy of that day | 8 | 15 |

The days are scattered — 2019-08-01 to 2023-02-21, mostly `BTCUSDT` and `XRPUSDT` — and the index
lists the era-2 key for every one of them. The trades day is the other way round: for 2024-04-18 the
index lists the era-1 key of every instrument, and era 2's copy is the duplicate.

**Twenty of the only-copy days are holes in a continuous era-1 series**, with the days either side
held in era 1 — 2020-02-29 (`BTCUSDT`, `XRPUSDT` perp, `XRPUSDT` spot), 2023-01-05 and 2023-02-21.
For those days the file sits only at the era-2 key: `kline/{S}/UMCBL/{YYYYMMDD}.zip` on the futures
line, `kline/{S}/SP/{YYYYMMDD}.zip` on spot. The other three are isolated files, with no era-1 days
around them.

**Where both kline copies hold data, they hold the same candles**: every pair unpacked and compared
on 2026-10-08 (ten of them) matched time for time and value for value. Only the export differs: the
era-2 one writes lowercase headers (`basevolume`) and the shortest float, the era-1 one camelCase and
the full binary expansion. The era-2 copy was written later: for perp `ADAUSDT` 2022-01-19 the era-1
file's `Last-Modified` is 2022-11-01 and the era-2 one's 2024-07-30.

**Some era-1 copies are empty**: a 22-byte zip with nothing in it, where the era-2 key holds the full
day. Perp `ADAUSDT` 2022-04-03 answers 22 bytes at `kline/ADAUSDT/ADAUSDT_UMCBL_1min_20220403.zip`
and 64,051 at `kline/ADAUSDT/UMCBL/20220403.zip`; perp `BNBUSDT` 2022-01-19 and 2022-05-18 are the
same. Of 75 perp pairs compared on 2026-10-08 (seven `…USDT` symbols, 2022-01-19 to 2023-01-05), ten
era-1 files were empty. How many era-1 kline files are empty across the archive has not been
measured, and the table above counts keys, not their contents.

##### Every shape, and the token rules

Twenty-six shapes cover the archive, counting the monthly trees. **Every one of 5,055,779 indexed URLs matches exactly one of
them, with no ambiguity and nothing unmatched** — measured by anchoring each shape as a regular
expression and testing every URL against the shapes of its own market and dataset.

**The margin token varies only in futures trades**, which take `UMCBL`, `DMCBL` or `CMCBL`; every
other series has one fixed token. Which token a file takes depends on the *series*, not only the
market:

| series | token |
|---|---|
| spot trades | `SPBL` |
| spot klines | `SP` |
| futures trades | `UMCBL` USDT-margined, `DMCBL` coin-margined, `CMCBL` USDC-margined |
| futures klines | **`UMCBL` for every margin type**, coin-margined included |
| depth | market digit — `1` spot, `2` futures |

So coin-margined klines sit under `UMCBL`: `kline/BTCUSD/DMCBL/…` answers 403 while
`kline/BTCUSD/UMCBL/…` answers 200.

**Nothing in a futures symbol says which margin token its trades take.** It is the margin type of the
API category the contract is listed under — `USDT-FUTURES`, `COIN-FUTURES` or `USDC-FUTURES` — and a
contract asked for under the wrong token answers the same `403` as a missing key.

**The symbol in a path never contains an underscore** — 0 of 5,055,779 URLs.

#### Depth is two datasets, and one of them is invisible without a parameter

`deptType: 2` on the download index returns a different tree from the default, `deptType: 1`:

```
quotes  depth/BTCUSDT/1/BTCUSDT_1_20260901.zip
books   depth_500/BTCUSDT/1/BTCUSDT_1_20260901.zip
```

A level-1 depth file is quotes; `depth_500` is a real 500-level book. The two are separate
datasets with separate keys, and a request that omits `deptType` never sees the second.

A `depth_500` file is `timestamp, asks, bids`: an image of the book every twenty seconds, `timestamp`
in whole seconds, each side JSON text in one cell — `[[1.0082,0.7161],[1.0173,0.7161],…]`, a level
`[price, size]`. Like klines and quotes it is a sheet in a day's file and a CSV in a month's.

**Books carry one shape and no eras.** Measured over 794 windows across both business lines, the
whole range, with no window failing: 324,979 files under `depth_500/{S}/1/{S}_1_{DATE}.zip` for
1,704 spot-line symbols, and 262,808 under `depth_500/{S}/2/{S}_3_{DATE}.zip` for 1,099 on the
futures line. Both begin **2025-08-01** and neither has a second spelling: this dataset launched on
the era-3 convention, which the other datasets adopted only at the 2026-08-18 boundary.

The perp quirk holds here too: the directory says `2` where the filename says `3`.

**374 keys name one instrument in another's directory**, on exactly four dates — 2026-07-01, and
2026-09-03 through 05, the last three carrying 105 each. Both sides run alphabetically in step
(`ADAPERP` → `ALPINEUSDT`, `ALGOUSDT` → `AMDONUSDT`), which is the venue zipping two sorted
lists with an offset rather than a naming convention. Every one is served, 200. Neither name can be
trusted for them, and no single-symbol shape reads them.

### Naming

#### Bitget names one instrument four different ways

This is the venue's central difficulty. Four catalogues, four spellings, none authoritative alone.

| catalogue | what it is | spelling |
|---|---|---|
| the archive itself | the path segment files sit under | `AAVEPERP`, `KLAYUSDT`, `LOBSTERUSDT` |
| the download form's dropdowns | what the portal offers for download | `AAVEUSDC`, `KAIA/USDT`, `龙虾USDT` |
| the REST APIs | what trades today | `AAVEPERP`, `KAIAUSDT`, `龙虾USDT` |
| the trading platform search | the venue's own cross-reference | all of the above, in one record |

A worked example, one instrument:

```
REST v2                 BTCUSDU26
portal search           symbolCodeDisplayName BTCUSDU26      symbolCode BTCUSDU26
                        symbolDisplayName     BTCUSD0925      symbolId   BTCUSD_DMCBL_260925
download form label     BTCUSD0925
archive path            BTCUSDU26
web UI URL              BTCUSD_DMCBL_260925
```

##### The four endpoints

**The dropdown list.** `POST /v1/statistics/public/download/getSymbolList` with
`{displaySymbol, businessLine, businessType, languageType}`. Substring search, matching anywhere in
the name, capped at 200 results with no pagination — a reply of exactly 200 hides an unknown number
more. Enumerating it means asking every substring and refining any query that comes back full, over
all six `businessLine` × `businessType` combinations.

**The download index.** `POST /v1/statistics/public/download/getPublicDataV2` with
`{displaySymbol[], businessLine, businessType, dateType, beginTimeStr, endTimeStr}`. Returns one row
per published file: `dateTimeStr`, `fileName`, `fileUrl`, `displayName`.

- `businessLine` 1 spot, 2 futures (both margin types at once); 3+ → `40003`
- `businessType` 1 klines, 2 trades, 3 depth; 4+ → `40003`
- **`deptType` selects which depth stream**, and omitting it is not neutral — it answers as `1`.
  `1` is the quote stream under `depth/`, `2` the 500-level book under `depth_500/`, and `3`
  is `40003`. It is meaningful only with `businessType: 3`
- the window is **eight inclusive days** (`end - begin <= 7`)
- `displaySymbol` is a **list and is unbounded** — 4,817 names in a 55 KB payload is accepted, and
  returns byte-identical results to asking one market's names alone. This is what makes a full sweep
  a few thousand requests rather than a million.
- a wrong symbol returns an empty list, not an error

`fileName` is a popup label, not a filename: it is `<displayName>-<date>.zip`, and the real name is
in `fileUrl`. From 2026-08-19 some rows carry `<displayName>-<real basename>` instead.
**Unverified:** whether that carries meaning or is more inconsistency.

**The index is a claim about the archive, not a listing of it**, and it is wrong in both directions:

- **It omits files that exist.** Measured against 1.46 million files fetched from the archive, it is
  complete for candlesticks and misses 0.27% of trades and 1.30% of depth, every one of which the CDN
  serves. Per instrument and dataset its first date is not the archive's: on one sweep, 1,424 series
  had files earlier than the index's first for them, by as much as 680 days, and 41 had files it
  never listed. On the era-boundary candlesticks, of six days it listed under the era-2 key only,
  five have an era-1 file too, serving the same candles — see
  [the three naming eras](#the-three-naming-eras).
- **It leaves instruments out altogether.** 585 series known from the venue's instrument listings
  appear nowhere in it.
- **It lists keys that do not exist.** Two spot kline series on the naming retired 2024-04-18,
  `BLZ/USDT` and `WAVES/USDT`, had 1,113 files listed and none served: every one answers `403`
  from the origin, which serves those symbols' other shapes with `200`. Measured in September 2026.
- **It goes quiet about recent days long before the archive does.** Days it withheld for over a week
  were in the archive all along, at full strength and under the shapes already known. The newest
  date it returns is a lower bound on what exists, never the archive's end. Observed in August 2026.

**The REST APIs — two of them, and they are different systems.** See
[the two REST APIs are two account systems](#the-two-rest-apis-are-two-account-systems).

**The trading platform search.** `POST /v1/mix/index/search/trade/coin` with
`{searchContent, showOpenTime, languageType}`, returning `spot`, `margin` and `contract` buckets.
This is the only place bitget states the correspondence between its own names. It answers about
two requests a second, and it does not list the coin-margined family at all. It returns `symbolCode`
for an instrument that has not yet published a file, so the archive name is known before the first
file lands; for a retired symbol it returns nothing.

Measured by asking it for every name both REST versions list — 1,957 queries, 2,104 distinct records
— and checking each field against the archive paths and REST names held independently:

| field | matches an archive path | matches a REST name |
|---|---|---|
| `symbolCode` | **99.0%** | 96.3% |
| `symbolCodeDisplayName` | 97.6% | **100.0%** |
| `symbolDisplayName` | 34.6% | 37.8% |
| `symbolId` | 0.0% | 0.0% |

So `symbolCode` is the archive name and `symbolCodeDisplayName` is the REST name, with no exception
in 2,104 records for the latter. All 20 records where `symbolCode` matched no archive path are
instruments with **no archive at all** — 17 recent listings, plus the internal codes
`BTCUSD_D1`/`ETHUSD_D1` whose files sit under `BTCUSDU26` and `ETHUSDU26`.

Its `businessLine` is finer than the download form's: `1` spot and margin, `10` USDT-margined perps
(`UMCBL`), `11` coin-margined and delivery (`DMCBL`), `12` USDC-margined (`CMCBL`).

**It covers classic instruments only** — no UTA instrument appears in it at all.

#### Which market an instrument belongs to

The v3 listing states it outright:

| the venue says | instrument |
|---|---|
| category `SPOT`, `symbolType = crypto` | spot |
| a futures category, `type = delivery` | dated future |
| a futures category, any other `type` | perpetual |
| `isRwa = YES` (futures), `isReality = yes` or a `symbolType` other than `crypto` (spot) | not crypto — see [two fifths of what bitget lists is not crypto](#two-fifths-of-what-bitget-lists-is-not-crypto) |

`symbolType` and `type` are present on every instrument of every category, so nothing is decided by a
missing value. `symbolType` alone does not separate crypto from the rest on futures, where some
equities are typed `crypto`.

#### Naming: what can be derived, and what must be looked up

Measured over the distinct (market, portal name, archive path) triples in the index:

| rule | count |
|---|---|
| archive path equals the portal name with the slash removed | 1,813 |
| archive path equals the portal name exactly | 1,420 |
| `USDC` → `PERP` (USDC-margined perps) | 64 |
| `USD_CM` → `CM` (UTA coin-margined) | 21 |
| **no rule** | 881 |

The 881 are relistings, stock wrappers (`APPUSDT` → `APPSTOCKUSDT`), `OLD`/`NEW` infixes between base
and quote (`EDENOLD/USDT` → `EDENUSDT`), and dated expiries.

##### That residue is mostly derivable after all

Asked the other way round — per API category, over the 6,942 instruments whose archive spelling is
known — **99.8% derive and 17 do not**:

| category | rule | share |
|---|---|---|
| `SPOT`, `USDT-FUTURES`, `USDC-FUTURES` | identity | 100% |
| `MARGIN` | identity | 98.6% |
| `futures` | identity | 93.9% |
| `futures` | `USDC` → `PERP` | 3.8% |
| `COIN-FUTURES` | `USD_CM` → `CM` | 64.5%, identity for the rest — the two product lines |
| `spot` (portal names) | strip `/` | 73.1% |
| `spot` (portal names) | strip `/`, uppercase | 24.6% |

Two smaller families cut across categories, about 59 instruments: the **portal** adds a marker the
archive never had — `OLD`, `ERC20`, `SOL` — because the plain path was that holder's all along; or
the **archive** adds one the portal does not, `NEW`, `TOKEN`, `BITCOIN`, `1`.

Two more are visible only in the books tree:

- **the multiplier contracts.** The portal carries it and the archive drops it —
  `1000XECUSDT` → `XECUSDT`, `1000BONKUSDC` → `BONKPERP` (with `USDC` → `PERP` on top).
- **`USD_CM` → `USDCM` for books**, where klines take `USD_CM` → `CM`. `BTCUSD_CM` files its
  klines under `BTCCM` and its books under `BTCUSDCM`: the same instrument, two datasets, two
  spellings.

The 17 that no rule reaches are relistings where the portal describes what the archive merely
tickers — `BOOMUP/USDT` → `BOOMUSDT`, `GDXGOLD/USDT` → `GDXUSDT`, `MAJORPOINTS/USDT` →
`MAJORUSDT`, `SPACEMICROVISION/USDT` → `SPACEUSDT`, `MSTRBEP20/USDT` → `MSTRUSDT` — plus two
unrelated renames, `KAON` → `AKRO` and `SLTC` → `SBCHS`. These must be read from the venue, which
is what the trading platform search is for, since `symbolCode` gives the archive name directly.

##### The index answers with its own label, so read `displayName`

Every row the download index returns carries the `displayName` that produced it, which is the exact
symbol-to-URL mapping a bulk request otherwise loses — asking 2,000 names at once returns one flat
list with nothing saying which name yielded what.

**But it is the venue's label, not always the name asked.** `1000BONKUSDC` comes back for a request
that named something else, dated futures answer with their expiry label (`BTCUSD0926` for
`BTCUSDU25`), and the Reality tokens answer with their lowercase portal form (`rAMCR/USDT` for
`RAMCRUSDT`). So `displayName` identifies the *file*, and the archive directory identifies the
instrument.

**A quarterly's label is a date, and the date is a rule.** Quarterly contracts settle on the last
Friday of their month, so `BTCUSD0327` is the one expiring on 27 March — and only 2026 has its last
Friday on that date, which makes it `BTCUSDH26`. It reads either way.

Where a pairing is not obvious, **a request naming one symbol settles it**: it is categorical about
what that instrument has.

##### A path names whoever held the ticker when the file was written

Bitget reuses tickers and a path cannot be renamed after the fact, so the plain spelling belongs to
the *first* holder and every later one gets a fresh path:

```
spot, ticker "AI"
  AIUSDT          2023-02-07 .. 2023-11-23     the first holder
  $AIUSDT         2024-01-04 .. 2026-04-30     the second
  AIGENSYNUSDT    2026-04-29 .. open           the third, and what the API calls AIUSDT today
```

Handovers are exact rather than overlapping, so these are separate histories with adjacent ranges.

**So a live API symbol does not give the archive path.** Ask the CDN for today's `AI` at
`kline/AIUSDT/…` and it answers — with a different project's 2023 candles.

The disambiguated spelling is not derivable either, and the portal's own labels for retired holders
are inconsistent between markets: the futures listing calls the first `AI` `AISLEEPLESSUSDT` while
the spot listing calls it `AIOLD/USDT`.

**Distinguishing a rename from a spelling.** When a lookup for symbol `A` yields a URL under symbol
`B`, there are two possibilities:

| | meaning |
|---|---|
| `B` is itself a bitget symbol | renamed, or the ticker was reused: two instruments, adjacent ranges |
| `B` was never a symbol | `B` is how the archive spells `A`: one instrument |

The trading platform search settles it — if `symbolCode(A) = B` then `B` is a spelling; if `A` and
`B` each appear as their own record, they are two instruments.

##### Depth can be spelled differently from the rest of an instrument

Asking the download index for every spot instrument under its *slashless* name — rather than the
dropdown spelling the form accepts — turned up ten instruments whose depth is filed under the bare
name while their candlesticks, trades and quotes use another spelling:

| name | spelling of its other datasets | depth under that spelling | depth under the name |
|---|---|---|---|
| LIQUIDIUMUSDT | LIQUIDIUMTOKENUSDT | 2024-07-22..2025-01-27 | 2024-07-27..2026-08-17 |
| MRSOONUSDT | SOONUSDT | 2024-07-27..2026-08-31 | 2025-04-25..2026-08-14 |
| VELOUSDC | VELO1USDC | 2024-07-09..2024-09-06 | 2024-08-23..2026-08-17 |
| KAONUSDT | AKROUSDT | 2024-07-09..2025-02-13 | 2025-02-12..2026-06-24 |
| TXUSDT | COREUMUSDT | 2024-07-09..2026-03-05 | 2026-03-06..2026-08-21 |
| CATEUSDT | CATENEWUSDT | none | 2024-07-27..2026-08-17 |
| RBTCUSDT | RBTCNEWUSDT | none | 2024-09-23..2025-10-20 |
| RUNESXUSDT | RUNESXBITCOINUSDT | none | 2024-10-12..2025-07-08 |
| SOPHUSDC | SOPHNEWUSDC | none | 2025-05-28..2026-08-17 |
| SPACEUSD1 | SPACENEWUSD1 | none | 2026-01-23..2026-08-17 |

For seven of them that is the ordinary case — one stream, handed over at a rename or spelled one way
for its whole life. **The first three overlap**, by two weeks (`VELOUSDC`) to more than a year
(`MRSOONUSDT`): for that period bitget wrote two depth streams for one listed instrument.

##### An instrument is a market plus a symbol, and a path belongs to nobody

A symbol is unique **per market**, never globally. `BTCUSD` may exist as spot, as a perpetual and as
a dated future at the same time, and those are three instruments.

**A path, by contrast, is owned by nobody.** Bitget reassigns directories and filenames: it re-issues
a ticker, shortens a name into one that collides with a different instrument, moves a stream from one
folder to another, and files an instrument under a name it dropped years ago. So the same archive
spelling can carry one holder's files up to some date and another's from the next day on.

It follows that **one archive spelling can hold more than one instrument's files**. The worked
example:

```
futures  AISLEEPLESSUSDT -> AIUSDT          the first holder, under the plain name
futures  AIUSDT          -> AIGENSYNUSDT    what the API calls AI today
futures  AIUSDT          -> AIUSDT          the plain name again, on a later shape
```

All three are right. They sit on different datasets and different eras, so they name different
keys; and where they do share a shape, they cover different date ranges.

##### Two keys name one instrument inside another's directory

```
kline/TRXUSDT/TRXETH_SP_1min_20220508.zip
kline/TRXUSDT/RUNEUSDT_UMCBL_1min_20221117.zip
```

Both are served. In era-1 naming the symbol appears twice — directory and filename — and in these two
keys they disagree. They are the only two era-1 keys like this in 5,055,779 paths; the books have
their own case, [374 keys on four dates](#depth-is-two-datasets-and-one-of-them-is-invisible-without-a-parameter).

No single-symbol shape reads them. `RUNEUSDT`'s day exists only at this key; `TRXETH`'s has a
byte-identical copy at its proper key.

#### What the download form does not know

The dropdown enumeration is the only listing that remembers delisted instruments, and it is still
incomplete in two measured ways.

**Non-ASCII names are unreachable.** `龙虾USDT` is a real USDT-FUTURES instrument with 166 days of
klines and trades, filed under `LOBSTERUSDT`. The form returns it when asked for `龙` or `虾`, but a
crawl over `a–z0–9$/_` cannot construct a query that matches it: its only ASCII substrings are `u`,
`us`, `usd`, `usdt`, and the last two match nearly everything and are skipped. `牛来USDT` is the
other. Both are in the REST listing, which is how they were found.

**The line token is the market**, and it is a property of the key: `/1/`, `SP` and `SPBL` are spot,
the margin tokens and `/2/` are futures. It is fixed when the file is written and cannot be revised
afterwards.

**A name asked of the wrong line still answers.** Asking the spot line about a futures name returns
spot-line depth keys for it, and they are served: in September 2026 one name list sent to both lines
came back with hundreds of thousands of such keys.

Those files are also not a copy of the futures ones. Measured on matched timestamps, prices differ by
a consistent 0.4–0.5 and the `/1/` file carries two rows per timestamp with different books, so
whatever the venue is filing there, it is not the `/2/` stream under another name.

### File formats

#### Buckets cut at 16:00 UTC, not midnight

A file named `20250101` covers **2024-12-31 16:00 → 2025-01-01 16:00 UTC** — midnight in UTC+8.
Verified across 120 files spanning all 514 spot symbols and the whole range: zero rows
outside the shifted window. Timestamps themselves are correct UTC instants; only *which file holds a
row* is shifted.

**Unverified:** only spot trades were checked. Futures products and the kline/depth datasets deserve
their own check.

#### Trade timestamps carry only second resolution

The `timestamp` column is epoch milliseconds with the millisecond part **always zero**. Measured over
133,260 rows across 32 consecutive `SNXUSDT` files: zero exceptions. Confirmed over the ~9.6 M
`BTCUSDT` spot trades of 2024-06: every timestamp falls on a whole second.

So `timestamp` cannot order trades within a second; sequence lives in `trade_id` and file order.
Sub-second bins are not derivable from this source.

#### Multi-part days are independent zips

A busy day splits as `20250117_001.zip`, `_002.zip`, and so on. Each opens standalone with its own
end-of-central-directory record and one CSV **with its own header row** — not a spanned archive.

**The rule is 100,000 rows, not a size.** Parts are sequential and do not overlap. Nothing in a path
says how many parts a day has, so the only way to learn is that the next answers 403. Parts reach
`_101`; 98% of day-series are `_001` alone.

A part's compressed size does not say whether it is the last: it varies with symbol, precision and
era, and full parts (215,212 bytes upward) overlap terminal ones (median 135,981).

#### Sentinel value in depth

Depth publishes a missing quote as **`-999999`**, not an empty field: the value means no quote, not a
price.

#### A day's klines and depth are a sheet, a month's are text

The `.zip` of a day holds an Excel file (`20260910.xlsx`, or `<name>.xlsx` in the older naming); the
`.zip` of a month, under `kline_month/` and `depth_month/`, holds a CSV named after the file
(`ETHUSDT_SP_1min_202609.csv`, `ETHUSDT_3_202603.csv`). The columns and their names are the same:

```
klines  timestamp, open, high, low, close, basevolume, usdtvolume
depth   timestamp, ask_price, bid_price, ask_volume, bid_volume
```

`timestamp` is in whole seconds in both, and the rows of a depth file are not in time order. Trades
are CSV at either grain, `trade_id, timestamp, price, side, volume(quote), size(base)`, with
`timestamp` in milliseconds. Seen on spot, USDT futures and delivery contracts, 2025-08 to 2026-09.

**Depth sizes follow the product line.** They are in the base coin (`BTCUSDT`: 14.4588;
`BTCUSDU24`: 0.082), and in whole contracts on the coin-margined line filed under `…CM…`
(`BTCCMZ26`, 2026-09-10: every one of 3,658 rows a whole number, median 10,417) — see
[the two product lines](#coin-margined-futures-are-two-live-product-lines).

### Coverage

#### Per-dataset floors

| market | dataset | first file |
|---|---|---|
| spot | kline | 2018-07-25 |
| spot | trades | 2018-07-25 |
| spot | depth | 2024-07-09 |
| perp | kline | 2019-04-23 |
| perp | trades | 2021-05-18 |
| perp | depth | 2024-07-09 |

Established rather than assumed: the index was asked in 8-day windows from 2018-01-01, and all 25
windows before 2018-07-20 return nothing in all six market/dataset groups. The portal datepicker
enables dates from 2018-01-02, which is a UI constant with nothing behind it.

Availability is patchy in the early years and must be read, not assumed: for `BTC/USDT` spot trades,
2018-07-25 present, 2018-07-26 absent, 2019-06-01 absent, 2021-01-01 onward present.

### Publication

Day `D` appears at `D+2`, around 03:00 UTC. Measured from the archive's own `Last-Modified` over
28,992 files of 2026-09-15 to 2026-09-21, a file appears **51.0 hours (p50) after 00:00 UTC of the
day it is named for**, 52.9 at p99 and 53.0 at worst: the whole distribution sits inside two hours.
Across eight consecutive days of `BTCUSDT` spot klines, trades and depth, each day landed at `D+2`
03:00 UTC to the minute. So the newest day the archive holds is two days behind.

The cadence slips: on 2026-08-21 the file for the 18th was still absent, 21 hours past due.

## REST

**How to read this section.** A statement with no mark is what the API answered when it was asked,
in October 2026. *(documented)* marks what bitget's documentation states and was not tried.
*(not known)* marks what neither settled. Nothing here is inferred from another venue.

**Where the documentation is.** The site at `www.bitget.com/docs` is rendered by a script and serves
one page at every address to anything that does not run it. Its content is an OpenAPI document for
each group of endpoints, bundled as a script: `/docs-static/assets/docs-catalog-<group>-<name>.en.json-<hash>.js`,
the names being in `/docs-static/assets/entry.client-<hash>.js`. The groups that matter here are
`classic-contract-market`, `classic-spot-market`, `classic-common-apidata` and `market` (v3).

### The API

**One host, `https://api.bitget.com`, behind Cloudflare, serving two generations at once.** From
the machine that asked, the edge was MAD, with the API 259 ms behind it.

| generation | base | markets by |
|---|---|---|
| v2 | `/api/v2/spot/market/*`, `/api/v2/mix/market/*` | `productType`: `USDT-FUTURES`, `COIN-FUTURES`, `USDC-FUTURES` |
| v3 | `/api/v3/market/*` | `category`: `SPOT`, `USDT-FUTURES`, `COIN-FUTURES`, `USDC-FUTURES` |

- **Mark and index history are v2's alone**: on v3's `history-candles`, `type=MARK` returns the
  trade bars.
- **Times are milliseconds**, strings in answers.
- **Every answer is `{code, msg, requestTime, data}`**; `"00000"` is success.
- **A bad request is HTTP 400** with a code. Seen: `40053` (`limit` out of range), `40020`
  (parameter `limit`), `40808` (`pageNo` beyond 100), `40934` (`startTime` earlier than 90 days),
  `40309` (the symbol has been removed).

### Its limits

- **A budget for each endpoint, per second, by address.** The header `x-mbx-used-remain-limit` is
  what is left of the current second.
- **What the header starts at**, after one call: 19 on `candles`, `fills-history` (futures),
  `history-fund-rate`, `history-mark-candles`, `history-index-candles`, `open-interest`, the v3
  endpoints; 9 on spot's `fills-history`; **4 on `history-candles`**, futures and spot; 0 on
  `long-short`, `account-long-short`, `position-long-short`, `taker-buy-sell`.
- **The documentation states each endpoint's**: "20 times/1s (IP)" for most market endpoints, 10
  for trade history, 1 for the ratio endpoints, 5 for v3's liquidations.
- **`history-candles` is 5 a second, not the 20 stated**: the header starts at 4, and the sixth
  call inside a second is refused. At 4 a second, 40 calls passed.
- **Beyond it**: HTTP 429, `{"code":"429","msg":"Too Many Requests","requestTime":…,"data":null}`,
  with no header. The next second answers.
- **An endpoint's budget is its own**: with mark bars refused after 20 calls, index bars and
  `history-candles` answered at once.

### How it is paged

- **Bars, backward by `endTime`**: the `limit` bars up to it, oldest first within the page; the
  next `endTime` is the oldest time received.
- **`startTime` alone** returns the last `limit` bars of a window beginning there — for a start of
  2021-01-01, bars of 2021-03-31.
- **Funding by page**: `pageNo` (≤ 100) and `pageSize` (≤ 100; 101 returns 100) on v2; `cursor` and
  `limit` (≤ 100; 200 is refused) on v3, where `cursor` behaves as a page number.
- **A `limit` over the maximum is refused** on `history-candles` (`40053`).

### Endpoints that serve the past

**Bars — `GET /api/v2/mix/market/history-candles`, `GET /api/v2/spot/market/history-candles`**
- **Ask**: `symbol`, `productType` (futures), `granularity` (`1m 5m 15m 30m 1H 4H 1D 1W 1M` on
  futures; `1min … 1week` on spot), `startTime`, `endTime`, `limit` ≤ 200.
- **Answer**: futures `[ts, open, high, low, close, baseVolume, quoteVolume]`; spot
  `[ts, open, high, low, close, baseVolume, usdtVolume, quoteVolume]`.
- **Reaches the first trade**: futures BTCUSDT's first week is 2020-06-07, and its `1m` bars of
  2020-12 answer; spot BTCUSDT's first week is 2018-07-22, and its `1min` bars of 2019-06 answer.
- **Budget**: 5 a second.

**Mark and index bars — `GET /api/v2/mix/market/history-mark-candles`, `history-index-candles`**
- **Ask**: as futures bars; `limit` ≤ 200.
- **Answer**: `[ts, open, high, low, close, "0", "0"]`.
- **Reach the contract's first month**: BTCUSDT's mark bars start 2019-07, and `1m` bars of 2020-12
  answer for both. Of 820 listed USDT contracts, 811 have mark history.
- **Budget**: 20 a second.

### Endpoints that hold only the newest

- **Funding — `GET /api/v2/mix/market/history-fund-rate`**, and v3's `history-fund-rate`:
  `{symbol, fundingRate, fundingTime}`. **Only the last 270 records** — pages 1 to 3 of 100; every
  later page is empty. At 8 hours that is 90 days.
- **Trades — `GET /api/v2/mix/market/fills-history`, `/api/v2/spot/market/fills-history`**:
  `symbol`, `startTime`, `endTime` — 7 days apart at most *(documented)* — `limit` ≤ 1,000;
  `{tradeId, price, size, side, ts, symbol}`. **90 days**: older is `40934`. `fills` is the newest
  100.
- **Ratios — `GET /api/v2/mix/market/long-short`, `account-long-short`, `position-long-short`,
  `taker-buy-sell`**: `symbol`, `period`; 30 points — `{longRatio, shortRatio, longShortRatio, ts}`
  and the like; 1 call a second.
- **Risk reserve — `GET /api/v3/market/risk-reserve`, `risk-reserve-hour`**: 30 daily and 30 hourly
  `{ts, amount, balance}`.
- **Open interest — `GET /api/v2/mix/market/open-interest`, `/api/v3/market/open-interest`**: the
  value now.
- **`GET /api/v2/mix/market/candles`**: 1,000 a page; `kLineType` gives `market`, `mark` or `index`
  bars. **Recent bars only**: at `1m`, 20 days back answers and 40 does not. One month for `1m`,
  `3m` and `5m`, 52 days for `15m`, 62 for `30m`, 83 for `1H`, 240 for `4H`, 360 for `6H`
  *(documented)*.
- **Liquidations — `GET /api/v3/market/liquidations`**: `category`, `symbol` (optional), `limit` ≤
  100, `cursor`; `data.list[]` of `{symbol, side, price, amount, ts}`. The last 3 days
  *(documented)*.
- **Interest rate — `GET /api/v2/mix/market/union-interest-rate-history?coin=USDT`**:
  `data.historyInterestRateList[]` of `{ts, annualInterestRate, dailyInterestRate}`, 720 of them,
  one an hour: 30 days.
- **Announcements — `GET /api/v2/public/annoucements`**: `annType`, `language`; ten of the last
  month *(documented)*.
- **Margin and spot flows** — `margin/market/long-short-ratio`, `loan-growth`,
  `isolated-borrow-rate`, `spot/market/whale-net-flow`, `fund-flow`: 30 points or fewer.
- **`/api/v3/market/index-components`**: an index's exchanges and weights now.

### The listings

- `GET /api/v2/mix/market/contracts?productType=`: `{symbol, symbolStatus, fundInterval, launchTime,
  offTime, deliveryTime, …}`. `launchTime` was empty on every contract; listed contracts only.
- **A delisted contract does not exist**: bars and mark bars answer `40309` "The symbol has been
  removed".
- **What the USDT futures listing held in 2026-10**: 820 contracts, with no launch date. Their first
  months of bars, asked one contract at a time: 811 with history, the earliest 2019-07, and 441,518
  instrument-days — 2023: 41k · 2024: 68k · 2025: 128k · 2026: 172k.

#### The two REST APIs are two account systems

v3 is the **UTA** (Unified Trading Account) API; v2 is the classic one. They are not versions of one
listing, and neither contains the other.

```
v2  /api/v2/spot/public/symbols                              1,306 spot
    /api/v2/margin/currencies                                  589 margin
    /api/v2/mix/market/contracts?productType=USDT-FUTURES      776 perpetual
    /api/v2/mix/market/contracts?productType=COIN-FUTURES       11 = 9 perpetual + 2 delivery
    /api/v2/mix/market/contracts?productType=USDC-FUTURES       49 perpetual
    /api/v2/mix/market/contracts?productType=SUSDT-FUTURES       3 demo
    /api/v2/mix/market/contracts?productType=SCOIN-FUTURES       4 = 2 demo + 2 demo delivery
    /api/v2/mix/market/contracts?productType=SUSDC-FUTURES       2 demo

v3  /api/v3/market/instruments?category=SPOT                 1,306
    /api/v3/market/instruments?category=MARGIN                 326
    /api/v3/market/instruments?category=USDT-FUTURES           776
    /api/v3/market/instruments?category=USDC-FUTURES            49
    /api/v3/market/instruments?category=COIN-FUTURES            20
```

`productType` is required on the v2 mix endpoint; without it, `400172 Parameter verification failed`.
v3 accepts only those five category values; anything else returns `40034`.

Where both list the same market they agree name for name — SPOT, USDT-FUTURES and USDC-FUTURES are
identical sets. Two places they do not:

- **MARGIN**: v2 has 589, v3 has 326, and v3's are a strict subset. (`tickers?category=MARGIN` on v3
  returns the whole 1,306 spot list instead, so the two v3 endpoints do not agree with each other
  either.)
- **COIN-FUTURES**: **zero overlap, because these are two product lines rather than two spellings.**
  v2's is `BTCUSD`, v3's is `BTCUSD_CM`, and they publish under different keys — see *Coin-margined
  futures are two live product lines* below. Reconciling them by dropping `_CM` would splice a line
  that began in 2026 onto one running since 2019.

**`symbolType` means different things in the two.** v2 uses it for contract style — `perpetual` or
`delivery`. v3 uses it for asset class — `crypto`, `stock`, `metal` — and carries contract style in
`type` instead. So the field that separates a perp from a dated contract is only meaningful in v2.

##### Delivery contracts, and how each API names its own

Both account systems run them, and each names only its own. v2 has `BTCUSDU26` and `ETHUSDU26` under
`COIN-FUTURES` plus `SBTCSUSDU26`/`SETHSUSDU26` under `SCOIN-FUTURES`; v3 has `BTCCMZ26` and
`ETHCMZ26`, following the UTA key shape. They carry `symbolType: delivery` in v2 and `type: delivery`
in v3, with `deliveryPeriod: this_quarter` and explicit `deliveryStartTime`/`deliveryTime` —
`BTCUSDU26` runs 2026-03-27 to 2026-09-25, beginning exactly where the previous quarter's `BTCUSDH26`
delivered.

The naming is the standard futures month code: `H` March, `M` June, `U` September, `Z` December, plus
a two-digit year. The download form labels them by expiry date instead (`BTCUSD0925`), and that label
is **wrong by a day or two** against the actual delivery date, and changes as the series rolls.

The archive files each under the name its own account system uses: `BTCUSDU26` for the classic line,
`APTCMU26` for UTA's.

**The flag is what identifies these, not the category and not the name.** Each API lists only its
own contracts, so one API alone shows part of the delivery universe; and an **expired** contract
appears in no listing at all, so its name is then the only thing left to read: the month code, or
bitget's `_D1`/`_D2`.

##### Demo instruments are published too

The `S`-prefixed product types (`SUSDT-`, `SCOIN-`, `SUSDC-FUTURES`) are bitget's simulated trading
instruments, and the archive carries them: `SBTCSUSDT` has 4,323 files across three datasets from
2019-07-22, `SETHSUSDT` 2,439, `SXRPSUSDT` 1,508.

They are identifiable by product type, **not** by the `S` prefix — `SANTOSUSDT`, `SYSUSDT`,
`SATSUSDT` and `SAROSUSDT` are real tokens whose names begin with S.

##### Coin-margined futures are two live product lines

`BTCUSD` (v2) and `BTCUSD_CM` (v3) are not one instrument named twice. The API fields differ in kind:

| | v3 `BTCUSD_CM` | v2 `BTCUSD` |
|---|---|---|
| minimum order | `1`, precision `0` | `0.0001`, `volumePlace 4` |
| size multiplier | `quantityMultiplier 1` | `sizeMultiplier 0.0001` |
| margin collateral | not exposed | `["BTC","STETH","XRP","ETH","USDE","USDC","BGB"]` |

v3's is quoted in whole contracts (an inverse contract); v2's is sized in the base coin with
multi-asset collateral. The archive keeps them apart too: `BTCUSD` files under `BTCUSD`,
`BTCUSD_CM` under `BTCCM`.

**Timing supports the UTA reading.** `BTCUSD_CM` carries `launchTime` 2026-01-21 12:09 UTC and
`BTCCM`'s first archive file is 2026-01-22, with the rest rolling out in waves — `DOGECM`/`ETHCM`/
`SOLCM` 01-29, `LINKCM`/`XRPCM` 02-05, `ADACM`/`AVAXCM` 03-12, `NEARCM` 03-18. That is a staged
product launch, not a rename.

**On 2026-08-17 eleven of the twenty classic streams stopped**, exactly at the era-3 boundary, and
their `CM` counterparts continue. The nine still in v2 publish under both names concurrently. The
correlation is perfect across all twenty: in v2 ⟺ the `XUSD` stream still publishes.

**The `CM` line publishes klines only.** `kline/AAVECM/UMCBL/…` answers 200 for current dates while
`depth/AAVECM/2/…` and `trades/DMCBL/AAVECM/…` answer 403. So those eleven instruments lost trades
and depth entirely in the move — under either name.

**Assumption:** that `XUSD` and `XCM` are the classic and UTA views of one economic instrument. The
sizing and collateral differences are measured; the interpretation is not. Their files are separate
keys either way.

##### Two fifths of what bitget lists is not crypto

From v3's `symbolType`: **700 stock, 604 crypto, 2 metal** in SPOT alone, with 698 flagged
`isReality: yes`. These are Bitget's tokenised US equities ("Reality"), displayed with a lowercase
`r` prefix — `rAAPL`, `rPBR` — and two `pre` ones, `preOPAI` and `preSPCX`.

**Assumption:** that `pre` denotes pre-IPO exposure. The names fit (OpenAI, SpaceX) and neither
carries `isReality`, but bitget's docs do not say so.

The lowercase appears **only in the portal display name**. Symbols and archive paths are uppercase
throughout.

Asset class cuts across bitget's own categories: `TSLAUSDT` is a USDT-FUTURES perpetual, and the
futures listings carry `isRwa` for the same purpose that `isReality` serves on spot. Together they
cover roughly 1,500 instruments: tokenised equities and ETFs on spot (`rTSLA/USDT`, `rARKK/USDT`),
equity perpetuals on futures (`AAPLUSDT`, `ASMLUSDT`, `ANTHROPICUSDT`), and a handful of metals,
commodities and currency pairs.

**`isRwa`/`isReality` are the flags to read, not `symbolType`.** `KUAISHOUUSDT` and `HPQUSDT` are
equities carrying `symbolType: crypto`, so the type field is unreliable for the crypto/RWA question.
Measured over 2,941 listed instruments, `symbolType = 'stock'` alone misses 2 spot metals, 7 futures
metals, 3 futures commodities and 11 futures contracts typed `crypto` but flagged `isRwa: YES`
(`HPQ`, `BHP`, `RIO`, `VALE`, `EURUSD`, `USDJPY` and the like). `symbolType` is worth reading only
for `stock`, which catches the pre-IPO names the reality flag does not cover.

**A delisted equity is recognisable only on the spot side.** Once an instrument leaves the listings,
no flag speaks for it, and the name is all that remains. On spot that is enough: bitget prefixes
Reality tokens with a lowercase `r`, and only them. A delisted stock perpetual is named like a crypto
one, `AAPLUSDT`.

**Spot equities publish almost nothing.** Of the ~700, exactly one appears among the indexed files.
Futures equities are published normally.

### Against bitget's own archive

Set side by side in 2026-10:

| over REST | in the archive |
|---|---|
| trade bars, futures from 2020-06 and spot from 2018-07 | 1-minute bars |
| trades, 90 days | every trade |
| mark and index bars, from 2019-07 | none |
| funding, 90 days; ratios; liquidations; risk reserve; open interest | none |

### Its documentation

Where it is, and how it is read, is at the head of this section. It states a limit for every
endpoint and little about how far back each reaches. **Where the API differs from it**:
`history-candles` is stated at 20 calls a second and takes 5.

### Pace, measured

979 calls in 2026-10, from one machine, with no failure but the refusals provoked on purpose. One
connection did 3.5 pages a second, p50 275 ms. At 200 bars a page, a day of one contract's
1-minute bars is 8 calls.

## Open questions

- Why 809 depth streams stop on 2026-08-17, the last day of era 2, with nothing taking over — probing
  every filename digit on later dates answers `403` for all of them.
- What the two rows per timestamp in a depth file are.
- Which depth stream is the instrument's while two are written: LIQUIDIUMUSDT, MRSOONUSDT and
  VELOUSDC each have depth under two spellings for an overlapping period.
- Whether the era-3 `fileName` variant (`<displayName>-<real basename>`) means anything.
- Whether the bucket cut holds for futures products and for klines and depth.
- Whether `pre`-prefixed equities are pre-IPO instruments.
- Whether `XUSD` and `XCM` are one economic instrument under two account systems.
- **Where the REST API's servers are.** Only the delay behind its edge is known.
