# Review: docs-venues (docs/venues/**)

## Overall assessment

The eight docs under docs/venues/ were checked claim by claim against the prospector adapters, migrations and seeds, hauler's venue.ts and hosts.ts, hoarder's venues and stocker's formats and series map. All 29 findings were confirmed by the first verifier. No finding was refuted. No second verifier ran, because every finding the reviewer rated high was downgraded to medium. 27 items are IMPLEMENT and 2 are DEFER (DVEN-18 on REST homes, DVEN-29 on the template rewrite).

The REST sections are mostly sound and share one structure across venues. The Archives sections are not venue documents. They mix venue facts with prospector, stocker and hauler internals (adapter hooks, seeds, pacing, refusals, log lines). They also carry the history of how things were found ('our fault', 'the first walk', 'an earlier note') and plans ('re-probe in a few weeks', 'when the REST collector covers gate'). This breaks the CLAUDE.md rule that venues are providers on almost every page. Because the service facts sit in the wrong home, they have gone stale against the code without anyone noticing. Examples:
- bybit's 30 req/s and 10-minute stand-down; the code uses 2000/s and 2 minutes.
- 'Nothing goes through the CDN'; the core migration ships alternative_hosts and hauler rotates over them.
- okx's 'never given a series'; the seed holds 10 '@' series.
- BITGET-SEED's empty `last` and withheld SEEDED_AT; both are now set.
- okx's ETag-case warning; etagOf already lower-cases.
- A link to an api/routes.ts that does not exist.
OKX, HTX, BITGET and BYBIT also contradict themselves. Several venue facts that consumers rely on are written only in code docblocks: publication delay, archive headers and columns, and everything about Kraken. BITGET-SEED.md is a prospector seed document filed as a venue doc, and nothing links to it.

One verifier result changes direction and matters most. For the binance bookTicker endings (DVEN-01), the live bucket shows the seed is right and the docs are wrong. Do NOT apply the reviewer's 'correct pattern.csv' fix.

Restructuring recommendation, a fresh start for docs/venues. The bounded fixes below should land first. The full reorder is deferred as DVEN-29.
1. Hard rule. A venue doc holds only facts an outside reader could check against the venue: hosts, listing and addressing behaviour, path grammar, naming, file formats, coverage (floors, ends, eras, gaps), publication delay, limits and refusal semantics, known defects, REST and WebSocket. Every fact is dated '(measured YYYY-MM-DD)'. The docs never say we/our/here, the catalog, the adapter, prospector, stocker, hauler, seed, walk, probe pass, accepts, preamble, transforms, pacing or probingLag. They contain no plan or future language.
2. Common template, one file per venue, plus a new KRAKEN.md:
   - Intro paragraph.
   - Archives: Where it is served / Layout (path grammar and a trees table) / Naming / File formats / Coverage / Publication / Known defects.
   - REST: keep the existing common subsections.
   - WebSocket.
   - Open questions: venue facts only, each with what would settle it, and no schedule.
3. Where removed material goes:
   - Adapter decisions go to one per-venue section of docs/services/PROSPECTOR.md.
   - Seed mechanics go to services/prospector/src/database/migrations/seeds/README.md, which absorbs BITGET-SEED.md.
   - Stocker handling goes to STOCKER.md or STOCKER-PARTITIONS.md.
   - Plans go to docs/planning/.
   - History is deleted; git keeps it.
4. Per-doc triage:
   - KUCOIN is closest to the target.
   - BINANCE, GATE and BYBIT need their service paragraphs extracted and file-format sections added.
   - HTX must split 'Where to stop reading data/'.
   - OKX (1,142 lines) and BITGET (973) need the deepest rewrite. Each should end up at roughly 400-500 lines.
5. Self-checking. Add a CI link and anchor check. The scratch script reviews/scratch/anchors.py already finds the broken links reported here. Code docblocks should point at venue docs by file, not by anchor.

Cross-item ordering for the implementer:
- Do DVEN-02 (delete BITGET-SEED.md, absorb into the seeds README) before DVEN-08, DVEN-07, DVEN-09 and DVEN-15. Wherever their refined fixes say 'fix/move to BITGET-SEED.md', use the seeds README bitget subsection instead.
- DVEN-10, DVEN-14 and DVEN-21 all move HTX's 'Where to stop reading data/' content. Update PROSPECTOR.md:952's anchor once.
- DVEN-13 and DVEN-26 both touch OKX.md:711. DVEN-19 and DVEN-13 both delete OKX.md:662.
- After all edits, run the anchor checker over docs/ (inbound links from PROSPECTOR.md into OKX, GATE, BYBIT and HTX anchors).

## Summary

| id | severity | category | decision | title | source |
|---|---|---|---|---|---|
| DVEN-01 | medium | docs-correctness | IMPLEMENT | Binance bookTicker endings: BINANCE.md and the 006-binance.ts docblock are wrong, the seed is right | F20 |
| DVEN-02 | medium | docs-placement | IMPLEMENT | BITGET-SEED.md is a prospector seed doc filed under docs/venues, linked from nowhere, and stale against the seed and code | F1 |
| DVEN-03 | medium | docs-correctness | IMPLEMENT | BYBIT.md states a 30 req/s adapter rate and a 10-minute stand-down; the code uses 2000/s and 2 minutes | F2 |
| DVEN-04 | medium | docs-correctness | IMPLEMENT | Claims that the CDN is never used contradict the shipped alternative_hosts and hauler's host rotation; OKX says a second address is unimplemented | F4 |
| DVEN-05 | medium | docs-correctness | IMPLEMENT | OKX.md describes prospector behaviour that the code contradicts (bucket series, preopen, pacing, RATES_START) | F8 |
| DVEN-06 | medium | docs-consistency | IMPLEMENT | OKX.md contradicts itself on book floors, day boundaries, the monthly window and what the instruments API lists | F9 |
| DVEN-07 | medium | docs-correctness | IMPLEMENT | BITGET.md describes discovery from the v2 and v3 listings and the non-crypto refusal as catalog behaviour; the code reads v3 only | F16 |
| DVEN-08 | medium | docs-correctness | IMPLEMENT | BITGET.md 'Building the seed' is stale against the shipped seed and contradicts the same doc | F15 |
| DVEN-09 | medium | docs-correctness | IMPLEMENT | BITGET.md says era-1 and era-2 copies hold the same content, which BUGS.md contradicts; publication delay has two homes | F17 |
| DVEN-10 | medium | docs-consistency | IMPLEMENT | HTX.md contradicts itself on data/ headers and on whether the nine untaken instruments are kept | F13 |
| DVEN-11 | medium | docs-coverage | IMPLEMENT | Venue facts that consumers rely on have no venue-doc home: publication delay, file headers and columns, Kraken | F26 |
| DVEN-12 | medium | docs-consistency | IMPLEMENT | BYBIT.md contradicts itself on funding and open-interest history, states the same limits twice, and documents prospector mechanics | F22 |
| DVEN-13 | medium | docs-history | IMPLEMENT | OKX.md is built around the history of the walks and full of plans; the module-6 material is in the wrong section; a link is broken | F10 |
| DVEN-14 | medium | docs-placement | IMPLEMENT | HTX.md frames venue facts around catalog decisions and carries plans and stale relative time | F14 |
| DVEN-15 | medium | docs-placement | IMPLEMENT | BITGET.md Archives section names prospector and stocker internals throughout; its concurrency figure disagrees with the code | F18 |
| DVEN-16 | medium | docs-placement | IMPLEMENT | BINANCE.md mixes catalog design, waste figures and cold-storage state into the venue description | F19 |
| DVEN-17 | medium | docs-placement | IMPLEMENT | GATE.md carries catalog mechanics, stocker behaviour, waste history and a REST-collector plan | F23 |
| DVEN-18 | medium | docs-duplication | DEFER | Per-venue REST facts have three homes: the venue docs, docs/REST.md and docs/planning/REST.md | F27 |
| DVEN-19 | low | docs-consistency | IMPLEMENT | OKX.md contradicts itself on the module numbering | F7 |
| DVEN-20 | low | docs-correctness | IMPLEMENT | OKX.md's ETag-case warning is obsolete and links to a file that does not exist | F6 |
| DVEN-21 | low | docs-correctness | IMPLEMENT | HTX.md says 'the preamble states the tree's end', which contradicts migration 002, the code that applies it | F12 |
| DVEN-22 | low | docs-correctness | IMPLEMENT | GATE.md says delivery_usdt books and orderbooks_slice are 'collected by nothing' or 'not collected'; the adapter accepts and maps both | F5 |
| DVEN-23 | low | docs-correctness | IMPLEMENT | BYBIT.md and BINANCE.md describe a tag/tagOf mechanism that no longer exists (it is now grain and variant) | F3 |
| DVEN-24 | low | docs-duplication | IMPLEMENT | OKX's archive index is described in two places under two endpoints, and the seeds README says okx has no index | F11 |
| DVEN-25 | low | docs-correctness | IMPLEMENT | Hoarder's Binance docblock says futures WS delivers nothing on /ws; BINANCE.md documents the working path /public/ws | F25 |
| DVEN-26 | low | docs-links | IMPLEMENT | Inbound links from PROSPECTOR.md to GATE.md (and two others) point at headings that no longer exist | F24 |
| DVEN-27 | low | docs-history | IMPLEMENT | BINANCE.md describes the CM-into-UM integration with dates that are now past, and draws advice from it | F21 |
| DVEN-28 | low | docs-scope | IMPLEMENT | Venue docs compare venues with each other and draw general lessons, against 'a doc is about its own subject' | F28 |
| DVEN-29 | low | docs-structure | DEFER | The venue docs share no structure in their Archives sections (template rewrite, CI link check) | F29 |

Counts: {'medium': 18, 'low': 11} / {'IMPLEMENT': 27, 'DEFER': 2}

## DVEN-01: Binance bookTicker endings: BINANCE.md and the 006-binance.ts docblock are wrong, the seed is right

- Severity: medium
- Category: docs-correctness
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F20
- Locations:
  - `docs/venues/BINANCE.md:166-169`
  - `services/prospector/src/database/migrations/006-binance.ts:9-13`
  - `services/prospector/src/database/migrations/seeds/binance/pattern.csv:2-5`
  - `services/prospector/src/database/migrations/seeds/README.md:150-152`

**Problem.**

BINANCE.md and the 006-binance.ts docblock say the last coin-margined bookTicker file is 2024-10-02, and that USDⓈ-margined bookTicker ends 2024-03-30 with no later monthly file. The seed retires CM daily bookTicker at 20241014, CM monthly at 202410 and UM monthly at 202404. The reviewer guessed the seed was the side in error. The verifier checked the live bucket and found the opposite.

**Evidence.**

