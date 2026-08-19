# Bitget

What bitget's published archives contain, and how its several catalogues name the same instrument.
Everything here is measured against the venue unless marked **Unverified** or **Assumption**.

## The archive

Files sit under `https://img.bitgetimg.com/online/`, always `.zip`, never with a query string. The
first path segment is the dataset — `kline`, `trades` or `depth` — and the date appears exactly once,
in the last segment, never in a directory.

### A missing key answers 403, and that is the venue's defining fact

The bucket grants `GetObject` and not `ListBucket`, so S3 answers an object it never held exactly as
it answers one it refuses:

```
HTTP/2 403
server: AmazonS3
<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>
```

By status alone that is indistinguishable from being turned away. Reading it as a block stands the
venue down on its first missing file — which, for an archive whose keys are constructed and whose
ranges have real gaps, is immediately and permanently.

**Who answered separates them.** S3 replying is a statement about the object; the CDN replying under
its own `server` never reached the origin and is a statement about us. That is the only distinction
available on a `HEAD`, and prospector's `refusesUs` and `ruleOnFailure` hooks rest on it.

No other venue here behaves this way — okx and bybit's book server both answer a missing key 404.

### It answers fast and has never refused

Sustained closed-loop `HEAD` load against keys known to exist: **597,000 requests in one afternoon,
not a single non-200**.

```
 workers       rate        n     p50      p95   our CPU
      40     977.2/s    29318     37ms      51ms     4.3%
      80    2005.1/s    60177     37ms      47ms     8.5%
     400    3506.5/s   140325     55ms     313ms    27.8%
```

Throughput collapses past a few hundred workers — 3,200 gave 320/s at a p95 of 22 seconds — but that
is **this machine's CPU**, not the venue: at 400 lanes it sat at 28% of eight cores while going six
times faster. Reading that plateau as venue pushback is how a client-side limit becomes a venue
"fact". Every 403 bitget has ever sent came from S3 saying a key is absent.

So the adapter declares `perSecond: 10_000` — not a measured limit but the absence of one — and
`concurrency` is what actually decides throughput. If a run struggles, that is the number to lower.

**The web endpoints are the opposite.** Everything on `www.bitget.com` is rate limited and sits
behind Cloudflare: roughly one request a second sustained, 429 above that, and a challenge page
instead of JSON without a browser `User-Agent` and a `cf_clearance` cookie. A client that treats a
challenge or a 429 as "no results" records silence as fact.

### Files land two days late, at 03:00 UTC

Day `D` is published at `D+2` 03:00 UTC to the minute, measured across eight consecutive days of
`BTCUSDT` spot klines and the same for trades and depth. So the newest day the archive can hold is
always two behind. The cadence slips: on 2026-08-21 the 18th was still absent, 21 hours past due.

### Buckets cut at 16:00 UTC, not midnight

A file named `20250101` covers **2024-12-31 16:00 → 2025-01-01 16:00 UTC** — midnight in UTC+8.
Verified across 120 files spanning all 514 spot symbols and the whole range on disk: zero rows
outside the shifted window. Timestamps themselves are correct UTC instants; only *which file holds a
row* is shifted. Stocker handles it with the declarative `spill: 'back'` trait.

**Unverified:** only spot trades were checked. Futures products and the kline/depth datasets deserve
their own check.

### Trade timestamps carry only second resolution

The `timestamp` column is epoch milliseconds with the millisecond part **always zero**. Measured over
133,260 rows across 32 consecutive `SNXUSDT` files: zero exceptions. Confirmed on a built partition —
of ~9.6 M rows in `BTCUSDT` 2024-06, `count(DISTINCT ts % 1000000)` is 1.

So `ts` cannot order trades within a second; sequence lives in `trade_id` and file order. Sub-second
bins are not derivable from this source, where binance and bybit publish finer stamps.

### Multi-part days are independent zips

A busy day splits as `20250117_001.zip`, `_002.zip`, and so on. Each opens standalone with its own
end-of-central-directory record and one CSV **with its own header row** — not a spanned archive.

