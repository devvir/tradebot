# Prospector: venues

How prospector handles each venue it surveys: the registry, the principles an adapter is written to,
the hooks the core offers for what a venue cannot be described without, and venue by venue, which
adapters there are, what they refuse and why, and where a general mechanism is that venue's case.
**What a venue publishes, and the evidence for every figure, is its own doc** under
[docs/venues/](../venues/). What an adapter is, and its members, is
[PROSPECTOR.md](PROSPECTOR.md#the-model).

## The registry

The registry is `src/venues.ts` and each adapter is one file beside it, with the venue's strategy in
`src/adapters/<venue>/`. Every adapter is written to the same four principles:

| | |
|---|---|
| **a server, not a venue** | an adapter is one host. A venue serving its books from a second machine is two adapters sharing a name, with two limiters and two sets of run rows |
| **addressed where it answers, not where it serves** | a CDN in front of a bucket may answer a listing plausibly and wrongly — a cached reply is indistinguishable from a broken venue except by `x-cache` and `age`. Where the bucket itself answers, the venue's one address is the bucket, and the CDN is not used at all |
| **surveyed from the bucket root** | wherever the venue allows it. Descent guarantees nothing *above* where it starts, so a declared prefix reintroduces one level up exactly the omission that discovering prefixes exists to prevent — and at three of the servers here it would hide real datasets, each absent from the tree the venue's own site presents |
| **offered against merely reachable** | a tree nobody advertises is still that venue's data, and being unadvertised is a reason to take it *sooner* — it may be withdrawn without notice |

Each adapter's `pacing` and `probingLag` are declared beside it in `src/adapters/`, with a pointer to
the venue doc that holds the evidence; the lags are tabled in [how far behind
today](PROSPECTOR-SERIES.md#how-far-behind-today-a-probing-update-asks).

## The hooks exist because a venue could not be described without them

Every optional hook in [the model](PROSPECTOR.md#the-model) is a place where a general mechanism
admits a specific answer, rather than a place where one venue's behaviour is written into the core.
An adapter that grows control flow has taken on work that belongs to a scanner; an adapter that needs
a hook nobody else uses has found something real about its venue, and the hook is how that stays out
of everything else.

**A hook answers; it does not act.** `refusesUs` says who answered a refusal, `ruleOnFailure` says
what it means for the key, `expandParts` says which parts the period has. What to *do* about any of
those — stand the venue down, drop the row, park the key — stays in one place for every venue. And no
scanner ever sees an adapter: it is handed a context the adapter assembled
([PROSPECTOR.md](PROSPECTOR.md#a-scanner-is-handed-a-context-never-an-adapter)).

## Venue by venue

### binance

One adapter, listed at the bucket (`s3-ap-northeast-1.amazonaws.com/data.binance.vision`) with an
empty key root. The CDN in front of it, `data.binance.vision`, is recorded in `alternative_hosts` and
never asked. Facts: [BINANCE.md](../venues/BINANCE.md).

**Surveyed from the bucket root, so nothing is stripped.** `data3/liquidationSnapshot/`, the only
USDⓈ-margined liquidation snapshots, sits beside `data/` rather than under it, and descent finds
nothing above where it starts. Paths therefore keep their leading `data/` or `data3/`, and a URL is
`base` + `/` + path.

**`accepts` refuses four things the root also reaches**, and each refusal is a cost avoided:

- `data2/`, a staging area of copies.
- A bare key directly under `data3/`: only that tree's subdirectories hold data.
- The tree whose keys begin with `/`: a frozen snapshot of the spot archive holding strictly less
  than `data/spot/monthly/`, file for file. It is historical data, and the one refusal of that kind:
  earned by reading both renderings and finding one to be the other with less in it.
- The `1w`, `3d` and `1mo` intervals, as a path segment, on every interval dataset and both trees.
  Each is an aggregate of the `1m` variant the catalog holds, and they publish irregularly, so their
  series' tips sit behind the frontier and re-ask every open day. On a catalog that holds them they
  are 51 patterns and 22,155 series, and some 55% of binance's nightly update.

**`um` and `cm` are one canonical market and two keyspaces.** The instruments hook records which
futures service listed a contract (`um` from `fapi`, `cm` from `dapi`) as its `category`, and
`categoryOf` reads the same segment out of a pattern, so a newly listed contract is given only its own
service's shapes — see [one market can be more than one archive](PROSPECTOR-SERIES.md#one-market-can-be-more-than-one-archive).
Unfiltered, a newly listed perpetual would get a series under both trees, half of them describing
keys the venue never writes, each a request a day.

**Dated contracts and options are read from the same listings.** A contract whose type is not
perpetual is a `future`; options are listed by underlying, one instrument each, from `eapi`.

**Shapes binance stopped writing are seeded retired**, by migration `006-binance`: `bookTicker` and
`liquidationSnapshot` of both futures services and the options `EOHSummary`, eight shapes, each at
the date it stopped. The files stay catalogued; only generation stops, since an instrument binance still
lists would otherwise keep its dead shapes open.

No throttling answer has been seen from the bucket
([BINANCE.md](../venues/BINANCE.md#rate-limits)); a limit nobody has reached would show as a pass
slowing down — see [carrying requests](PROSPECTOR-TRANSPORT.md#carrying-requests).

### bitget

One adapter, on the `probed` scanner: the bucket grants no listing, so `listable` is false and every
pass is an update over series declared by migration `004-bitget` from `seeds/bitget/` (see the
[seeds README](../../services/prospector/src/database/migrations/seeds/README.md#the-bitget-seed)).
Facts: [BITGET.md](../venues/BITGET.md).

**Its shapes follow bitget's three naming eras, and the seed carries the first two retired**: the
era-1 shapes at 2024-04-18 and the era-2 shapes at 2026-08-17, with era 3 live (see [the
eras](../../services/prospector/src/database/migrations/seeds/README.md#the-eras)).

**Discovery reads the v3 instruments listing, for `SPOT`, `USDT-FUTURES`, `COIN-FUTURES` and
`USDC-FUTURES` only**, one request a category (`bitgetInstruments`). Everything it names is live. What
only the v2 listings name — the classic coin-margined line, v2 delivery contracts, the demo product
types — is not discovered, and neither is an instrument bitget no longer lists: those are reached only
where the seed holds them. The two APIs list different instruments
([BITGET.md](../venues/BITGET.md#the-two-rest-apis-are-two-account-systems)).

**Non-crypto instruments are refused at discovery**, before anything else is asked about them.
`marketOf` (`adapters/bitget/shapes.ts`) calls them `tradfi`, and `tradfi` is dropped: on spot,
anything whose `symbolType` is not `crypto`; on futures, anything flagged `isRwa: YES`. Those are the
flags that separate the two ([BITGET.md](../venues/BITGET.md#two-fifths-of-what-bitget-lists-is-not-crypto)).
They are refused rather than catalogued because the venue's naming is at its most irregular there —
reused tickers, shortened names colliding with other instruments, directories reassigned — and none
of it has to be modelled for instruments that are never admitted.

**A new instrument's archive spelling is asked of the venue.** For each name the catalog has never
met, the trading platform's search is asked once (`archiveNamesOf`), and its `symbolCode` is the
spelling the files use; where it does not answer, the rules in `adapters/bitget/symbols.ts` give one.
`urlSymbolFor` hands the spelling to the preamble per pattern.

**The margin token comes with the listing.** A futures contract's trades are filed under `UMCBL`,
`DMCBL` or `CMCBL`, and nothing in the symbol says which. The token is the one the search's
`symbolId` carries, or else the one the listing category maps to (`tokenOf`), and it is written as a
`marginToken` [transform](PROSPECTOR-SERIES.md#what-a-pattern-cannot-spell-one-instrument-at-a-time)
before the contract's series are — none where it is the patterns' default, `UMCBL`. A wrong token
builds keys the bucket answers with its `403`, which here is absence, so the contract would read as
one that publishes nothing.

**A `403` from the bucket is absence; anything not served by `AmazonS3` is a refusal aimed at us.**
The bucket grants `GetObject` without `ListBucket`, so every object it has never held answers
`403 AccessDenied` — the same status as being turned away, separable only by the headers.
`ruleOnFailure` answers `'drop'` for an S3-served `403`, so a missing key is set down on its first
answer and asked again by the next update while its period is above the tip; `refusesUs` counts any
reply not served by `AmazonS3`, whatever its status, as aimed at us — see [what ends a
key](PROSPECTOR-PASSES.md#what-ends-a-key-absence-confirmed).

**A day's trades are numbered parts, followed to the first miss.** bitget cuts a day every hundred
thousand rows into `_001`, `_002` and on, and nothing says in advance how many there are, so
`expandParts` names them one at a time and the chain ends where the archive does
([a period published in parts](PROSPECTOR-SERIES.md#a-period-published-in-parts)). **A size threshold
is the wrong shape for bitget**: it would guess where the venue states — one request saved against a
silently truncated day.

Paced at 2,500 requests a second with 500 in flight, under the edge's measured limit. Its bucket
answers a missing key in a way that makes a probe over HTTP/1.1 cost a connection, which is why
probes go over HTTP/2 ([carrying requests](PROSPECTOR-TRANSPORT.md#carrying-requests)).

### bybit

Two adapters sharing the name, one per server. Facts: [BYBIT.md](../venues/BYBIT.md).

**`bybit/primary` is the main archive, listed at its bucket** (`s3.ap-southeast-1.amazonaws.com/public.bybit.com`)
and never at its edge. The CDN in front of it, `public.bybit.com`, bans an address at rates the bucket
behind it takes without a refusal, and its ban covers the CDN alone
([BYBIT.md](../venues/BYBIT.md#limits)); so the edge is not among the primary host's
`alternative_hosts`, and the bucket is walked at the 2,000 a second its adapter declares. Its listing
carries size, ETag and last-modified, so a walk probes nothing. `accepts` refuses `backup/` (a copy of
files served under `trading/` too), every key at the bucket root (the browsing UI), and the four 2021
expiries under `trading/` — fragments of contracts rather than series of them, absent from bybit's own
download form. One misfiled `DOTUSDT` day is a row in the `exclusion` table. `slotsFor` renders
`{MONTH_LAST_DAY}` for the MetaTrader klines (see [the slots](PROSPECTOR-SERIES.md#the-slots)).

**`bybit/secondary` is the order books**, on `quote-saver.bycsi.com` under the key root `orderbook/`,
read from browsable indexes with `html.ts`. The index names files and says nothing else, so every
key is probed. A key an index named is kept through up to 100 `404`s while a walk is running — more
than the core's 30 for confirmed rows, because its CDN has bad minutes ([BYBIT.md](../venues/BYBIT.md));
on an update it is the core's ordinary rule. Its `ruleOnFailure` asks which pass it is in through
`surveying` — see [what ends a key](PROSPECTOR-PASSES.md#what-ends-a-key-absence-confirmed).

**Both read the same listing**: spot, `linear` and `inverse` (both perpetuals), and options by
underlying. bybit lists no underlyings, so the ones asked about are those the catalog already holds,
and an underlying is live while any of its contracts trades.

### gate

One adapter, listed at the bucket (`s3-ap-northeast-1.amazonaws.com/gateio-public-data`); the CDN,
`download.gatedata.org`, is recorded in `alternative_hosts` and never asked, since its own listing
ignores what it is asked. Facts: [GATE.md](../venues/GATE.md).

**`accepts` keeps seven trees and refuses the rest**: `spot`, `futures_usdt`, `futures_btc`,
`tradfi`, `delivery_usdt`, `spot_index` and `options_ticker`. The others are dead, not market data,
or not gate's: `hk/` and `malta/` are separate Gate entities with their own order books, so their
`BTC_USDT` is not gate.com's, and they are refused rather than merged under this venue's symbols.
Within the seven, `accepts` also refuses:

- a key at the wrong depth: what sits directly below a tree is a month for the two snapshot trees and
  a dataset name for every other;
- an `s3deals/` directory directly inside a dataset month, as in
  `spot/candlesticks_{1m,5m,1h,4h,1d,7d}/201802/`, where it holds bars of that interval
  ([GATE.md](../venues/GATE.md#misfiled-months-beyond-the-2022-books-hour));
- a file whose directory and filename name different months (`gateMisfiled`), except hourly books,
  whose misfiled hour is the only copy, and 108 instrument-days of klines with no correctly filed
  twin. Nothing in a path tells those from the duplicates, so `adapters/gate/misfiled.ts` keeps them
  as a closed list;
- a file under `futures_btc/` whose instrument is not a `*_USD` (`gateWrongTree`).

The two zero-byte uploads and 85 of the spot files served at futures URLs for 2021-07 are rows in
the `exclusion` table: there is no shape to describe. What else `futures_usdt/trades/202107/` holds is
in [GATE.md](../venues/GATE.md#2021-07-spot-data-at-the-futures-url).

**The misfiled files that are kept sit on literal-month shapes, seeded retired.** A directory that
names another period stays literal in the pattern
([PROSPECTOR-SERIES.md](PROSPECTOR-SERIES.md#the-patterns-are-read-out-of-the-paths)), so each such
shape holds one period. gate's 21 are in `seeds/gate/pattern.csv`, seeded by migration `005-gate`
with `retired_at` at the day each holds: three `orderbooks/202212/` shapes holding 2022-11-30 hour 23,
and eighteen `candlesticks_{30s,1m,5m}/2024{07..12}/` shapes, each holding the last day of the month
before. Left live, such a shape costs far more than its files: every series on it asks for every day
between its tip and yesterday on every pass, and nothing can ever answer. Measured on 2026-09-27 with
those shapes live, they held 63,506 series and produced 312,336 of gate's 323,229 nightly probes.
What gate misfiled is in [GATE.md](../venues/GATE.md).

**Its books and snapshot trees are periods published in parts**, and gate names a period's parts from
the period alone: a day's 24 hours, or a snapshot tree's epoch stamps across a month (an hour apart in
`spot_index`, a minute apart in `options_ticker`). For a series with no `first` it asks about all of
them at once, since an instrument's first day begins mid-period. Otherwise it asks about the first
part and, only if that is there, all the rest in one reply — gate publishes a day of books whole or
not at all, and an instrument's first day from the hour it was listed
([GATE.md](../venues/GATE.md#layout)), so a quiet day costs one request rather than 24.
See [a period published in parts](PROSPECTOR-SERIES.md#a-period-published-in-parts).

**Tradfi's `status` is not read.** `/api/v4/tradfi/symbols` reports the exchange session, which is
closed for every symbol outside US market hours, so read as listing state it would delist the whole
market on any pass that ran out of hours and revive it on the next. Every symbol the list names is
live, and a symbol leaving the list is a delisting. Spot reads `trade_status` (`untradable` is not
live) and contracts read `in_delisting`, which do carry listing state.

gate declares no `probingLag`, so it takes the default of one day.

### htx

One adapter, listed at the bucket (`huobi-service-data.s3.amazonaws.com`) with an empty key root, so
both of its trees, `historical_data/` and `data/`, are walked; the CDN, `www.htx.com/data`, is never
asked. Facts: [HTX.md](../venues/HTX.md).

**`accepts` refuses** the browsing UI's `assets/`, the scratch directory `test/`, each dataset's
`remark.txt` (field descriptions with no date, which nothing would place in a series), and every
`data/` key dated 2026-02-01 or later.

**The two trees overlap, and each instrument-day is catalogued once.** From 2026-02-01 to 2026-08-04
both publish the same instrument-days under different schemas. Catalogued twice, one unit would
arrive from two shapes with nothing to say which is the data, and a day would read as covered or
missing depending on the tree asked. So the cut is one date, decided from the path alone and holding
for keys nobody has listed yet: `historical_data/` throughout, and `data/` before **2026-02-01**
(`MIGRATED` in `adapters/htx.ts`). That date is where `historical_data/` begins, and every day
`data/` holds from it on is also in `historical_data/`, with the two exceptions below — so an earlier
cut would lose `data/` days `historical_data/` lacks, and a later one would catalogue days twice. It
is the better branch on its merits too: `data/` is the tree with holes in it during the overlap.

**Two things are knowingly given up, and are refused with everything else**: the nine perpetuals
`historical_data/` never carried, all stopped by 2026-08-03, and one day of `indexPrice` for nine
coin-margined perpetuals. Both are sparse tails on near-dead instruments, `data/` still serves them,
and a rule carrying symbol-level exceptions costs more than they are worth.

**The end of `data/` is catalog state.** Migration `002-htx` seeds the 90 `data/` patterns with
`retired_at` 2026-08-04, the day the tree was last written, so no newly listed instrument gets a
series on them and generation stops at that day; `accepts` refuses the overlap wherever a key
arrives, listed by a walk or generated by an update. Neither date can be found by reading the
archive, which is why both are declared.

**One instrument, two spellings.** The catalog names an instrument the way `historical_data/` does,
dashed, without the `-PERP` its perpetual shapes carry in the pattern, and a `data/` series carries
`data/`'s spelling as its `url_symbol`.

### kucoin

One adapter, listed where the files are served (`historical-data.kucoin.com`) under the key root
`data/`. Facts: [KUCOIN.md](../venues/KUCOIN.md).

**`accepts` refuses futures klines at `1d`**, published with five fields under a six-field header, so
the bar has no volume ([KUCOIN.md](../venues/KUCOIN.md#futures-klines-at-1d-are-published-broken)).
Nothing is lost: a day is an aggregate, and the `1m` series covers the same range.

**The catalog names an instrument as kucoin's API does**, and a series carries the archive's spelling
as its `url_symbol` where it differs: spot klines and trades drop the dash (the dash is put back from
the quote currency when a path is read), and bitcoin contracts the API names `XBT` are filed `BTC`
(perpetuals everywhere, dated contracts only under books). `inspectUrl` reads a path into the API's
name, and `urlSymbolFor` is its inverse.

**Every futures instrument is a `perp`**, the few quarterly contracts among them included. Spot is
read from `/api/v2/symbols` (`enableTrading`) and futures from `/api/v1/contracts/active`
(`status: Open`).

### okx

One adapter, on the `probed` scanner: nothing can be listed, so `listable` is false and every pass is
an update over series declared by migration `003-okx` from `seeds/okx/`. Facts:
[OKX.md](../venues/OKX.md).

**The venue-wide files are `@` series, seeded one per market-bundle pattern.** `allspot`, `allswap`,
`allfutures`, `alloption` and `allmargin` name no instrument, so their ten patterns carry no
`{SYMBOL}`; the preamble never gives such a pattern to an instrument and never delists it — see
[a shape with no symbol](PROSPECTOR-SERIES.md#a-shape-with-no-symbol-cannot-be-branched-by-symbol). A
dated chain's `futureschain` or `optionchain` belongs to its pattern, so an instrument is named by its
family ([a decoration around the symbol](PROSPECTOR-SERIES.md#a-decoration-around-the-symbol-belongs-in-the-pattern)).

**Its order books are two generations of shape.** The seed carries the eight `okx/match/orderbook/L2/`
shapes retired at 2026-08-04, beside the `okx/match/orderbook/pro/L2/` shapes that are live — a moved
URL is two patterns, the old one carrying the day it stopped
([retired patterns](PROSPECTOR-SERIES.md#retired-patterns)).

**Instruments are read from the v5 instruments listing**, a market at a time and options an
underlying at a time. A family is the instrument, live while any of its contracts is. **A `preopen`
instrument is listed as not live**, so no series is created for it, though it counts in `listed`.
**Test pairs are refused** by their base (`isTestPair` in `adapters/okx/shapes.ts`), since okx's
`state` does not mark them.

**A `404` settles a key, and a `403` is a refusal aimed at us.** okx never answers one for the other,
so `ruleOnFailure` answers `'drop'` on the first `404` — see
[what ends a key](PROSPECTOR-PASSES.md#what-ends-a-key-absence-confirmed). Paced at 100 requests a
second with 100 in flight: its CDN is clean at 100 and refuses at 200.