Live bucket s3-ap-northeast-1.amazonaws.com/data.binance.vision:
- The last CM daily bookTicker file for BTCUSD_PERP, ETHUSD_PERP and ADAUSD_PERP is ...-bookTicker-2024-10-14.zip (BTCUSD_PERP is 15,294,609 bytes).
- The CM monthly series ends with BTCUSD_PERP-bookTicker-2024-10.zip.
- UM monthly BTCUSDT-bookTicker-2024-04.zip exists (37,761,761 bytes), although UM daily ends 2024-03-30.
- CM liquidationSnapshot daily ends 2024-10-14.
pattern.csv rows 1-4 (20240330, 202404, 20241014, 202410) therefore match the bucket.

**Fix.**

1. Do NOT change pattern.csv. The reviewer's suggestion to lower row 3 to 20241002 would stop 12 real days from being generated for any series created later.
2. Correct BINANCE.md L166-169 and the 006-binance.ts:9-13 docblock:
   - Coin-margined bookTicker and liquidationSnapshot both end 2024-10-14.
   - USDⓈ-margined bookTicker daily ends 2024-03-30, but the monthly tree has a 2024-04 file.
   - UM liquidationSnapshot (data3/) ends 2024-03-31. Re-check this one for a few symbols before writing it.
3. In BINANCE.md, give the endings as a small table: service x dataset x grain, last daily and last monthly, dated '(checked 2026-11)'.

**Tests.**

None. This is a docs and docblock change only. Leave pattern.csv untouched, and run the migration and seed test suites to confirm nothing changed.

**Verifier notes.**

Verifier (confirmed, medium): the disagreement is real, but the reviewer chose the wrong side. The bucket listing settles it in favour of the seed.

## DVEN-02: BITGET-SEED.md is a prospector seed doc filed under docs/venues, linked from nowhere, and stale against the seed and code

- Severity: medium
- Category: docs-placement
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F1
- Locations:
  - `docs/venues/BITGET-SEED.md:3`
  - `docs/venues/BITGET-SEED.md:31`
  - `docs/venues/BITGET-SEED.md:56`
  - `docs/venues/BITGET-SEED.md:81-91`
  - `docs/venues/BITGET-SEED.md:110-111`
  - `docs/venues/BITGET-SEED.md:129`
  - `docs/venues/BITGET-SEED.md:199-200`
  - `docs/venues/BITGET-SEED.md:217-221`
  - `services/prospector/src/database/migrations/seeds/seed.ts:184-199`
  - `services/prospector/src/adapters/bitget.ts:56-60`
  - `services/prospector/src/adapters/bitget/instruments.ts:130-132`
  - `services/prospector/src/database/migrations/seeds/README.md`

**Problem.**

The doc is about seed.ts, preamble, walkSeries, series_key, ruleOnSuccess, SEEDED_AT and categoryOf. It is a service doc in docs/venues, which breaks the dependency-direction rule, and it overlaps the seeds README. Nothing links to it. Four claims are false:
(a) `last` is said to be empty, but all 22,979 rows have a value.
(b) SEEDED_AT is said to withhold bitget, but seed.ts:199 has bitget '20260922'.
(c) The multi-part trades chain is said to be commented out, but expandParts in bitget.ts:56-60 is active.
(d) Discovery is said to read the v2 and v3 listings, but instruments.ts reads v3 only.

**Evidence.**

`awk -F, 'NR>1 && $4!=""' seeds/bitget/series.csv` counts 22979 of 22979 rows. seed.ts:199 reads `bitget: '20260922',`, with the comment 'Measured, not taken from the download index'. bitget.ts:57 is the expandParts first-part logic. instruments.ts:130 is `https://api.bitget.com/api/v3/market/instruments`. `grep -rn BITGET-SEED` finds no inbound link.

**Fix.**

1. Delete docs/venues/BITGET-SEED.md.
2. Add a `bitget` subsection to services/prospector/src/database/migrations/seeds/README.md, carrying only what is still true:
   - the measured floors, with the margins table;
   - the series set described as 'only what answered';
   - the transform kinds table;
   - the rebuilding procedure: getSymbolList crawl, then the getPublicDataV2 sweep.
3. State these points plainly in that subsection:
   - `last` is measured on every series.
   - SEEDED_AT for bitget is 20260922. Point to seed.ts instead of restating its docblock.
   - The multi-part chain is active (expandParts).
   - Discovery reads the v3 instruments endpoint only.
4. Drop the ruleOnSuccess history (L81-91) and the 'comes back when' future tense.
5. Correct the era-1/era-2 'content is the same' claim (L199-200) as in DVEN-09.
6. Move venue-only facts into BITGET.md if they are not already there:
   - index-offered keys that 403 (BLZ/USDT and WAVES/USDT, 1,113 files on the naming retired 2024-04-18);
   - the index going quiet on recent days before the archive does.
7. Run the anchor checker so no link to BITGET-SEED.md is left dangling.

**Tests.**

Run the docs anchor/link checker (scratch/anchors.py) and confirm no reference to BITGET-SEED. `grep -rn BITGET-SEED` should return nothing.

**Verifier notes.**

Verifier confirmed all four stale claims and downgraded the severity from high to medium, because the doc has no runtime effect. Do this first: DVEN-07, DVEN-08, DVEN-09 and DVEN-15 also mention BITGET-SEED.md. Send their seed-side edits to the seeds README instead.

## DVEN-03: BYBIT.md states a 30 req/s adapter rate and a 10-minute stand-down; the code uses 2000/s and 2 minutes

- Severity: medium
- Category: docs-correctness
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F2
- Locations:
  - `docs/venues/BYBIT.md:154-166`
  - `docs/venues/BYBIT.md:201-209`
  - `services/prospector/src/adapters/bybit.primary.ts:28-29`
  - `services/prospector/src/pace.ts:30-34`
  - `services/prospector/src/pace.ts:42-49`

**Problem.**

BYBIT.md says 'The adapter's figure is 30 requests a second, standing down 10 minutes' and that '30 is carried over'. bybit.primary.ts actually declares perSecond 2000 and concurrency 500, and STEADY.standDownMs is 2 minutes. No adapter overrides it. The surrounding paragraphs are service configuration and history (L154-159, 'Until the gate moved into the fetch...'), plus a description of the shared Pace (L206-209). pace.ts:31 repeats the stale '30' claim.

**Evidence.**

bybit.primary.ts:29 reads `pacing: { perSecond: 2000, concurrency: 500 },`. pace.ts:47 reads `standDownMs: 2 * 60_000,`.

**Fix.**

1. In BYBIT.md, delete:
   - L154-160: the history and the 'adapter's figure is 30' sentence.
   - L201-205: the bucket paragraph and '30 is carried over'.
   - L206-209: the Pace/fetch paragraph.
2. Keep the measured edge facts under one 'Limits' heading:
   - the 3,855-in-103-s block;
   - the 2026-10-07 table;
   - ban length about 5-10 minutes;
   - the ban covers public.bybit.com only;
   - requests with no User-Agent get a 403.
   Do not restate the bucket measurement, which L43-44 already holds; a one-line pointer is enough.
3. Add the pacing rationale to the bybit entry of PROSPECTOR.md (near ~L1573) if it is missing: the bucket is walked at 2000/s and the edge is never used for listing.
4. In pace.ts:30-31, replace 'as bybit does, having earned its 30' with a neutral note that each adapter's pacing docblock carries its own evidence.

**Tests.**

Comment-only change in pace.ts, so the existing prospector suite is enough. Afterwards, `grep -n '30 requests' docs/venues/BYBIT.md services/prospector/src/pace.ts` should return nothing.

**Verifier notes.**

Verifier confirmed. Severity downgraded from high to medium (docs and docblock only).

## DVEN-04: Claims that the CDN is never used contradict the shipped alternative_hosts and hauler's host rotation; OKX says a second address is unimplemented

- Severity: medium
- Category: docs-correctness
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F4
- Locations:
  - `docs/venues/BINANCE.md:116-118`
  - `docs/venues/GATE.md:37-40`
  - `docs/venues/HTX.md:206-213`
  - `docs/venues/OKX.md:503-506`
  - `services/prospector/src/database/migrations/001-core.ts:51-59`
  - `services/hauler/src/hosts.ts:7-11`
  - `docs/services/HAULER.md:207-216`

**Problem.**

These venue docs make service statements that are now false for downloading:
- BINANCE: 'nothing here goes through it'.
- GATE: 'addressed at its bucket for everything - listing, probing and downloading'.
- HTX: the heading 'Addressed at the bucket, not at the CDN' and the line 'so it is addressed directly'.
- OKX: 'a second address ... Nothing implements that yet'.
The core migration ships alternative_hosts for binance, gate and htx, and hauler spreads downloads over every address. The mechanism exists; okx's row is simply [].

**Evidence.**

001-core.ts:52 ships binance alternative_hosts `["https://data.binance.vision"]`. Gate (:56) has `["https://download.gatedata.org"]` and htx (:57) has `["https://www.htx.com/data"]`. hauler fetches GET /venues (catalog.ts:22-25), calls setHosts (index.ts:39), and hosts.ts:7-11 says 'every address is used'. Note that hosts.ts has 236 lines, so the reviewer's 303-342 range is wrong.

**Fix.**

1. BINANCE.md L116-118: replace with 'data.binance.vision is CloudFront in front of the bucket s3-ap-northeast-1.amazonaws.com/data.binance.vision: the same files byte for byte (MD5 = ETag on both); only the bucket answers the S3 listing API.' Confirm the last clause against the surrounding text first.
2. GATE.md L37: drop the 'for everything' sentence. Keep the CDN/bucket equivalence and the measured rates.
3. HTX.md L206: retitle to e.g. 'The bucket behind the Akamai edge'. Keep the edge-limit facts (403 AkamaiGHost after about six listing requests). Change 'so it is addressed directly' to 'and is public'.
4. OKX.md L503-506: drop the second-base and 'Nothing implements that yet' sentences. Keep 'objects are publicly readable at okg-pub-hk.oss-cn-hongkong.aliyuncs.com', with its prefix coverage (okex/traderecords and L2/, but not pro/L2/).
5. Check that PROSPECTOR.md (alternative_hosts, ~L1515) and HAULER.md ('Which address a file is fetched from', ~L207) say which address is used for what.

**Tests.**

None (docs). Run `grep -n 'nothing here goes through\|for everything\|Nothing implements' docs/venues/*.md`, which should return nothing.

**Verifier notes.**

Verifier confirmed. Listing and probing at the bucket are still true for prospector, but that belongs in service docs. Whether to add okx's OSS origin to alternative_hosts is a separate code decision and out of scope here.

## DVEN-05: OKX.md describes prospector behaviour that the code contradicts (bucket series, preopen, pacing, RATES_START)