**The rule is 100,000 rows, not a size.** Parts are sequential and do not overlap. Nothing in a path
says how many parts a day has, so the only way to learn is that the next answers 403. Parts reach
`_101`; 98% of day-series are `_001` alone.

A size short-circuit was considered and rejected: compressed size varies with symbol, precision and
era, and the full and terminal distributions overlap. Stopping on a small part would save one `HEAD`
per day-series and cost a silently truncated day whenever the bet was wrong.

### Sentinel value in depth

Depth publishes a missing quote as **`-999999`**, not an empty field. It must become NULL or every
spread computed from this venue is wrong. Handled in the series map.

### Depth is two datasets, and one of them is invisible without a parameter

`deptType: 2` on the download index returns a different tree from the one every earlier sweep saw:

```
quotes  depth/BTCUSDT/1/BTCUSDT_1_20260901.zip
books   depth_500/BTCUSDT/1/BTCUSDT_1_20260901.zip
```

A level-1 depth file is quotes; `depth_500` is a real 500-level book. The two are separate
datasets with separate keys, and nothing that omits `deptType` will ever see the second.

**Books carry one shape and no eras.** Measured over 794 windows across both business lines, the
whole range, with no window failing: 324,979 files under `depth_500/{S}/1/{S}_1_{DATE}.zip` for
1,704 spot-line symbols, and 262,808 under `depth_500/{S}/2/{S}_3_{DATE}.zip` for 1,099 on the
futures line. Both begin **2025-08-01** and neither has a second spelling — so this dataset launched
on the convention the others only adopted at the 2026-08-18 boundary, and an era-3-shaped books key
before that boundary is not evidence of anything.

The perp quirk holds here too: the directory says `2` where the filename says `3`.

**374 keys name one instrument in another's directory**, on exactly four dates — 2026-07-01, and
2026-09-03 through 05, the last three carrying 105 each. Both sides run alphabetically in step
(`ADAPERP` → `ALPINEUSDT`, `ALGOUSDT` → `AMDONUSDT`), which is the venue zipping two sorted
lists with an offset rather than a naming convention. Every one is served, 200. No pattern generates
them and neither name can be trusted for them, so they belong with the unreadables.

## The three naming eras

The same series is published under different shapes over time. Both boundaries are exact and apply
across the archive, not per symbol.

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

**Klines do not cut cleanly at all.** Around 440 era-2 candlestick keys carry dates before that era
began — 14 instruments, sparsely, from 2019-08-01 to 2023-02-21, `BTCUSDT` and `XRPUSDT` spot among
them. Probed and present.

This is the same arrangement as the trades overlap above, not an exception to it: a day served under
both era's names, holding one export twice. Unzipping era-1 and era-2 pairs gives the same candles —
same count, same timestamps, same values — differing only in float serialisation
(`759.7551999999999` against `759.7552`), exactly as the trades day differs only in its container.

The difference is what the index says about it. For those days it lists the era-2 key and not the
era-1 one, though five of six checked exist; for the trades day it does the reverse and attributes it
to the old name. So the boundary is a change of shape, not of content, and which shape the index
volunteers is not a statement about which files are there. See *The index under-reports, measured*.

### Every shape, and the token rules

Twenty-six shapes cover the archive, counting the monthly trees. **Every one of 5,055,779 indexed URLs matches exactly one of
them, with no ambiguity and nothing unmatched** — measured by anchoring each shape as a regular
expression and testing every URL against the shapes of its own market and dataset.

`{TOKEN}` is `UMCBL`, `CMCBL` or `DMCBL` and appears **only in perp trades**. Which token a file
takes depends on the *series*, not only the market:

| series | token |
|---|---|
| spot trades | `SPBL` |
| spot klines | `SP` |
| futures trades | `UMCBL` USDT-margined, `DMCBL` coin-margined, `CMCBL` USDC-margined |
| futures klines | **`UMCBL` for every margin type**, coin-margined included |
| depth | market digit — `1` spot, `2` futures |