- Severity: medium
- Category: docs-correctness
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F8
- Locations:
  - `docs/venues/OKX.md:39-42`
  - `docs/venues/OKX.md:76-78`
  - `docs/venues/OKX.md:372-376`
  - `docs/venues/OKX.md:816-833`
  - `docs/venues/OKX.md:827-828`
  - `docs/venues/OKX.md:858-863`
  - `services/prospector/src/database/migrations/seeds/okx/pattern.csv:34-43`
  - `services/prospector/src/adapters/okx/instruments.ts:150-168`
  - `services/prospector/src/adapters/okx.ts:29-30`
  - `docs/services/PROSPECTOR.md:2346`
  - `services/prospector/src/adapters/okx/shapes.ts:16`

**Problem.**

(a) The all* buckets are said to be 'never given a series', but the seed has 10 venue-wide patterns and 10 '@' series.
(b) preopen instruments are said to be 'dropped... not counted in any total'. In the code they are pushed with live=false and still count in `listed`.
(c) '120/s in use' is stated, but okx.ts declares 100/s.
(d) A RATES_START constant is cited that does not exist.
(e) The retire-on-first-404 rule and the test-pair name exclusion are described accurately, but they are service behaviour in a venue doc.

**Evidence.**

`grep -c ',@,' seeds/okx/series.csv` returns 10 (e.g. `43,@,,20260904,20211214`). instruments.ts:165-166 reads `live: is !== PREOPEN`. preamble.ts:112 skips non-live rows for discovery only. okx.ts:30 reads `perSecond: 100, concurrency: 100`. `grep -rn RATES_START` matches only OKX.md:375.

**Fix.**

docs/venues/OKX.md:
1. L39-42: delete from 'So they are never given a series' through 'costs one 404'. Keep the fact that each bucket exists as long as its dataset and that floors differ by market, minus the 'which is why each bucket takes' clause.
2. L76-78: delete. Keep L71-74 (what preopen means, the JP225 example) and L80-81.
3. L816-820: drop the 'in use' row. L831-833: drop 'and why 120 rather than 199' and keep the plain statement that an edge figure is not a venue constant.
4. L372-376: replace with 'The venue-wide daily borrowing file begins 2021-12-14 (the 13th answers 404).'
5. L827-828: delete.
6. L861-863: replace with 'Their state does not mark them: they are named by base, XTESTA-* in spot and margin and TEST002-* among futures families.'

docs/services/PROSPECTOR.md:
7. L2346: say that preopen instruments are listed as not live, so no series is created for them, but they still count in `listed`.
8. Add one okx line: venue-wide '@' series are seeded per bucket pattern; test pairs are refused by isTestPair (adapters/okx/shapes.ts).

**Tests.**

None (docs). `grep -n 'RATES_START\|120/s\|never given a series' docs/venues/OKX.md` should return nothing.

**Verifier notes.**

Verifier confirmed (a)-(d) as false and (e) as accurate but misplaced. PROSPECTOR.md already covers preopen (L2346) and okx pacing (L1751-1755), so most of the 'move' work is already done, apart from the L2346 correction.

## DVEN-06: OKX.md contradicts itself on book floors, day boundaries, the monthly window and what the instruments API lists

- Severity: medium
- Category: docs-consistency
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F9
- Locations:
  - `docs/venues/OKX.md:201`
  - `docs/venues/OKX.md:207-213`
  - `docs/venues/OKX.md:388-392`
  - `docs/venues/OKX.md:350-351`
  - `docs/venues/OKX.md:890-897`
  - `docs/venues/OKX.md:527`
  - `docs/venues/OKX.md:768`
  - `docs/venues/OKX.md:906-907`
  - `docs/venues/OKX.md:436-439`
  - `docs/venues/OKX.md:448-450`
  - `docs/venues/OKX.md:724-746`
  - `docs/venues/OKX.md:848-852`
  - `services/prospector/src/adapters/okx/instruments.ts:176-211`

**Problem.**

(1) The 400lv floor is given as ≤2023-04-03 at L201 and L207-213, but the launch table at L392 says 202309.
(2) L350-351 says book files are UTC days, but L892 says every day is UTC+8, with no exception.
(3) The monthly window is given three ways: '6 months' (L527), '~5 months' (L768), and '3 accepted / exactly 6 refused' (L906).
(4) L437-438 says the instruments API 'refuses to list contracts', and L448-450 says to 'use the portal's list'. Both contradict L731-746 and L844-845, and the code relies on v5 public/instruments listing FUTURES contracts with instFamily.

**Evidence.**

L392 reads `| 202309 | 400-level books launch | ...`. L201 reads `≤ 20230403`. stocker series.ts:824 says the book files cut at UTC midnight. instruments.ts:186 reads `one.instFamily || one.instId`, and :211 reads `instType=${market}`.

**Fix.**

docs/venues/OKX.md:
1. L392: replace the row with `| ≤2023-04 | 400-level books: futures chains from ≤2023-04-03, spot pairs from 2023-09 | 481 spot, then 169 the next month |`.
2. L892: 'A trades, candlestick or funding day or month is a UTC+8 one; book files are UTC days - see What a book file holds.'
3. Monthly window: state the measured facts once, in the L527 table: 'a 3-month span accepted, an exact 6-month span refused with 50077; the boundary between them is not measured.' At L768, write '≤5 months (assumed)' or drop the column. At L906-907, keep only the open question of where between 3 and 6 the window ends.
4. L436-439: 'FUTURES are listed by v5 public/instruments as contracts carrying instFamily (187 contracts in 161 families on 2026-08-28); the portal list returns families only. OPTION must be asked one underlying at a time: uly answers for all four underlyings, instFamily only for BTC-USD and ETH-USD.'
5. L448-450: delete, or replace with 'The archive names a dated chain by its instFamily.'

**Tests.**

None (docs). Afterwards, `grep -n 202309 docs/venues/OKX.md` should show no remaining claim that 202309 is the 400lv launch.

**Verifier notes.**

Verifier confirmed all four contradictions. It also corrected the reviewer's 'OPTION requires uly': the venue error reads 'Either parameter uly or instFamily is required'.

## DVEN-07: BITGET.md describes discovery from the v2 and v3 listings and the non-crypto refusal as catalog behaviour; the code reads v3 only

- Severity: medium
- Category: docs-correctness
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F16
- Locations:
  - `docs/venues/BITGET.md:656-681`
  - `docs/venues/BITGET.md:683-713`
  - `docs/venues/BITGET.md:370`
  - `docs/venues/BITGET.md:957-959`
  - `docs/venues/BITGET.md:965-970`
  - `services/prospector/src/adapters/bitget/instruments.ts:66-95`
  - `services/prospector/src/adapters/bitget/instruments.ts:130-132`
  - `services/prospector/src/adapters/bitget/shapes.ts:13-25`

**Problem.**

L661-663 says 'both are needed ... Eight v2 requests plus five v3 ones'. bitgetInstruments reads only v3, for four categories, in four requests. BITGET.md's own REST section shows that v2 and v3 COIN-FUTURES do not overlap, so v2-only instruments (BTCUSD, BTCUSDU26 and the S-prefixed demo types) are never discovered. L683-713 is service behaviour (bitgetInstruments, marketOf) and history ('categoryOf is gone', 'Those are gone too').

**Evidence.**

instruments.ts:130 reads `const INSTRUMENTS = 'https://api.bitget.com/api/v3/market/instruments';`. instruments.ts:132 reads `const CATEGORIES = ['SPOT', 'USDT-FUTURES', 'COIN-FUTURES', 'USDC-FUTURES']`.

**Fix.**

1. In BITGET.md, delete:
   - L656-681;
   - L683-713;
   - the 'These map to the catalog's refusal' sentence at L957-959.
2. Fix the L370 table row that links to the deleted anchor. Make it the venue fact: non-crypto is flagged by isRwa/isReality, and symbolType is unreliable for this.
3. Keep these venue facts:
   - the v2/v3 listing counts;
   - each API names only its own delivery contracts;
   - symbolType means different things in v2 and v3;
   - the trading-platform search returns symbolCode before any file exists;
   - the margin token cannot be read from the symbol.
4. In PROSPECTOR.md's bitget entry, state:
   - discovery reads v3 for SPOT, USDT-FUTURES, COIN-FUTURES and USDC-FUTURES only;
   - marketOf (shapes.ts) refuses non-crypto as tradfi;
   - marginToken comes from the category;
   - v2-only instruments (classic coin-margined, v2 delivery, demo types) are not discovered.
5. Apply the same v3-only correction to the seeds README bitget subsection (see DVEN-02).
6. File 'discover v2-only instruments' in docs/planning/ only if the owner wants it (see the owner question).

**Tests.**

None (docs). The anchor checker must show no link into the deleted 'what this catalog refuses' anchor.

**Verifier notes.**

Verifier confirmed. The doc fix is bounded. Whether v2 should be read is a design question for the owner. It does not block the doc fix, which only describes the current behaviour.

**Owner question.**

Should bitget discovery also read the v2 listings, so that v2-only instruments (classic coin-margined, v2 delivery contracts, demo product types) are found? If so, file it in docs/planning/. Not required for this doc fix.

## DVEN-08: BITGET.md 'Building the seed' is stale against the shipped seed and contradicts the same doc

- Severity: medium
- Category: docs-correctness
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F15
- Locations:
  - `docs/venues/BITGET.md:201-202`
  - `docs/venues/BITGET.md:219-226`
  - `docs/venues/BITGET.md:564-637`
  - `docs/venues/BITGET.md:608-623`
  - `services/prospector/src/database/migrations/seeds/bitget/series.csv:1`
  - `services/prospector/src/database/migrations/seeds/seed.ts:187-199`

**Problem.**

L566 reads 'This is in progress; the description will change', which is a plan. It also says 'three stages' and then lists four. The search-space table says `first` is never set and that `last` is 'the newest date the index claimed'. Both are wrong: the seed has a measured floor and a measured last. The per-era tip table (era 2 klines 20180601) contradicts the seed and L201-202. The section is also a second deep home for the seed mechanics.

**Evidence.**

The series.csv header includes `last,floor`. Floor histograms: pattern 15 has 234 series at 20240419, pattern 28 has 831 at 20240419, and pattern 14 has 557 at 20260818. No era-2 pattern has a floor below 20240419. seed.ts:188 reads 'Measured, not taken from the download index.'

**Fix.**

1. Delete BITGET.md L564-637 ('Building the seed' and 'Why the seed states shapes rather than sightings').
2. Before deleting, move these measured venue facts under the download-index subsection:
   - the index is complete for candlesticks;
   - it omits 0.27% of trades and 1.30% of depth;
   - it lists keys that do not exist;
   - it left out the instruments behind 585 series.