That last row is why coin-margined klines once read as publishing nothing: `kline/BTCUSD/DMCBL/…`
answers 403 while `kline/BTCUSD/UMCBL/…` answers 200. Every probe missed by one path segment.

**The symbol placeholder never contains an underscore** — 0 of 5,055,779 URLs. That makes the
placeholder `[^/_]+` rather than `[^/]+`, which is what stops era-1 and era-3 trade shapes matching
the same URL (`{S}_{DATE}_001` would otherwise swallow the `_SPBL` of `{S}_SPBL_{DATE}_001`).

### Per-dataset floors

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

## Bitget names one instrument four different ways

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

### The four endpoints

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

**The REST APIs — two of them, and they are different systems.** See below.

**The trading platform search.** `POST /v1/mix/index/search/trade/coin` with
`{searchContent, showOpenTime, languageType}`, returning `spot`, `margin` and `contract` buckets.
This is the only place bitget states the correspondence between its own names.

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

## Which market an instrument belongs to

Three canonical markets, from fields the venue states outright:

| the venue says | market |
|---|---|
| spot, `symbolType = crypto` | `spot` |
| futures, `type = delivery` | `future` |
| futures, anything else | `perp` |
| **anything not crypto** | **refused** — see [what this catalog refuses](#what-this-catalog-refuses-bitgets-non-crypto-listings) |

Both fields are present on every instrument of every category, so nothing is decided by a missing
value.

## The two REST APIs are two account systems

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

### Delivery contracts, and how each API names its own

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

**The flag is what identifies these, not the category and not the name.** Since each API names only
its own contracts, a discovery pass reading one alone sees part of the delivery universe — and since
an **expired** contract appears in no listing at all, its own name is then the only thing left to
read: the month code, or bitget's `_D1`/`_D2`.

### Demo instruments are published too

The `S`-prefixed product types (`SUSDT-`, `SCOIN-`, `SUSDC-FUTURES`) are bitget's simulated trading
instruments, and the archive carries them: `SBTCSUSDT` has 4,323 files across three datasets from
2019-07-22, `SETHSUSDT` 2,439, `SXRPSUSDT` 1,508.

They are identifiable by product type, **not** by the `S` prefix — `SANTOSUSDT`, `SYSUSDT`,
`SATSUSDT` and `SAROSUSDT` are real tokens whose names begin with S.

### Coin-margined futures are two live product lines

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
sizing and collateral differences are measured; the interpretation is not. It does not matter for
generating URLs — they are separate series either way — but it would matter for presenting one
history.

### Two fifths of what bitget lists is not crypto

From v3's `symbolType`: **700 stock, 604 crypto, 2 metal** in SPOT alone, with 698 flagged
`isReality: yes`. These are Bitget's tokenised US equities ("Reality"), displayed with a lowercase
`r` prefix — `rAAPL`, `rPBR` — and two `pre` ones, `preOPAI` and `preSPCX`.

**Assumption:** that `pre` denotes pre-IPO exposure. The names fit (OpenAI, SpaceX) and neither
carries `isReality`, but bitget's docs do not say so.

The lowercase appears **only in the portal display name**. Symbols and archive paths are uppercase
throughout, so a canonical name derived from either is uppercase without needing a rule.

Asset class cuts across bitget's own categories: `TSLAUSDT` is a USDT-FUTURES perpetual, and the
futures listings carry `isRwa` for the same purpose that `isReality` serves on spot. These map to the
catalog's refusal: neither a spot rToken nor a stock perpetual is catalogued at all — see
[what this catalog refuses](#what-this-catalog-refuses-bitgets-non-crypto-listings).

**`isRwa`/`isReality` are the flags to read, not `symbolType`.** `KUAISHOUUSDT` and `HPQUSDT` are
equities carrying `symbolType: crypto`, so the type field is unreliable for the crypto/RWA question.
It is worth reading only for `stock`, which catches the pre-IPO names the reality flag does not cover.

**Known limitation: a delisted equity is only recoverable on the spot side.** Once an instrument
leaves the listings, no flag can speak for it, and the name is all that remains — which works for spot,
where bitget prefixes Reality tokens with a lowercase `r` and does so exclusively. A delisted stock
perpetual is named `AAPLUSDT`, indistinguishable from a crypto perpetual, so it classifies as `perp`.
There is no signal that would fix this, and the consequence is small: a handful of dead equities sit
in the wrong market.

**Spot equities publish almost nothing.** Of the ~700, exactly one appears among the indexed files.
Futures equities are published normally.

## Naming: what can be derived, and what must be looked up

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

### That residue is mostly derivable after all

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

Two more are visible only in the books tree, where no earlier sweep looked:

- **the multiplier contracts.** The portal carries it and the archive drops it —
  `1000XECUSDT` → `XECUSDT`, `1000BONKUSDC` → `BONKPERP` (with `USDC` → `PERP` on top).
- **`USD_CM` → `USDCM` for books**, where klines take `USD_CM` → `CM`. `BTCUSD_CM` files its
  klines under `BTCCM` and its books under `BTCUSDCM`. The same instrument, two datasets, two
  spellings — which is why `url_symbol` is a field of the series and not of the instrument.

The 17 that no rule reaches are relistings where the portal describes what the archive merely
tickers — `BOOMUP/USDT` → `BOOMUSDT`, `GDXGOLD/USDT` → `GDXUSDT`, `MAJORPOINTS/USDT` →
`MAJORUSDT`, `SPACEMICROVISION/USDT` → `SPACEUSDT`, `MSTRBEP20/USDT` → `MSTRUSDT` — plus two
unrelated renames, `KAON` → `AKRO` and `SLTC` → `SBCHS`. These must be read from the venue, which
is what the trading platform search is for, since `symbolCode` gives the archive name directly.

### The index answers with its own label, so read `displayName`

Every row the download index returns carries the `displayName` that produced it, which is the exact
symbol-to-URL mapping a bulk request otherwise loses — asking 2,000 names at once returns one flat
list with nothing saying which name yielded what.

**But it is the venue's label, not always the name asked.** `1000BONKUSDC` comes back for a request
that named something else, dated futures answer with their expiry label (`BTCUSD0926` for
`BTCUSDU25`), and the Reality tokens answer with their lowercase portal form (`rAMCR/USDT` for
`RAMCRUSDT`). So `displayName` identifies the *file*, and the archive directory identifies the
instrument.

Where a pairing is not obvious, the fix is not a cleverer inference: **ask the index again with one
symbol**. The batch is a speed strategy, not a requirement, and a single-symbol request is
categorical about what that instrument has.

### A path names whoever held the ticker when the file was written

Bitget reuses tickers and a path cannot be renamed after the fact, so the plain spelling belongs to
the *first* holder and every later one gets a fresh path:

```
spot, ticker "AI"
  AIUSDT          2023-02-07 .. 2023-11-23     the first holder
  $AIUSDT         2024-01-04 .. 2026-04-30     the second
  AIGENSYNUSDT    2026-04-29 .. open           the third, and what the API calls AIUSDT today
```

Handovers are exact rather than overlapping, so these read as separate series with adjacent ranges.

**This is why an archive path is never derived from a live API symbol.** Ask the CDN for today's `AI`
at `kline/AIUSDT/…` and it answers — with a different project's 2023 candles.

The disambiguated spelling is not derivable either, and the portal's own labels for retired holders
are inconsistent between markets: the futures listing calls the first `AI` `AISLEEPLESSUSDT` while
the spot listing calls it `AIOLD/USDT`.

**Distinguishing a rename from a spelling.** When a lookup for symbol `A` yields a URL under symbol
`B`, there are two possibilities and they call for opposite records:

| | meaning | record |
|---|---|---|
| `B` is itself a bitget symbol | renamed, or the ticker was reused | **two series**, `A` and `B`, adjacent ranges |
| `B` was never a symbol | `B` is how the archive spells `A` | **one series**, `symbol = A`, `url_symbol = B` |

Getting it wrong is not cosmetic: recording the second case as two series produces "`A` is void, `B`
is full of data". The trading platform search settles it — if `symbolCode(A) = B` then `B` is a
spelling; if `A` and `B` each appear as their own record, they are two instruments.

### An instrument is a market plus a symbol, and a path belongs to nobody

**This is the question that keeps being re-asked, so it is settled here.**

A canonical symbol is unique **per market**, never globally. `BTCUSD` may exist as spot, as a
perpetual and as a dated future at the same time, and those are three instruments. What must never
happen is two instruments sharing one market *and* one canonical symbol.

**A path, by contrast, is owned by nobody.** Bitget reassigns directories and filenames: it re-issues
a ticker, shortens a name into one that collides with a different instrument, moves a stream from one
folder to another, and files an instrument under a name it dropped years ago. So the same archive
spelling can carry one holder's files up to some date and another's from the next day on.

It follows that **two series may legitimately share an archive spelling**, and the seed is full of
them - 51 spellings across 413 series. That is not a fault and does not need investigating. The
worked example:

```
futures  AISLEEPLESSUSDT -> AIUSDT          the first holder, under the plain name
futures  AIUSDT          -> AIGENSYNUSDT    what the API calls AI today
futures  AIUSDT          -> AIUSDT          the plain name again, on a later shape
```

All three can be right. They sit on different datasets and different eras, so they describe different
keys; and where they do share a shape, they cover different date ranges.

**The only thing that is ever wrong is two series generating the same URL for the same date.** One
key is one file, `file` is unique on `(venue_id, path)`, and whichever series settles it first keeps
it - so the other silently gets nothing and its instrument reads as having a hole. Checking spellings
tells you nothing; checking generated keys is the check.

**What the catalog must guarantee** is that an instrument's whole history is reachable under its one
canonical `(market, symbol)`, however many series it takes and wherever bitget moved the files. The
series are the mechanism; the canonical is the identity.

### Two keys name one instrument inside another's directory

```
kline/TRXUSDT/TRXETH_SP_1min_20220508.zip
kline/TRXUSDT/RUNEUSDT_UMCBL_1min_20221117.zip
```

Both are served. In era-1 naming the symbol appears twice — directory and filename — and in these two
keys they disagree. They are the only two in 5,055,779 paths.

Neither can be *read* — no single-`{SYMBOL}` shape parses them — but one of them is **generated**: an
`archiveDir` transform bounded to `20221117..20221117` puts `RUNEUSDT`'s day back under `TRXUSDT/`,
because it is the only copy and the day would otherwise be a permanent hole. `TRXETH`'s needs no such
row: a byte-identical copy sits at its proper key.

## What the download form does not know

The dropdown enumeration is the only listing that remembers delisted instruments, and it is still
incomplete in two measured ways.

**Non-ASCII names are unreachable.** `龙虾USDT` is a real USDT-FUTURES instrument with 166 days of
klines and trades, filed under `LOBSTERUSDT`. The form returns it when asked for `龙` or `虾`, but a
crawl over `a–z0–9$/_` cannot construct a query that matches it: its only ASCII substrings are `u`,
`us`, `usd`, `usdt`, and the last two match nearly everything and are skipped. `牛来USDT` is the
other. Both are in the REST listing, which is how they were found.

**The line token is the market**, and it is a property of the key: `/1/`, `SP` and `SPBL` are spot,
the margin tokens and `/2/` are futures. It is fixed when the file is written and cannot be revised
afterwards, which is why a record's market is read off its path rather than inferred from the name.

**A name asked of the wrong line still answers.** Asking the spot line about a futures name returns
spot-line depth keys for it, and they are served: a sweep in September 2026 that sent one name list to
both lines came back with hundreds of thousands of such keys. They are real files and they are not
this catalog's — the instrument is offered on one line, so it is asked of that line only, and a key
from the other line belongs to whatever the venue files there. The sweep now sends a list per line for
exactly this reason.

Those files are also not a copy of the futures ones. Measured on matched timestamps, prices differ by
a consistent 0.4–0.5 and the `/1/` file carries two rows per timestamp with different books, so
whatever the venue is filing there, it is not the `/2/` stream under another name.

## Building the seed

The archive cannot be listed, so the seed is built by asking, in three stages. This is in progress;
the description will change as it does.

**1. Enumerate the instruments.** The dropdown crawl over all six market/dataset combinations, then
the REST listings of both API versions. Each name is recorded with the source that produced it, so
the sources can be compared rather than merged — the dropdown remembers the dead, the REST APIs know
the live, and only together do they approach complete.

**2. Enumerate the files.** The download index, asked for every known name at once over consecutive
8-day windows from 2018-01-01 to yesterday, across all six combinations. The full name list is sent
to every combination rather than one market's names to its own market, because which market a name
belongs to is part of what is being measured. Every returned URL is then matched against the known
shapes, which yields its pattern and the string filling the symbol placeholder.

Two hazards this stage has already surfaced, both worth guarding on any re-run:

- The reply carries a `displayName` that is **not always the name asked for** — for dated futures the
  venue answers with its own label. Since one request carries thousands of names, the mapping back to
  the request is lost for exactly those rows. It is recoverable only because the archive path is
  itself one of the names asked for. Measured: 29 such names, all dated futures, none else.
- A query that fails is a subtree never explored, and the output looks identical to a complete one.
  Rate limiting, a challenge page and an empty result must be told apart, or the result is silently
  short.

**3. Resolve the names.** Each instrument's archive path comes from the files it was found under;
where the portal name and the REST name differ, the trading platform search's `symbolCode` and
`symbolCodeDisplayName` supply the correspondence directly rather than by inference. What no source
resolves is left unresolved rather than guessed.

A canonical name is then assigned per instrument, so that an instrument whose archive spelling
changes remains one history rather than becoming two. For live instruments it is the REST name; for
delisted ones nothing depends on the choice, except that it must not collide with a live instrument's
canonical — which is the failure the whole exercise exists to prevent.

**4. Enumerate the series.** Every instrument against every shape that can carry it: its market's
patterns, and for futures trades only the token its own margin type files under. Not the combinations
the index happened to return — those are a subset of what exists, and seeding them would inherit the
index's blind spots for good, since nothing walks this venue and a key absent from the seed is never
probed.

So the seed states a **search space**, and a run establishes what is in it:

| | |
|---|---|
| `first` | never set. The run finds it |
| `last` | the newest date the index claimed, so a hook can jump there rather than probe the years between. A hint, not a bound — no file in the index has been fetched, and the index both omits files that exist and lists files that do not |
| `tip` | under anything the shape could hold, so nothing is settled by assumption |

The tips, per era and dataset:

| era | klines | trades | depth |
|---|---|---|---|
| ends 2024-04-18 | 20180601 | 20180601 | — |
| ends 2026-08-17 | 20180601 | 20240301 | 20240601 |
| current | 20260601 | 20260601 | 20260601 |

Candlesticks reach furthest back in the middle era because that era's keys carry dates from 2019 —
see below.

### Why the seed states shapes rather than sightings

The index omits files that exist. Measured on the era-boundary candlesticks: of six days it listed
under the era-2 key only, five have an era-1 file too, serving the same candles — see *The three
naming eras*. On those six keys it under-reported by five files.

Nothing in the file list has been fetched, so it bounds nothing in either direction. A seed built
from it would inherit that silence permanently, because nothing walks this venue: a key the seed does
not name is never probed, and never found.

## Discovering instruments added later

The seed covers what exists today. Keeping up needs a listing that names new instruments *before*
any file exists, which rules out the archive and the download index.

**The REST APIs are that listing**, and both are needed: v2 for delivery contracts, demo product
types and the classic coin-margined line; v3 for the eleven coin-margined perpetuals v2 omits. Eight
v2 requests plus five v3 ones cover every category.

For a newly listed instrument the archive path is unknown, and the transformation rules above cover
about three quarters of cases. The remainder is what the trading platform search answers — it returns
`symbolCode` for an instrument that has never published a file, so the URL can be constructed before
the first file lands.

**The margin token has to be carried from the listing too, and it is the half that is easy to
forget.** A futures contract's trades sit under `UMCBL`, `DMCBL` or `CMCBL`, and which one is a
property of the API category it was read from — nothing in the symbol, the market or the path says
it. So the category is read into a `marginToken` transform against the instrument at the moment the
listing is parsed, and the transform is written before the contract's series are. A coin-margined
contract asked for under `UMCBL` answers `403`, which here means "not there", so the whole
instrument reads as one that publishes nothing and no error is raised anywhere.

What no listing provides is a **delisted** instrument's name: the REST APIs carry only what trades
today, and the search endpoint returns nothing for a retired symbol. Those exist solely in the
dropdown enumeration and in the archive itself, which is why the sweep's output is a historical record
worth keeping rather than something to regenerate on demand.

## What this catalog refuses: bitget's non-crypto listings

**Roughly 1,500 of the instruments bitget lists are not crypto**, and none of them is catalogued.
Tokenised equities and ETFs on the spot line, spelled `rTSLA/USDT`, `rAAPL/USDT`, `rARKK/USDT`;
equity perpetuals on the futures line, spelled `AAPLUSDT`, `ASMLUSDT`, `ANTHROPICUSDT`; plus a
handful of metals, commodities and currency pairs.

They are refused at discovery, in `bitgetInstruments`. **The predicate is `marketOf`, not
`symbolType`** — measured over 2,941 listed instruments, `symbolType = 'stock'` alone misses 2 spot
metals, 7 futures metals, 3 futures commodities and 11 futures contracts the venue types `crypto`
while flagging `isRwa: YES` (`HPQ`, `BHP`, `RIO`, `VALE`, `EURUSD`, `USDJPY` and the like). Both
fields `marketOf` reads are present on every instrument of every category, so nothing defaults.

| line | rule | what it catches |
|---|---|---|
| spot | `symbolType !== 'crypto'` | stock and metal — and anything bitget invents later, since it refuses by default |
| futures | `isRwa === 'YES'` | stock, metal, commodity, and the crypto-typed RWAs |

**Why refuse rather than catalogue.** This family carries the venue's naming pathology at its worst —
it is where most of the reused tickers, shortened names colliding with real instruments, and
directory reassignments were found — and nothing downstream wants tokenised equities. Bitget's
archive is a mess throughout; this corner of it is the messiest, and none of that mess has to be
modelled if the instruments are never admitted.

Two families of series went with them. The **`unknown` market** held depth streams that surfaced only
when `getPublicDataV2` was asked with a name from the other line — a slashless symbol on
`businessLine=1`, or the reverse — returning files whose provenance nothing establishes, sometimes
with a market digit contradicting the line that answered them. Those are gone too, along with the
market itself. And `categoryOf` is gone from the adapter: it existed to stop a market that spans both
archive lines being given the wrong line's shapes, and with the non-crypto instruments refused, no
market spans both.

## Open questions

- Why 809 depth streams stop on 2026-08-17, the last day of era 2, with nothing taking over — probing
  every filename digit on later dates answers `403` for all of them.

- What the two rows per timestamp in a depth file are.
- Whether the era-3 `fileName` variant (`<displayName>-<real basename>`) means anything.
- Whether the bucket cut holds for futures products and for klines and depth.
- Whether `pre`-prefixed equities are pre-IPO instruments.
- Whether `XUSD` and `XCM` are one economic instrument under two account systems.