3. Replace L201-202 with: 'era-2 kline keys exist for 440 days before 2024-04-19 (237 perp, 203 spot); 417 duplicate era 1 and 23 are the only copy.'
4. Drop L219-226 (eraName mechanics). Any of it still needed goes to the seeds README bitget subsection (DVEN-02).

**Tests.**

Docs only. Sanity check: `awk -F, 'NR>1 && $4==""' seeds/bitget/series.csv | wc -l` (expect 0 or 1, per the two verifier counts).

**Verifier notes.**

Verifier confirmed, with one nuance: L201-202 is true, but it describes the seed, so it belongs in the seed doc. Its refined step 5 (fix BITGET-SEED.md) is superseded by DVEN-02, which deletes that file.

## DVEN-09: BITGET.md says era-1 and era-2 copies hold the same content, which BUGS.md contradicts; publication delay has two homes

- Severity: medium
- Category: docs-correctness
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F17
- Locations:
  - `docs/venues/BITGET.md:69-73`
  - `docs/venues/BITGET.md:196-199`
  - `docs/venues/BITGET.md:211-215`
  - `docs/venues/BITGET.md:639-654`
  - `docs/planning/BUGS.md:41-60`
  - `docs/venues/BITGET-SEED.md:199-200`
  - `docs/services/PROSPECTOR.md:476-487`

**Problem.**

'Where both are served the content is the same' is false. BUGS.md found that ten of 75 era-1 files are 22-byte empty archives whose era-2 copies are full-sized. Publication timing also appears twice in BITGET.md (L69-73 and L639-654) and once more in PROSPECTOR.md. L650-654 carries `probingLag: 4` (adapter content) and the cross-venue line 'slowest of the eight venues'.

**Evidence.**

BUGS.md:57-59 reads 'Ten of the 75 era-1 files are 22-byte archives with nothing in them... For ADAUSDT 2022-04-03 the venue answers 22 bytes at the era-1 path and 64,051 at the era-2 one.'

**Fix.**

1. BITGET.md L211-213: 'Where both are served they usually hold the same candles, but not always: some era-1 files are 22-byte empty archives whose era-2 key holds the full day (perp ADAUSDT 2022-04-03, BNBUSDT 2022-01-19 and 2022-05-18; ten of 75 pairs checked on 2026-10-07). How many era-1 kline files are empty has not been measured.'
2. Make the same correction in the seeds README bitget subsection (replacing BITGET-SEED.md:199-200; see DVEN-02). It may point to BUGS.md for the catalog impact.
3. Merge L69-73 and L639-649 into one 'Publication' subsection:
   - D+2 at about 03:00 UTC;
   - p50 51.0 h, p99 52.9 h, worst 53.0 h after the day begins, over 28,992 files of 2026-09-15..21;
   - keep the slip observed on 2026-08-21.
4. Delete L650-654 (probingLag; PROSPECTOR.md:476-487 already holds it) and the 'slowest by a factor of two' comparison.

**Tests.**

None (docs).

**Verifier notes.**

Verifier confirmed. The added wording must not claim more than BUGS measured: ten of 75, with prevalence not checked.

## DVEN-10: HTX.md contradicts itself on data/ headers and on whether the nine untaken instruments are kept

- Severity: medium
- Category: docs-consistency
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F13
- Locations:
  - `docs/venues/HTX.md:151-158`
  - `docs/venues/HTX.md:318-349`
  - `docs/venues/HTX.md:369-374`
  - `docs/venues/HTX.md:433-453`
  - `services/stocker/src/schema/series.ts:585-596`
  - `docs/services/PROSPECTOR.md:941-970`

**Problem.**

HTX.md contradicts itself twice.
- Headers: L152-153 says the earliest data/ indexPrice files have a header `id,open,close,high,low`. L156 says data/ had no header at all until 2026-03/04. Stocker found both patterns among files of the same years.
- The nine instruments: L341-349 says leave them refused, while L369 calls the first five 'worth taking'.
L372-374 is unverified hearsay. L158 ('off by one') is misleading advice.

**Evidence.**

series.ts:587-588: ADA210702 (2021-07-02) has a header; BTC-USDT-230714 (2023-07-14) has none. L156: 'data/ carried no header row at all until between 2026-03-01 and 2026-04-01'.

**Fix.**

1. Replace L151-158 with one dated table, 'data/ header rows' (dataset/market, era, header):
   - early spot klines: none;
   - some early indexPrice and dated-future markPrice files: `id,open,close,high,low`; others of the same years: none (cite the ADA210702 and BTC-USDT-230714 examples);
   - 2026 files: `timestamp,...`;
   - every file from between 2026-03-01 and 2026-04-01: a header.
   Drop the 'off by one' advice.
2. Move the take-or-refuse reasoning (L318-349, L433-453) to PROSPECTOR.md under the htx accepts entry (L941-970). Hold the code's position there: refused.
3. Keep these in HTX.md under 'Coverage: the two trees':
   - the nine symbols with their trade days and bytes;
   - they end by 2026-08-03;
   - the 63 indexPrice series-days of 2026-06-03;
   - the 64 dead symbols;
   - the atomic-migration measurements.
   Remove 'worth taking'.
4. L372-374: re-check REST klines and trades for one of the nine and state the result with a date, or delete the passage.
5. Update PROSPECTOR.md:952's anchor `HTX.md#where-to-stop-reading-data` (coordinate with DVEN-14 and DVEN-21).

**Tests.**

None (docs). The anchor checker must show PROSPECTOR.md:952 resolving.

**Verifier notes.**

Verifier confirmed. There is no data impact, because stocker reads by position with header:false.

## DVEN-11: Venue facts that consumers rely on have no venue-doc home: publication delay, file headers and columns, Kraken

- Severity: medium
- Category: docs-coverage
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F26
- Locations:
  - `docs/services/PROSPECTOR.md:470-490`
  - `docs/venues/BINANCE.md:11-26`
  - `docs/venues/KUCOIN.md:1-68`
  - `services/stocker/src/formats/csv.ts:9-21`
  - `services/stocker/src/formats/lines.ts:5-9`
  - `services/stocker/src/schema/series.ts:492-527`
  - `services/hoarder/src/venues/kraken.ts:1-18`
  - `services/prospector/src/adapters/kucoin.ts:23-24`

**Problem.**

Three kinds of venue fact live only in consumer docs or code.
- Publication delay per venue (p50/p99, measured 2026-09-25) is only in PROSPECTOR.md. BINANCE.md:26 even says the daily cadence is unverified.
- Archive file formats are only in stocker docblocks:
  - Binance spot files have no header;
  - nine Binance futures datasets gained a header between 2021-01 and 2022-07;
  - Bybit added RPI/rpi columns in 2025-04;
  - KuCoin books are JSON lines in a .csv, under a one-word header;
  - KuCoin trades carry trade_id/trade_time, and futures sizes are contract counts.
- Kraken is a live hoarder venue with no docs/venues/KRAKEN.md.
Also, series.ts:506-507 claims KuCoin spot klines' close-before-high order is 'unlike every other venue here', which is false: gate and htx share it.

**Evidence.**

PROSPECTOR.md:476-484 holds the p50/p99 table (binance p50 32.0 h). BINANCE.md:26 reads 'Neither is verified here'. `grep -ri kraken docs` returns nothing. series.ts:100 gives gate as `rawTs, volume, close, high, low, open`, and :126/:137 give htx as `open, close, high, low`.

**Fix.**

1. series.ts:506-507: 'Spot klines are open, close, high, low - close before high, unlike KuCoin's own futures klines below.'
2. Add a 'Publication' subsection to each venue doc's Archives section with that venue's p50/p99 hours from the start of the day, plus the measurement date and window (2026-09-25, files of 2026-09-15..21).
3. BINANCE.md:26: the daily claim is measured (p50 32.0 h, p99 33.6 h); the first-Monday monthly claim is not.
4. Trim PROSPECTOR.md:470-484 to the probingLag rule and a per-venue probingLag table, pointing to the venue docs for the delays.
5. Add archive file-format facts:
   - BINANCE.md: spot headerless; the nine futures datasets that grew a header, and when.
   - KUCOIN.md: trade_id/trade_time; futures size as a contract count; books as JSON lines under a one-word header; the kline column order.
   - BYBIT.md: RPI/rpi appended in 2025-04.
6. Create docs/venues/KRAKEN.md with a WebSocket section, restating kraken.ts:1-18 as venue facts: the endpoint wss://ws.kraken.com/v2, frame shapes, status on connect, heartbeat, and rejection of unknown channels. Trim the docblock to point at it by file.

**Tests.**

Comment-only code changes: keep the stocker and hoarder suites green. Run the anchor checker for any new links.

**Verifier notes.**

Verifier confirmed every part. Only the measurement moves out of PROSPECTOR.md; the probingLag column is consumer content and stays.

## DVEN-12: BYBIT.md contradicts itself on funding and open-interest history, states the same limits twice, and documents prospector mechanics

- Severity: medium
- Category: docs-consistency
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F22
- Locations:
  - `docs/venues/BYBIT.md:516-520`
  - `docs/venues/BYBIT.md:407-436`
  - `docs/venues/BYBIT.md:142-148`
  - `docs/venues/BYBIT.md:368-379`
  - `docs/venues/BYBIT.md:10-13`
  - `docs/venues/BYBIT.md:29-35`
  - `docs/venues/BYBIT.md:46-48`
  - `docs/venues/BYBIT.md:55-61`
  - `docs/venues/BYBIT.md:84-85`
  - `docs/venues/BYBIT.md:98-100`
  - `docs/venues/BYBIT.md:121`
  - `docs/venues/BYBIT.md:224-226`
  - `docs/venues/BYBIT.md:233`
  - `docs/venues/BYBIT.md:245-253`
  - `docs/venues/BYBIT.md:267-278`
  - `docs/venues/BYBIT.md:295-306`
  - `docs/venues/BYBIT.md:453-458`
  - `docs/venues/BYBIT.md:483-495`

**Problem.**

- Contradiction: the WebSocket section says tickers is the only source of OI and funding, and that REST history is 'not established'. The REST section of the same doc establishes it (funding back to BTCUSD 2018-11-15, OI back to 2020-08-05).
- Duplication: the api.bybit.com limit appears twice; the depth change appears twice; the instrument listing appears twice.
- Misplaced content: many service sentences (scanner, dateOf, {MONTH_LAST_DAY}, accepts, venue rows, probing).

**Evidence.**

L519-520: 'Whether the REST API serves their history ... is not established.' L420: 'Reaches the first funding: BTCUSD 2018-11-15T00:00Z'.

**Fix.**

1. L516-520: 'tickers carries mark and index price, open interest and its value, and the funding rate with its cap, interval and next time in one payload. The archive holds only premium-index and spot-index klines; the history of the rest is on REST (see Funding, Open interest, Mark/index/premium bars).'
2. L142-148: keep the archive facts (CloudFront answers with its own HTML 403 page, names no key, and gives no budget in any header). Replace the api.bybit.com numbers with a pointer to REST > Its limits.
3. Move 'The host carries linear/ and inverse/ and no third market' from L98-100 into 'A second host: the order books' (~L245). Delete the rest of L98-100.
4. Merge L453-458 into 'The instrument listing' (L483-495).
5. Remove the service sentences at L12-13, L34-35, L46-48, L55-56, L58-61, L84-85, L121, L233, L246-253, L262-265, L267-269, L278, L295 and L305-306. Where a bare venue fact exists, keep it:
   - the hosts are separate servers with different trees and limiters;
   - path-style addressing is required, because the TLS certificate does not cover the dotted bucket name;
   - a missing key on quote-saver answers 404 with no Content-Length;
   - the host speaks HTTP/2.
6. L154-209: handled by DVEN-03. Keep the measured edge behaviour; move the limiter and Pace content to PROSPECTOR.md.

**Tests.**

None (docs). The anchor checker must show PROSPECTOR.md's BYBIT anchors (#the-2021-expiries-are-abandoned-and-are-refused, #the-misfiled-file) still resolving.

**Verifier notes.**

Verifier confirmed. It warned that deleting all of L142-148 or all of L98-100, as first suggested, would lose venue facts; the refined fix keeps them. PROSPECTOR.md already covers bybit's two hosts (L91), HTTP/2 (L1625-1636), {MONTH_LAST_DAY} (L2428) and the refusals (L947-949).

## DVEN-13: OKX.md is built around the history of the walks and full of plans; the module-6 material is in the wrong section; a link is broken

- Severity: medium
- Category: docs-history
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F10
- Locations:
  - `docs/venues/OKX.md:12-13`
  - `docs/venues/OKX.md:64-67`
  - `docs/venues/OKX.md:83-91`
  - `docs/venues/OKX.md:120-126`
  - `docs/venues/OKX.md:207-219`
  - `docs/venues/OKX.md:367-370`
  - `docs/venues/OKX.md:378-475`
  - `docs/venues/OKX.md:496`
  - `docs/venues/OKX.md:575-582`
  - `docs/venues/OKX.md:606-609`
  - `docs/venues/OKX.md:630-633`
  - `docs/venues/OKX.md:640-693`
  - `docs/venues/OKX.md:711`
  - `docs/venues/OKX.md:762-810`
  - `docs/venues/OKX.md:869-879`
  - `docs/venues/OKX.md:899-903`
  - `docs/venues/OKX.md:905-921`

**Problem.**

- History framing: L12, L65-67, L215-219, the whole L378-475 walk section, L630-633, L649-651.
- Plans and relative time: L369 and L917 ('in a few weeks', from measurements made in 2026-08).
- Service advice: L83-91, L606-609, L762-810 (sweep cost model), L869-879.
- Structure: the module-6 heading is almost empty, while its material sits under '`pro/` is a different host'. 'Candlestick files can repeat rows' sits under 'Periods are UTC+8'.
- A broken anchor at L711.
- L121 claims Binance is the only venue that publishes integrity data, which KuCoin's .CHECKSUM and the MD5 ETags contradict.

**Evidence.**

The anchor checker reports MISSING ANCHOR at OKX.md:711 (#ranges-are-cheap-here-and-expensive-on-bitget). L917 reads 'The same walk repeated in a few weeks settles it'. KUCOIN.md:13 reads '.CHECKSUM sits beside every archive'.

**Fix.**

Mechanical (do first):
1. L711: repoint to #ranges-and-why-the-monthly-sweep-is-how-to-get-them, and drop the 'expensive on bitget' text.
2. L120-121: 'Sizes are an integrity check: the index reports each file's size in MB.'
3. L640-647: see DVEN-20.
4. Move L656-693 under the module: 6 heading (L575). Delete L662.
5. Give 'Candlestick files can repeat rows' (L899-903) its own #### heading next to the candlestick section (~L312).

Rewrites:
6. Delete L12-13.
7. L65-67: delete, except 'asking for the plain name on a futures family returns the spot pair's file'.
8. L215-219: delete, except 'a floor measured from one symbol is that symbol's floor'.
9. Delete L606-609, L630-633 and L649-651. A single probe cannot tell a wrong prefix from a wrong date; keep that only as a venue fact.
10. L762-810: delete. Move the fact that history-candles bar=1M limit=100 returns 100 months into REST.
11. Delete L496's 'Nothing implements that yet' sentence (see DVEN-04).
12. Rewrite L378-475 as present-tense, dated venue facts under 'What the archive holds (walked 2026-08-16/17)':
    - the launch table, with the 400lv row corrected per DVEN-06;
    - the 202511 and 202603 mass listings;
    - delisting ends every dataset of a symbol together;
    - universe counts by market;
    - every active symbol has data in every dataset its market publishes;
    - zero-volume candles continue for dead pairs;
    - _UM_XPERP/_UM families publish only under -futureschain-.
    Drop every 'our fault', 'called fictional' and 'once recorded' sentence.
13. L905-921: keep the open questions, each with its last-checked date, and no 'in a few weeks'. Move the planned re-walk to docs/planning/CATALOG.md.
14. L869-879: delete, or reduce to one line.

**Tests.**

Run the anchor checker over OKX.md and its inbound links from PROSPECTOR.md: no MISSING ANCHOR. `grep -n 'in a few weeks\|our fault' docs/venues/OKX.md` should return nothing.

**Verifier notes.**

Verifier confirmed, but warned that the reviewer's 'delete L378-475 except two facts' would lose dated venue facts. The refined rewrite keeps them. Overlaps DVEN-19 (L662), DVEN-20 (L640-647) and DVEN-26 (L711).

## DVEN-14: HTX.md frames venue facts around catalog decisions and carries plans and stale relative time

- Severity: medium
- Category: docs-placement
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F14
- Locations:
  - `docs/venues/HTX.md:49-72`
  - `docs/venues/HTX.md:83-93`
  - `docs/venues/HTX.md:110-113`
  - `docs/venues/HTX.md:199-204`
  - `docs/venues/HTX.md:222-226`
  - `docs/venues/HTX.md:243-251`
  - `docs/venues/HTX.md:268-273`
  - `docs/venues/HTX.md:305-316`
  - `docs/venues/HTX.md:318-453`
  - `docs/VOCABULARY.md:31-38`

**Problem.**

- Service internals: url_symbol storage, 'the option market is never asked' (which is also misleading: htx.ts:133 maps option), 'the walk that measured them', 'the adapter asks it of both', the survey-root rule, 'declarative spill handling', 'granularity cutover', and the whole of 'Where to stop reading data/'.
- Plans and stale time: 'may still backfill', 're-read a prefix', 'nearly seven months on', 'worth settling'.
- L305-316 raises a modelling question VOCABULARY.md has already answered.
- L247 frames HTX against OKX.

**Evidence.**

L243-244: 'it belongs in the declarative spill handling'. L72: 'which is why the option market is never asked'. VOCABULARY.md:35: a kline's interval is a variant. htx.ts MEANINGS models index-klines as binned indexPrice.

**Fix.**

1. L49-72: keep the naming facts:
   - the spelling table;
   - every historical_data/ perpetual key carries -PERP and no dated key does;
   - spot pairs split on the longest of 26 quote currencies (USDTRUB/EUROC examples);
   - coin-margined dated contracts imply USD;
   - a six-digit option strike can read like an expiry.
   Delete the url_symbol and storage sentences, L68-69, and 'option market is never asked'.
2. L83-93: 'data/'s last write is 2026-08-04 (announced)'; 'funding reaches back to 2026-02-01 and books to 2026-05-28, both before the 2026-06-03 upgrade'; 'historical_data/ still held 2026-02-01 on <date>'. Delete the re-read advice.
3. L112: delete 'the walk that measured them...' and keep the T-USDT evidence. L204: delete 'and the adapter asks it of both'.
4. L222-226: delete (PROSPECTOR.md:950 holds it).
5. L243-245: keep only 'The date in a path is a UTC+8 day label.'
6. L247: retitle to 'Order books: 400 levels spot, 150 futures' and drop the OKX comparison.
7. L272-273: 'Only daily files exist in either tree; there is no monthly tree.'
8. L305-316: 'Mark and index prices are published as klines under mark-klines/ and index-klines/ directories carrying an interval.'
9. L318-453: as in DVEN-10.

**Tests.**

None (docs). `grep -nE 'adapter|accepts|preamble|catalog|url_symbol|spill' docs/venues/HTX.md` should leave only pointer uses. The anchor checker must show PROSPECTOR.md:952 resolving.

**Verifier notes.**

Verifier confirmed. Refinement: keep the -PERP naming fact and the 'mark/index published as klines' fact.

## DVEN-15: BITGET.md Archives section names prospector and stocker internals throughout; its concurrency figure disagrees with the code

- Severity: medium
- Category: docs-placement
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F18
- Locations:
  - `docs/venues/BITGET.md:27-35`
  - `docs/venues/BITGET.md:53-62`
  - `docs/venues/BITGET.md:80`
  - `docs/venues/BITGET.md:103-106`
  - `docs/venues/BITGET.md:111`
  - `docs/venues/BITGET.md:161-162`
  - `docs/venues/BITGET.md:219-226`
  - `docs/venues/BITGET.md:245-250`
  - `docs/venues/BITGET.md:480-486`
  - `docs/venues/BITGET.md:514-521`
  - `docs/venues/BITGET.md:533-536`
  - `docs/venues/BITGET.md:553-558`
  - `services/prospector/src/adapters/bitget.ts:30-50`
  - `docs/services/PROSPECTOR.md:1843-1844`

**Problem.**

The Archives section names service internals throughout: the refusesUs/ruleOnFailure hooks, 'by prospector itself', 'what the adapter declares', 'prospector probes it that way', stocker's spill:'back', 'the series map', 'the unreadables', the eraName/archiveDir transforms, the regex placeholder, catalog guarantees, seed depths, 'the sweep now sends' (history) and a rejected design (L103-106). Concurrency also disagrees three ways: BITGET.md says 600 in flight, bitget.ts declares 500, and PROSPECTOR.md:1843 says 'the same 600'.

**Evidence.**

L33 reads 'prospector's refusesUs and ruleOnFailure hooks rest on it.' bitget.ts:31 reads `pacing: { perSecond: 2500, concurrency: 500 },`.

**Fix.**

1. Rewrite each passage as a venue fact:
   - L27-35: 'A 403 with server: AmazonS3 means no such key; a 403 or 503 from the CloudFront edge under its own server is a refusal.'
   - L53-57: 'CloudFront answers 503 x-cache: LimitExceeded near 2,900 HEAD/s at 500 in flight; 2,500/s capped held ~2,300/s without refusal (2026-09-30).'
   - L61-62: end at 'over HTTP/2 a probe is a stream and the question does not arise'.
   - L80: drop the Stocker sentence. Keep 'The file named D covers D-1 16:00 to D 16:00 UTC'.
   - L111: '-999999 means no quote'.
   - L161-162: 'No single-symbol shape reads them.'
2. Delete L103-106, L219-226, L248-250 after 'never contains an underscore', L480-486, L514-521, L533-536 and L557-558.
3. Move what PROSPECTOR.md does not already cover (the transforms, the ten depth spellings, the uniqueness rule for generated keys) to the seeds README bitget subsection (DVEN-02). Do not use BITGET-SEED.md, which is deleted.
4. Correct PROSPECTOR.md:1843-1844 to the declared concurrency of 500. The code is the truth; do not change bitget.ts here.

**Tests.**

None (docs).

**Verifier notes.**

Verifier confirmed. Most of the service content already has a home: refusesUs at PROSPECTOR.md L143/L2728, size-threshold rejection at L2976, pacing at L1843, and the 16:00 cut at STOCKER.md:684. So this is mostly deletion. The verifier left the 500 vs 600 question to the owner. The consolidator resolved it as 'document what the code declares (500)'; changing the code would be a separate decision.

## DVEN-16: BINANCE.md mixes catalog design, waste figures and cold-storage state into the venue description

- Severity: medium
- Category: docs-placement
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F19
- Locations:
  - `docs/venues/BINANCE.md:33-35`
  - `docs/venues/BINANCE.md:43-46`
  - `docs/venues/BINANCE.md:59-63`
  - `docs/venues/BINANCE.md:80-104`
  - `docs/venues/BINANCE.md:110-128`
  - `docs/venues/BINANCE.md:161-162`
  - `docs/venues/BINANCE.md:175-177`
  - `docs/venues/BINANCE.md:189-196`
  - `docs/venues/BINANCE.md:207-211`
  - `docs/venues/BINANCE.md:264-271`
  - `docs/venues/BINANCE.md:280-282`
  - `docs/venues/BINANCE.md:309-316`
  - `docs/venues/BINANCE.md:320-332`
  - `docs/venues/BINANCE.md:568`

**Problem.**

BINANCE.md carries service content throughout: tagOf, the .CHECKSUM exclusion, categoryOf/preamble/instruments hook, survey root and refusals, 'seeded retired', the accepts 55% waste, deleted rows and series, Node connection and retry behaviour, and 'catalogued by prefix walks'. It also has:
- a plan: L59-63, 'Worth using when in-place changes start mattering';
- history: 'Left unfiltered this cost real work', 'This also corrects an earlier note';
- this repo's download order and cold storage, in the future tense (L324-332);
- a consumer framing of the WebSocket survey (L568).

**Evidence.**

L330-332: 'It becomes evictable as the month-first flow closes those months one at a time.' L59: 'This is the only venue here that tells us which already-published files changed.'

**Fix.**

1. Cut or reword the listed passages.
2. Keep these venue facts:
   - UM and CM are separate services and archive keyspaces, and each contract is domiciled in one;
   - marginAsset and the ticker do not separate them (ETHBTC; 43 UM symbols ending in USD);
   - the CM/UM counts, with a date;
   - data2/ is staging, and data3/liquidationSnapshot holds the only UM liquidation snapshots;
   - the /-prefixed tree is a 2021-01-12 snapshot holding strictly less than data/spot/monthly;
   - the 1w/3d/1mo trees stop on 2023-06-12 for futures daily, end per symbol for spot monthly, and never existed for spot daily;
   - the /updates correction packages;
   - the S3 listing semantics and the measured rate table.
3. Move the categoryOf/preamble handling, the survey-root rule, the accepts refusals and their cost figures to PROSPECTOR.md's binance entry. Check for an existing home first.
4. Move the Node happy-eyeballs/retry note to PROSPECTOR.md's HTTP section if it is not already there.
5. Move L324-332 to docs/tooling/COLD.md in the present tense if it is still true; otherwise delete it (see the owner question).
6. Move L59-63 to docs/planning/CATALOG.md.
7. L568: 'Verified live on 2026-07-26.'
8. L33-35 (tagOf): see DVEN-23.

**Tests.**

None (docs).

**Verifier notes.**

Verifier confirmed. The risk is losing measured venue facts while cutting; use the keep-list above.

**Owner question.**

Is BINANCE.md L324-332 ('Its raw cannot be reclaimed yet' / month-first eviction) still true? If yes, it moves to docs/tooling/COLD.md in the present tense; if not, delete it. The rest of this item does not wait on the answer.

## DVEN-17: GATE.md carries catalog mechanics, stocker behaviour, waste history and a REST-collector plan

- Severity: medium
- Category: docs-placement
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F23
- Locations:
  - `docs/venues/GATE.md:32-35`
  - `docs/venues/GATE.md:42-45`
  - `docs/venues/GATE.md:162-164`
  - `docs/venues/GATE.md:193-198`
  - `docs/venues/GATE.md:215-265`
  - `docs/venues/GATE.md:306-323`
  - `docs/venues/GATE.md:333-337`
  - `docs/venues/GATE.md:348-357`
  - `docs/venues/GATE.md:370`
  - `docs/venues/GATE.md:388-391`
  - `docs/venues/GATE.md:429-436`
  - `docs/venues/GATE.md:440-451`
  - `docs/services/PROSPECTOR.md:941-969`
  - `docs/services/PROSPECTOR.md:2954-2974`
  - `docs/services/STOCKER-PARTITIONS.md`

**Problem.**

GATE.md mixes four kinds of content into the venue doc:
- History: 'cost years of probing', 'read as unpublished until...', and the 312,336-of-323,229 probes figure.
- Prospector mechanics: 'What the catalog places' and 'What is refused' (expandParts, accepts, exclusion table), 'seeded as retired', misfiled.ts, the tradfi log signature.
- Stocker behaviour: the wide-file refusal, 'zero length as empty', unit inference, the plausibility guard.
- A REST-collector plan (L430-436).
The refusals and the width rule now have two homes (PROSPECTOR.md:941-969, STOCKER-PARTITIONS.md:49/373).

**Evidence.**

L431: 'this is the concrete item for when the REST collector covers gate.' L217: 'Prospector reads a series pattern out of the path.'

**Fix.**

1. MOVE, do not delete, the mechanics in L215-265, L320-323, L348 and L350-357 into PROSPECTOR.md's gate material. Merge with what is already there (L941-969 and L2954-2974), including:
   - the misfiled.ts closed list;
   - the literal-month shapes seeded retired (20221130, 20240630..20241130);
   - the 2026-09-27 probe-cost figure, as the reason those shapes are retired.
2. Do the same for the tradfi handling (L193-198).
3. Keep in GATE.md under Layout/Known defects:
   - books are 24 hourly files per day within a daily directory;
   - spot_index and options_ticker are files named by Unix instant, at 3,600 s and 60 s steps, venue-wide;
   - 2022-11-30 hour 23 of three book trees is filed under 202212 and is the only copy;
   - for spot candlesticks 30s/1m/5m of 2024-07..12, the previous month's last day is filed in the next month: 61,884 of 62,208 are byte-identical and 324 are the only copy; the misfiling stopped 2024-12;
   - tradfi status is the exchange session: closed outside 14:30-21:00 UTC.
4. Delete the stocker sentences (L388-391, L442, L447-448, L451), after checking that STOCKER-PARTITIONS.md holds each one.
5. Move L430-436 (SUN_USDT REST item, sweep proposal) to docs/planning/REST.md under Gate. Keep the venue fact: 2021-08 and 2021-09 answer 404 while the perp traded.
6. Delete L32-35, the clause at L163-164, and L336-337 (after step 1).
7. Check inbound anchors (DVEN-26).

**Tests.**

None (docs). The anchor checker must show PROSPECTOR.md's GATE.md anchors resolving.

**Verifier notes.**

Verifier confirmed, and corrected the reviewer's fix: misfiled.ts, the retired literal-month patterns and the tradfi session handling have no service-doc home yet, so deleting them would lose them. Move them.

## DVEN-18: Per-venue REST facts have three homes: the venue docs, docs/REST.md and docs/planning/REST.md

- Severity: medium
- Category: docs-duplication
- Decision: DEFER
- Source finding: docs-venues:docs F27
- Locations:
  - `docs/REST.md:20-200`
  - `docs/planning/REST.md:1-17`
  - `docs/planning/REST.md:232-311`
  - `docs/venues/BINANCE.md:334-564`
  - `docs/venues/BYBIT.md:348-495`
  - `docs/venues/KUCOIN.md:70-209`
  - `docs/venues/HTX.md:455-601`

**Problem.**

planning/REST.md:12-14 declares the venue docs the home for REST facts. Even so, docs/REST.md restates the per-venue hosts, limits, refusals and paging (including a limits table at L190-200), and planning/REST.md's 'The API' and 'Behaviour' bullets go deep again, nearly verbatim (Bybit: 600/5 s, 403 text, 30 s, start=1). Within venue docs, the listings are also written twice: KUCOIN.md L197-201 and L203-209; HTX.md L572-578 and L580-601; BINANCE.md L433 and L486 against L543-564.

**Evidence.**

REST.md:195 `| bybit | 600 calls / 5 s, whole host | nothing | 403 | under 30 s |` duplicates BYBIT.md:370-374.

**Fix.**

Bounded part (can be done now):
1. In KUCOIN.md, HTX.md and BINANCE.md, merge each pair of listing sections into one 'The listings' subsection: endpoint, fields, whether it states an ending, and how names map to archive paths.
2. In BINANCE, remove the per-service listing bullets that repeat the table, and add a cost column to keep the cost figures.

Owner decision (the rest):
3. Either (a) cut docs/REST.md to the cross-venue depth table (L16-35) plus one link per venue, or (b) merge docs/REST.md into planning/REST.md.
4. Separately, drop planning/REST.md's per-venue 'The API' and 'Behaviour' bullets that restate venue-doc facts, keeping sizing, verdicts and links.

**Tests.**

None (docs). Run the anchor checker afterwards.

**Verifier notes.**

Verifier confirmed the duplication and recommended DEFER for the doc-level restructure. A comparison/sizing doc is legitimately planning; docs/REST.md's per-venue prose is the excess. The listing merges are bounded and may be done now.

**Owner question.**

Should docs/REST.md be cut to the cross-venue depth table plus links, or merged into docs/planning/REST.md? Also confirm that planning/REST.md's per-venue 'The API'/'Behaviour' bullets can be reduced to links into the venue docs.

## DVEN-19: OKX.md contradicts itself on the module numbering

- Severity: low
- Category: docs-consistency
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F7
- Locations:
  - `docs/venues/OKX.md:133-141`
  - `docs/venues/OKX.md:154-163`
  - `docs/venues/OKX.md:185-186`
  - `docs/venues/OKX.md:662`
  - `docs/venues/OKX.md:1076-1079`

**Problem.**

The module table and L160 put borrowing rates on module 11, and give the set as 1-6 plus 11. L156-158 retracts '5 = borrowing rates', yet L185 still says 'module: 5 takes instQueryParam.ccyList'. L662 says 'module 7 ... six is the ceiling', contradicting L160 and L1077. L156-158 is also history.

**Evidence.**

L141: `| 11 | borrowing rates | Spot only |`. L185: 'So module: 5 takes instQueryParam.ccyList'. L662: 'so six is the ceiling.'

**Fix.**

1. L185: change module: 5 to module: 11.
2. L662: delete (it is also removed by DVEN-13 step 4).
3. L154-158: keep 'The numbering is sparse: 7 through 10 answer 51000 Parameter module error while 11 serves borrowing rates, so a module that errors says nothing about the next one.' Delete the 'Two claims in this file were wrong...' sentence.
4. Keep L160 as the fact: 'Swept 7 to 40: only 11 answers; the set is 1-6 and 11.'

**Tests.**

None (docs). Run `grep -n 'module: 5\|six is the ceiling' docs/venues/OKX.md`; the only hit should be the table's own row for module 5.

**Verifier notes.**

Verifier confirmed and downgraded the severity to low. The prospector okx adapter does not use module, but a reader building a request from L185 would get it wrong.

## DVEN-20: OKX.md's ETag-case warning is obsolete and links to a file that does not exist

- Severity: low
- Category: docs-correctness
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F6
- Locations:
  - `docs/venues/OKX.md:640-647`
  - `services/prospector/src/etag.ts:1-19`
  - `docs/services/PROSPECTOR.md:2118`

**Problem.**

OKX.md says two prospector ETag comparisons are case-sensitive, and links queries.ts:1035 and api/routes.ts:433. etagOf already lower-cases every ETag, and every ingress uses it. queries.ts:1035 is an unrelated UPDATE, and api/routes.ts does not exist. A venue doc should not cite service line numbers in any case.

**Evidence.**

etag.ts:15-19 lower-cases. It is used in scanners/pages.ts:30, scanners/html.ts:83, probe.ts:667, reports.ts:52 and okx/instruments.ts. `ls services/prospector/src/api/` lists collector, index, lenses and reports only. PROSPECTOR.md:2118 already says the comparison is case-blind.

**Fix.**

Replace L640-647 with: 'The ETag case differs by origin: Alibaba OSS answers the MD5 uppercase and S3 lowercase, for the same bytes. It is a serving artifact, not a difference in the object.' Remove both code links and the normalising advice.

**Tests.**

None (docs). The anchor checker must report no MISSING FILE at OKX.md.

**Verifier notes.**

Verifier confirmed and downgraded the severity to low. Also covered in DVEN-13's mechanical list; do it once.

## DVEN-21: HTX.md says 'the preamble states the tree's end', which contradicts migration 002, the code that applies it

- Severity: low
- Category: docs-correctness
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F12
- Locations:
  - `docs/venues/HTX.md:447-453`
  - `services/prospector/src/database/migrations/002-htx.ts:5-25`
  - `services/prospector/src/database/migrations/seeds/htx/pattern.csv:1-91`
  - `services/prospector/src/adapters/htx.ts:25-28`
  - `docs/services/PROSPECTOR.md:952`

**Problem.**

HTX.md says the preamble retires the patterns and gives each series its own last day. In fact migration 002 seeds the 90 data/ patterns with retired_at 20260804; its docblock says it replaced a per-startup pass. No code gives each series a last day, and the htx seed has no series.csv. This is a service mechanism in a venue doc, and it is described wrongly.

**Evidence.**

`cut -d, -f7 seeds/htx/pattern.csv | sort | uniq -c` returns `90 20260804`. 002-htx.ts:19-21: 'This replaced a pass that ran on every startup...'. htx.ts MIGRATED = '20260201'.

**Fix.**

1. Delete HTX.md:447-453.
2. Next to the htx row at PROSPECTOR.md:952, add: 'The end of data/ is catalog state: migration 002 (database/migrations/002-htx.ts) seeds the 90 data/ patterns with retired_at 2026-08-04, so no new series is created on them and generation stops at that day; accepts (htx.ts, MIGRATED) refuses data/ keys dated 2026-02-01 or later as they are listed.'
3. Update PROSPECTOR.md:952's link to HTX.md#where-to-stop-reading-data to wherever the overlap facts land (DVEN-10/DVEN-14).

**Tests.**

None (docs). The anchor checker must show PROSPECTOR.md:952 resolving.

**Verifier notes.**

Verifier confirmed and downgraded the severity to low: one paragraph, with the accepts half already documented.

## DVEN-22: GATE.md says delivery_usdt books and orderbooks_slice are 'collected by nothing' or 'not collected'; the adapter accepts and maps both

- Severity: low
- Category: docs-correctness
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F5
- Locations:
  - `docs/venues/GATE.md:47-54`
  - `docs/venues/GATE.md:145-149`
  - `services/prospector/src/adapters/gate.ts:143`
  - `services/prospector/src/adapters/gate.ts:161-162`
  - `services/prospector/src/adapters/gate.ts:236-239`

**Problem.**

GATE.md's trees table marks delivery_usdt/orderbooks/ as 'collected by nothing', and the depth section says the snapshot is not collected. In the code, TREES includes delivery_usdt (MARKET_OF maps it to future) and MEANINGS maps orderbooks_slice to books snapshot,20. Nothing refuses either. Whether something is collected is a service fact in any case.

**Evidence.**

gate.ts:236-239 TREES contains 'delivery_usdt'. gate.ts:162 reads `orderbooks_slice: { dataset: 'books', variant: 'snapshot,20' }`. gate.misfiled.test.ts:73 and paths.test.ts:532/701 treat both as catalogued.

**Fix.**

1. Make the trees table's third column the venue status only: live, ended or foreign. Write delivery_usdt/orderbooks/ as 'live, dated-futures books, 202305 →'.
2. Replace L145-149 with: 'The snapshot covers two pairs per market: BTC_USDT and ETH_USDT, or BTC_USD and ETH_USD coin-margined (gate's documentation, confirmed by its contract dropdown).'
3. Delete 'not collected', 'adds little over' and 'the thing to re-check'.

**Tests.**

None (docs).

**Verifier notes.**

Verifier confirmed and downgraded the severity to low.

## DVEN-23: BYBIT.md and BINANCE.md describe a tag/tagOf mechanism that no longer exists (it is now grain and variant)

- Severity: low
- Category: docs-correctness
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F3
- Locations:
  - `docs/venues/BYBIT.md:255-265`
  - `docs/venues/BYBIT.md:308-324`
  - `docs/venues/BINANCE.md:33-35`
  - `docs/VOCABULARY.md:45-60`
  - `services/prospector/src/adapters/bybit.secondary.ts:66-72`

**Problem.**

`grep tagOf` matches only these docs and etagOf. No tag column or hook exists. The book depth is now the variant incremental,<depth>; the spot daily/monthly split is the grain; the MT4 interval is a variant. BYBIT's 'The venue that makes tag necessary' and BINANCE L34 ('what the prospector's tagOf reads') describe a removed design, and they are service references besides.

**Evidence.**

bybit.secondary.ts:66-72 has variant `incremental,${depth}`. The reviewer's 262-268 range is off, but the content is right.

**Fix.**

1. BYBIT.md L255: 'The depth changed mid-history. linear/BTCUSDT/ holds:' (keep the block).
2. BYBIT.md L262-265: 'No date carries both, so bybit switched from 500 levels to 200 on 2025-08-21.' Cut the tagOf and storage sentences.
3. Rename the L308 heading to 'Renderings told apart by filename alone'. Keep the spot hyphen/underscore example and the MT4 intervals as venue facts: monthly <S>-YYYY-MM and daily <S>_YYYY-MM-DD share one directory; intervals 1/5/15/30/60 minutes share one year directory. Drop 'the tag comes from', 'so it is the tag' and the Binance/gate comparison.
4. BINANCE.md L33-35: keep 'The distinction is a path segment - data/spot/monthly/... against data/spot/daily/...' and delete the rest.

**Tests.**

None (docs). `grep -rn 'tagOf\|`tag`' docs/venues` should return nothing.

**Verifier notes.**

Verifier confirmed and downgraded the severity to low.

## DVEN-24: OKX's archive index is described in two places under two endpoints, and the seeds README says okx has no index

- Severity: low
- Category: docs-duplication
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F11
- Locations:
  - `docs/venues/OKX.md:93-129`
  - `docs/venues/OKX.md:521-573`
  - `docs/venues/OKX.md:1076-1079`
  - `services/prospector/src/database/migrations/seeds/README.md:5-8`

**Problem.**

Archives documents the index as POST priapi/v5/broker/public/trade-data/download-link. REST separately documents GET /api/v5/public/market-data-history as 'The archive's index'. Neither mentions the other. The seeds README says okx has 'no index, nothing that answers about more than one key', yet download-link answers for 4 instruments per call, and for venue-wide files with an empty list. L127 ('It answers absence directly') is also in tension with L567-569 ('Confirm existence against the CDN').

**Evidence.**

OKX.md:100 (POST priapi). OKX.md:1076 (GET market-data-history). seeds/README.md:6-7.

**Fix.**

1. Make 'The archive has an index, and it is public' (OKX.md L93) the single home. Add a subsection on GET /api/v5/public/market-data-history: its parameters, the documented 5 per 2 s, and headers indicating 60/s.
2. State that its relationship to the priapi endpoint is not established, unless someone verifies it.
3. Replace L1076-1079 with a one-line pointer.
4. Resolve L127 against L567-569 by keeping only the measured statement.
5. seeds/README.md:5-8: 'okx and bitget answer no bucket listing (ListObjects is denied at every layer). okx's download portal has an index of files, which prospector does not walk; see docs/venues/OKX.md.'

**Tests.**

None (docs). Run the anchor checker.

**Verifier notes.**

Verifier confirmed. The README probably uses PROSPECTOR's sense of 'index' (a walked listing), but it presents this as a venue fact. Whether the two endpoints are the same service cannot be checked offline.

## DVEN-25: Hoarder's Binance docblock says futures WS delivers nothing on /ws; BINANCE.md documents the working path /public/ws

- Severity: low
- Category: docs-correctness
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F25
- Locations:
  - `services/hoarder/src/venues/binance.ts:19-23`
  - `docs/venues/BINANCE.md:568-573`

**Problem.**

The hoarder docblock says futures 'accepts a subscribe and then delivers nothing from our network, on both the /ws and combined-stream paths', and ends with a plan: 'Add it once it can be verified'. BINANCE.md (verified 2026-07-26) says /public/ws streams, and that /ws, /stream and /public/stream stay silent. So the docblock's 'from our network' misdiagnoses the wrong-path symptom.

**Evidence.**

hoarder/src/venues/binance.ts:20-22 and BINANCE.md:570-573.

**Fix.**

1. Rewrite the docblock: 'Futures is not subscribed. Binance's futures stream answers only at wss://fstream.binance.com/public/ws; /ws and the combined-stream paths acknowledge a subscription and send nothing (see docs/venues/BINANCE.md).' Point by file, not by anchor.
2. Drop 'from our network' and 'Add it once...'.
3. If adding futures is wanted, record it in docs/planning/.
4. BINANCE.md:568: 'Verified live on 2026-07-26.' (also in DVEN-16).

**Tests.**

Comment-only change: keep the hoarder suite green.

**Verifier notes.**

Verifier confirmed. It could not re-verify /public/ws live, so the venue doc is taken as the source of truth.

## DVEN-26: Inbound links from PROSPECTOR.md to GATE.md (and two others) point at headings that no longer exist

- Severity: low
- Category: docs-links
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F24
- Locations:
  - `docs/services/PROSPECTOR.md:955`
  - `docs/services/PROSPECTOR.md:960`
  - `docs/services/PROSPECTOR.md:975`
  - `docs/venues/GATE.md:47`
  - `docs/venues/GATE.md:68`
  - `docs/venues/GATE.md:393`
  - `docs/venues/OKX.md:711`
  - `docs/ROADMAP.md:235`

**Problem.**

PROSPECTOR.md links to GATE.md#571-keys-are-filed-one-level-too-high, #what-is-in-the-bucket-and-what-is-dead and #2021-07-spot-data-served-at-the-futures-url. All three headings were renamed. The verifier found two more dead anchors: OKX.md:711 (#ranges-are-cheap-here-and-expensive-on-bitget) and ROADMAP.md:235 (planning/CATALOG.md#unsolved-what-to-do-about-data-we-do-not-want).

**Evidence.**

scratch/anchors.py and the verifier's scratch/anch22.py report MISSING ANCHOR for PROSPECTOR.md 955, 960 and 975, and for OKX.md:711.

**Fix.**

1. In PROSPECTOR.md, change:
   - :955 to ../venues/GATE.md#keys-filed-at-the-wrong-depth;
   - :960 to #the-trees-and-which-are-dead;
   - :975 to #2021-07-spot-data-at-the-futures-url.
2. OKX.md:711: change to #ranges-and-why-the-monthly-sweep-is-how-to-get-them and drop 'expensive on bitget' from the link text. If DVEN-13 deletes that section, remove the link instead.
3. ROADMAP.md:235: fix or remove the anchor.
4. Re-run the checker after every other item in this unit, since headings move.

**Tests.**

Run scratch/anchors.py over docs/ and expect zero MISSING ANCHOR or MISSING FILE. A CI link check is proposed under DVEN-29.

**Verifier notes.**

Verifier confirmed and reproduced the result with an independent checker. The proposed slugs are correct.

## DVEN-27: BINANCE.md describes the CM-into-UM integration with dates that are now past, and draws advice from it

- Severity: low
- Category: docs-history
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F21
- Locations:
  - `docs/venues/BINANCE.md:96-100`
  - `docs/venues/BINANCE.md:375-376`

**Problem.**

'Binance is integrating CM into UM's architecture - progressive from 2026-06-24, fully effective 2026-06-30' is stale present tense five months on. The paragraph ends with advice to a consumer ('another reason not to pin this to a naming convention'). The REST section already records the measured current state.

**Evidence.**

L96-97 as quoted. L375: 'fapi and dapi count into one budget.'

**Fix.**

Replace L96-100 with present-tense facts: fapi and dapi share one request-weight budget (see REST, measured 2026-10); exchangeInfo stays separate per service; each contract is listed by exactly one service. Cite the integration notice URL as the source. Drop the advice clause.

**Tests.**

None (docs).

**Verifier notes.**

Verifier confirmed.

## DVEN-28: Venue docs compare venues with each other and draw general lessons, against 'a doc is about its own subject'

- Severity: low
- Category: docs-scope
- Decision: IMPLEMENT
- Source finding: docs-venues:docs F28
- Locations:
  - `docs/venues/BINANCE.md:59`
  - `docs/venues/BINANCE.md:207-211`
  - `docs/venues/BINANCE.md:577`
  - `docs/venues/BYBIT.md:226`
  - `docs/venues/BYBIT.md:298-299`
  - `docs/venues/BYBIT.md:319-320`
  - `docs/venues/BYBIT.md:328`
  - `docs/venues/BITGET.md:35`
  - `docs/venues/BITGET.md:92`
  - `docs/venues/BITGET.md:641`
  - `docs/venues/HTX.md:93`
  - `docs/venues/HTX.md:243`
  - `docs/venues/HTX.md:247-251`
  - `docs/venues/OKX.md:121-122`
  - `docs/venues/OKX.md:367-368`
  - `docs/venues/OKX.md:827-828`

**Problem.**

Cross-venue comparisons ('the only venue here', 'every other venue', 'slowest of the eight', 'same trait as bitget's', 'richest bar OKX') go stale whenever another venue doc changes. One already has: OKX.md:121-122 says Binance alone publishes integrity data, but KuCoin has .CHECKSUM and gate and bybit have MD5 ETags.

**Evidence.**

OKX.md:121-122 against KUCOIN.md:13, GATE.md:13 and BYBIT.md:31.

**Fix.**

Replace each comparison with the venue's own fact:
- OKX.md:121-122: see DVEN-13.
- BINANCE.md:59: 'Binance publishes which already-published files changed (...)'.
- BINANCE.md:207-211: keep 'descent guarantees nothing above where it starts; data3/ sits beside data/ at the bucket root'. Move the HTX and KuCoin results to their own docs if missing, and move 'surveys from the bucket root' to PROSPECTOR.md.
- BINANCE.md:577: delete.
- BITGET.md:35: 'a missing key answers 403, the same as a forbidden one'.
- BITGET.md:641: bitget's own delay, with no ranking (DVEN-09).
- BITGET.md:92: delete the binance/bybit clause.
- HTX.md:93 and :243: drop the comparisons.
- HTX.md:247: retitle (DVEN-14).
- OKX.md:368 and :827-828: drop the bitget references, and remove or restate 'in a few weeks' as 'not established'.
- BYBIT.md:226, :298-299 and :319-320: delete. BYBIT.md:328: 'the date is not the last token: a suffix follows it (_premium_index)'.
Keep any worthwhile comparison in a consumer doc, such as PROSPECTOR.md's per-venue tables.

**Tests.**

None (docs). `grep -nE 'other venue|venue here|eight venues|bar OKX' docs/venues/*.md` should return nothing.

**Verifier notes.**

Verifier confirmed. Many of these lines overlap with other items; apply each edit once.

## DVEN-29: The venue docs share no structure in their Archives sections (template rewrite, CI link check)

- Severity: low
- Category: docs-structure
- Decision: DEFER
- Source finding: docs-venues:docs F29
- Locations:
  - `docs/venues/BINANCE.md:5-332`
  - `docs/venues/BITGET.md:5-727`
  - `docs/venues/BYBIT.md:5-346`
  - `docs/venues/GATE.md:5-460`
  - `docs/venues/HTX.md:5-453`
  - `docs/venues/KUCOIN.md:5-68`
  - `docs/venues/OKX.md:5-948`

**Problem.**

The REST sections share subsection names; the Archives sections do not.
- Layout sits at the top in KUCOIN and at the bottom in OKX.
- Limits appear under five different headings; OKX has two of them.
- Publication cadence appears only in BINANCE and BITGET (twice in BITGET).
- Day-boundary facts are a heading in only three docs.
- Only three docs have a WebSocket section.
- Sizes range from 209 to 1,142 lines.
This makes facts hard to find and lets duplicates form.

**Evidence.**

`grep -n '^#' docs/venues/*.md` and `wc -l`.

**Fix.**

Bounded now: the BITGET publication duplicate (covered by DVEN-09).

Deferred (owner approval):
1. Approve a fixed Archives template: Where it is served / Layout / Naming / File formats / Coverage / Publication / Known defects, then REST (existing subsections), WebSocket, Open questions. Keep it in docs/planning/ until it lands, or put the required headings in a docs/venues/README.md or CLAUDE.md note.
2. Reorder each venue doc into it, one PR per venue, after the service and history removals in this report.
3. Add a docs link/anchor check to CI (scratch/anchors.py, or lychee/markdown-link-check with fragment checking).
4. Prefer code docblocks that point at venue docs by file, not by anchor.

**Tests.**

Afterwards, diff `grep '^###' docs/venues/*.md` across venues. The CI link check, if adopted, becomes the test.

**Verifier notes.**

Verifier confirmed but said 'mostly history and service narrative' overstates it (it is a minority of each file). Rewriting about 4,900 lines across eight docs needs the template approved first and is L effort, so it is deferred.

**Owner question.**

Approve a fixed section template for docs/venues/*.md (the one above, or an amended one), and decide whether to add a docs link/anchor check to CI. After that, the reorder proceeds one PR per venue.

## Deferred: decisions needed

- **DVEN-18** (Per-venue REST facts have three homes: the venue docs, docs/REST.md and docs/planning/REST.md): Should docs/REST.md be cut to the cross-venue depth table plus links, or merged into docs/planning/REST.md? Also confirm that planning/REST.md's per-venue 'The API'/'Behaviour' bullets can be reduced to links into the venue docs.
- **DVEN-29** (The venue docs share no structure in their Archives sections (template rewrite, CI link check)): Approve a fixed section template for docs/venues/*.md (the one above, or an amended one), and decide whether to add a docs link/anchor check to CI. After that, the reorder proceeds one PR per venue.

Non-blocking owner questions on IMPLEMENT items:

- **DVEN-07**: Should bitget discovery also read the v2 listings, so that v2-only instruments (classic coin-margined, v2 delivery contracts, demo product types) are found? If so, file it in docs/planning/. Not required for this doc fix.
- **DVEN-16**: Is BINANCE.md L324-332 ('Its raw cannot be reclaimed yet' / month-first eviction) still true? If yes, it moves to docs/tooling/COLD.md in the present tense; if not, delete it. The rest of this item does not wait on the answer.

## Rejected

None. All 29 findings were confirmed by the verifier; no finding was refuted or skipped. The one fix direction that was overturned (F20: correct pattern.csv) is kept as DVEN-01, with its fix reversed.
