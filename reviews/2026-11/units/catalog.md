# Catalog review (services/catalog)

## Overall assessment

The catalog's S3 listing core is mostly sound. Key building, prefix and ceiling bounds, one-past-the-page truncation, V1/V2 cursors, XML entity escaping (& < > " '), parameterised SQL, and the read-only connection on a live WAL database all held up under experiment, and the suite passes (150 tests, about 89% line coverage). The serious problems fall in four groups. (1) Wrong results: contents views counted through a lens with a hole list and date series that have no file inside the lens (the only high item), and `partition=` combined with an unrelated `prefix` lists keys outside the prefix. (2) The trust boundary: prospector explicitly re-validates nothing the catalog forwards, yet the catalog checks only the surface of lens definitions and report bodies. A structurally malformed lens passes `problemsWith`, is stored, and throws inside prospector's lens worker every round, stalling other lens rebuilds. Query values are taken on trust as well: a repeated `lens` gives the unfiltered catalog, malformed flags and timestamps are accepted silently, and the 5 MB JSON body is parsed before the token check. (3) Calls to prospector have no timeout and retry indiscriminately; every prospector refusal is reported as 'not answering', which makes the downloader retry forever. (4) Docs and docblocks (the user's explicit concern) contain false statements: 'stores lenses', 'rate limiting', 'nothing behind the cursor is read', 'nothing is shared with prospector', a books variant example with a key that does not exist. They also break CLAUDE.md rules: offerings explained by their consumer (the downloader, the editor), plus dated measurements and history. The tests run on a hand-copied, drifted copy of prospector's schema, so plan regressions and schema drift cannot fail them, and the token check, the error handler and the malformed-input paths are untested.

Restructuring recommendations: (a) one request-parsing layer at the API edge (a new `api/query.ts` holding single-valued text, flag, instant, grain and lens-slug parsing that answer 400) plus structural body guards for lens writes and reports. CAT-02, CAT-11, CAT-12, CAT-14, CAT-18 and CAT-19 all land there. (b) One retry helper for prospector calls (`settle` becomes a wrapper over `send`) with timeouts and proper status relay (CAT-04, CAT-22, CAT-25). (c) Build test databases from prospector's real `CATALOG_SCHEMA` in WAL mode (CAT-07), which later lets the shared lens tests move to their own package (CAT-27). (d) Longer term, replace the single merged listing statement with per-series indexed reads merged in JS (CAT-09, deferred). Cross-unit notes: CAT-02 needs changes in shared/lenses (`problemsWith`) and, as defence in depth, in prospector (`keepLensesCurrent` per-lens try/catch). CAT-26 is repo-wide. Repro scripts live in reviews/2026-11/units/scratch/catalog/.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| CAT-01 | high | correctness | IMPLEMENT | Contents through a lens with a hole list and date series whose files all sit in the hole |
| CAT-02 | medium | security | IMPLEMENT | Lens definitions and lens write bodies get only a surface check before being forwarded to prospector, which trusts them; malformed ones give 500s or stall prospector's lens worker |
| CAT-03 | medium | correctness | IMPLEMENT | `partition=` replaces a `prefix` that lies outside it, so the listing returns keys outside the requested prefix |
| CAT-04 | medium | robustness | IMPLEMENT | Calls to prospector have no timeout, retry anything (including writes and timeouts), and every refusal is reported as 'not answering' |
| CAT-05 | medium | docs | IMPLEMENT | Docs and docblocks state things the code does not do, or contradict each other |
| CAT-06 | medium | efficiency | IMPLEMENT | Unfiltered listing does not seek by date behind the cursor, and the docs claim nothing behind the cursor is read |
| CAT-07 | medium | testing | IMPLEMENT | Tests run on a hand-copied, drifted copy of prospector's schema, not in WAL mode |
| CAT-08 | medium | testing | IMPLEMENT | The token check, the error handler, the markets view, saved-lens size and several listing paths have no tests |
| CAT-09 | medium | efficiency | DEFER | Listing pages still sort the whole remainder of the cursor prefix group; removing that needs a page-reader redesign |
| CAT-10 | medium | robustness | DEFER | Long report settlements and retried creates: synchronous settlement can outlast any sane timeout |
| CAT-11 | low | robustness | IMPLEMENT | Report bodies are checked loosely: a non-JSON body settles nothing with 200, and a wrongly typed ETag makes prospector refuse the whole report |
| CAT-12 | low | security | IMPLEMENT | Repeated query parameters are treated as absent: `lens=a&lens=a` lists the unfiltered catalog |
| CAT-13 | low | security | IMPLEMENT | The 5 MB JSON body is parsed before the token check; the token compare is not constant-time; no rate limiting |
| CAT-14 | low | correctness | IMPLEMENT | Partition and listing filters accept malformed values: `settled-before` compared as a raw string, flags parsed three ways, list-type unchecked |
| CAT-15 | low | docs | IMPLEMENT | Catalog docs break CLAUDE.md rules: offerings explained by their consumers, other services' internals, history and dated measurements |
| CAT-16 | low | correctness | IMPLEMENT | A hand-made marker whose name does not match its series skips keys that sort after it; a `\|` in a symbol breaks the cursor and key lookup |
| CAT-17 | low | correctness | IMPLEMENT | `delimiter` is ignored silently, so a delimiter-aware client misreads a flat listing |
| CAT-18 | low | robustness | IMPLEMENT | XML answers can be ill-formed: control characters from the request are echoed raw |
| CAT-19 | low | security | IMPLEMENT | PUT/DELETE /lenses/:slug forward unvalidated slugs (`..` reaches prospector's root) and relay non-JSON answers |
| CAT-20 | low | efficiency | IMPLEMENT | Every lensed request resolves the full lens scope and reads the lens twice, even where only its id is used; the scope cache is global |
| CAT-21 | low | code-quality | IMPLEMENT | Dead exports, dead filter branches and an unused production function with a long docblock |
| CAT-22 | low | code-quality | IMPLEMENT | Duplicated helpers and one name with two meanings (BUCKET) |
| CAT-23 | low | robustness | IMPLEMENT | Unknown routes answer Express's HTML 404, not the documented JSON or S3 error shape |
| CAT-24 | low | robustness | IMPLEMENT | Read-only connection sets no busy_timeout |
| CAT-25 | low | testing | IMPLEMENT | Retry tests wait on real timers and never count attempts |
| CAT-26 | low | config | DEFER | The public API container mounts the whole repository read-write in every environment |
| CAT-27 | low | testing | DEFER | The shared lens package's behaviour is tested from the catalog's suite |
| CAT-28 | low | efficiency | DEFER | extensionOf logs a warning per listed file on every request |

## CAT-01: Contents through a lens with a hole list and date series whose files all sit in the hole

- **Severity:** high
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/lenses/scope.ts:47-50`
  - `services/catalog/src/lenses/scope.ts:77`
  - `services/catalog/src/lenses/scope.ts:80-109`
  - `services/catalog/src/lenses/scope.ts:129-132`
  - `services/catalog/src/contents.ts:60-61`
  - `services/catalog/src/contents.ts:77-80`
  - `services/catalog/src/contents.ts:90`

**Problem.** `throughLens` collapses a slice's spans to their outer window (`windowOf`: min of froms, max of tos) and tests a series only against that window. A lens that includes a venue and excludes a range leaves two disjoint spans. A series whose first and last files both lie inside the excluded range is inside the window, so it is not cut and is pushed unchanged. The exact read (`bounds`) is bounded only by the window too, so a series that is cut can still be dated by a file inside the hole. /venues/:venue/symbols, /markets/:market shapes (symbols, first, last), /venues/:venue (market symbol counts) and /venues (series counts) are all wrong for any lens with a gap, while the listing and sizes (which read lens_member) are right, so the views contradict each other. This breaks the docblock promise 'none with no file inside them' (scope.ts:48-50) and 'dated by the files it holds there' (contents.ts:77-80).

**Evidence.** Reproduced by both lens reviewers and independently by a second verifier (reviews/2026-11/units/scratch/catalog/f1v2.test.ts, f1v2.out). BTCUSDT has 20200101/20200301/20200601, ETHUSDT has only 20200301, SOLUSDT has 20200115/20200301; lens {binance:[{effect:'include'},{effect:'exclude',from:'202002',to:'202005'}]}. lensScope gives spans [202001..202001],[202006..202006]. throughLens returns ETHUSDT (20200301..20200301) and SOLUSDT dated 20200115..20200301. GET /venues/binance/symbols -> [BTCUSDT,ETHUSDT,SOLUSDT]; shape symbols:3; /venues files:3 but series {withFiles:3,total:3}. /listings shows no ETHUSDT key. The existing test 'counts a series with two spans once' (tests/contents.test.ts:131) uses only series with files outside the hole.

**Fix.** In scope.ts `throughLens`, test each series against the slice's individual spans (sorted and disjoint from `union`), not `windowOf(held)`. Treat a null from as -infinity and a null to as +infinity, and keep the width-aware startAt/endAt. (1) `hit` = spans with startAt(span.from, first.length) <= last && first <= endAt(span.to, last.length). If `hit` is empty, drop the series (both modes; this alone fixes the non-exact venue counts at contents.ts:60-61 at no read cost). (2) If [first,last] lies wholly inside one span, push the row unchanged (current fast path). (3) Non-exact mode: lo = max(first, start of hit[0]), hi = min(last, end of hit.at(-1)); state in the docblock that this date-only estimate cannot see a series whose files sit only in a hole while its first..last range touches a span. (4) Exact mode: do NOT issue one read per span (fragmented lenses would multiply reads). Walk `hit` ascending running MIN(date) bounded to that span and stop at the first non-null (= first); walk descending with MAX(date) and stop at the first non-null (= last). Usually two reads. Drop the series if no span yields a file. Delete `windowOf`, and `LensWindow` in types.ts if nothing else imports it.

**Tests to add.**
- tests/contents.test.ts, lens {include},{exclude 202002..202005}: a series whose only file is in the hole is absent from /venues/:venue/symbols
- the shape symbols count, the /venues/:venue market symbols count and /venues series.withFiles leave it out (expect 2 with BTC 20200101/20200301/20200601 and SOL 20200115/20200301)
- a series with files on both sides of the hole is dated by its first and last in-span files (BTC 20200101..20200601; the hole file never appears as first/last)
- a series straddling the hole edge is dated by the in-span file only (SOL last = 20200115, not 20200301)
- keep the existing 'counts a series with two spans once' test

**Verifier notes.** Both verifiers (first and second) confirmed at high. The second verifier refined the exact-mode fix to a front/back walk so the read count stays about two per cut series.

## CAT-02: Lens definitions and lens write bodies get only a surface check before being forwarded to prospector, which trusts them; malformed ones give 500s or stall prospector's lens worker

- **Severity:** medium
- **Category:** security
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/api/lenses.ts:36`
  - `services/catalog/src/api/lenses.ts:52-72`
  - `services/catalog/src/api/lenses.ts:63`
  - `services/catalog/src/api/lenses.ts:75-99`
  - `services/catalog/src/api/lenses.ts:88`
  - `services/catalog/src/api/lenses.ts:108-110`
  - `services/catalog/src/api/lenses.ts:129-136`
  - `services/catalog/src/api/lenses.ts:161-167`
  - `shared/lenses/src/draft.ts:123-142`
  - `shared/lenses/src/draft.ts:145`
  - `shared/lenses/src/rules.ts:159-165`
  - `services/prospector/src/api/lenses.ts:8-14`
  - `services/prospector/src/api/lenses.ts:29-37`
  - `services/prospector/src/lenses.ts:44-60`

**Problem.** POST/PUT /lenses validate a definition only with `problemsWith` (venue names, grain/bundle values, the month regex on from/to, from<=to), and only when `definition` is truthy. It never checks that `venues` is an object of arrays, that rules are objects, that `effect` is 'include'|'exclude', that `markets` is a string array, that `datasets` is an array of {dataset, variant?}, or that from/to are strings. Prospector's lens API says 'nothing is validated again'. Consequences: (a) a definition like {binance:[{effect:'include',datasets:'klines'}]} is stored; prospector's `keepLensesCurrent` walks lenses inside one try, `catchUp` -> `letThrough` -> `dataset()` calls `'klines'.some` and throws, the round is abandoned every 30 s, and older lenses still rebuilding never finish (left `updating`, so `admit` skips them). (b) Other wrong types are silently mis-evaluated: markets:'spotx' becomes a substring match, from:202001 (number) passes the regex, any non-'include' effect counts as exclude in spansFor but is ignored in letThrough. (c) POST /lenses/check, /size and /resolve throw TypeErrors on such bodies and answer 500. (d) `lensNameIsSound` uses regex .test, which coerces, so slug 12 or ['ab'] pass; definition:'junk' passes; PUT skips validation when definition is null; name/note are never type-checked; all are forwarded verbatim. (e) A lens with slug 'options' can be created but never read, because GET /lenses/options shadows it.

**Evidence.** poison.cjs (reviews/2026-11/units/scratch/catalog/): problemsWith returns [] for datasets:'klines', markets:'spotx', from:202001, from:['202001']; throws 'rules.forEach is not a function' for venues:{binance:'abc'}; lensSize throws 'kinds.some is not a function'; after putLens('good') and putLens('bad'), a prospector-style round throws and both lenses stay updating with 0 lens_member rows. Over HTTP (t3.cjs, repro.test.ts, repro2.test.ts): POST /lenses/check {venues:{binance:'x'}} -> 500; /lenses/size with datasets:'klines' or {venues:[1]} -> 500; /lenses/resolve {venues:{binance:{rules:[null]}}} -> 500; POST /lenses {slug:'options', name:{x:1}, note:5, definition:'junk'} and PUT {definition:null, name:['a']} forwarded verbatim.

**Fix.** (1) shared/lenses/src/draft.ts: add a structural check that runs before `faultsIn` and returns LensProblem entries (rule:-1 for whole-document faults). definition is a plain object; format undefined or 1; venues a plain object; each venue value an array; each rule a plain object with effect === 'include' || 'exclude'; markets undefined or string[]; datasets undefined or an array of {dataset: string, variant?: string}; from/to undefined or strings matching /^\d{4}(0[1-9]|1[0-2])$/ (typeof before .test); grain/bundle undefined, a string, or an object with exactly one of only/prefer whose value is a string; no unknown keys on a rule. Skip faultsIn for a venue whose rules are not an array of objects, so problemsWith never throws. Goal: a definition that passes can never throw in lensSize, resolvedSummary or catchUp. (2) services/catalog/src/api/lenses.ts: add `lensWriteOf(body)`: body a plain object; slug `typeof === 'string'`, lensNameIsSound, and not reserved ('options'; also 'size', 'check', 'resolve' for safety); name/note strings when present; `definition !== undefined && !isPlainObject(definition)` is a 400 (no truthiness test); on PUT a present-but-null definition is a 400. In `definitionOf` and for /lenses/check, /size and /resolve, run the structural check plus problemsWith first and answer 400 {error, problems} instead of evaluating. (3) Prospector (outside this unit, defence in depth): move the try/catch in `keepLensesCurrent` inside the per-lens loop so one bad lens is logged and skipped.

**Tests to add.**
- check, size, resolve, POST and PUT /lenses each answer 400 with problems (never 500) for venues:{binance:'x'}, venues:[1], rules [null], datasets:'klines', markets:'spot', from:202001, effect:'drop' and definition:'str'
- refuses a non-string slug (12, ['ab'])
- refuses the slug 'options'
- PUT refuses definition:null and a non-string name
- shared/lenses: problemsWith never throws on any of the above and reports them

**Verifier notes.** Merged from correctness-security F1 and efficiency-quality-testing F4; both verifiers confirmed at medium (reviewer said high). Blast radius narrower than first claimed: lenses() orders by updated_at DESC, so only lenses older than the bad one that are still rebuilding are blocked, and the failure logs at warn every round. Writes need the shared token and the only client is the editor form, so this is a robustness/contract defect rather than an exposed hole. The second lens verifier noted that a catalog-only 'rule is a plain object' guard would not stop the poisoning case; the field-level check must be in problemsWith.

## CAT-03: `partition=` replaces a `prefix` that lies outside it, so the listing returns keys outside the requested prefix

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/api/listings.ts:40-41`
  - `services/catalog/src/listings/listing.ts:44-46`

**Problem.** The page prefix is `partition && ! asked.prefix.startsWith(partition.prefix) ? partition.prefix : asked.prefix`. Meant to narrow a shallower prefix (binance/) to the partition's slice, it also fires when the two are unrelated (prefix=gate/ with a binance partition). The walk then runs over the binance slice, listingPage's own prefix check only sees the replaced prefix, and the response echoes `Prefix: gate/` with binance keys, breaking the S3 invariant that every key starts with Prefix and the docblock's 'each simply leaves files out'.

**Evidence.** t1.cjs and the second lens repro: GET /listings?prefix=gate/&partition=binance|spot|klines,1m|*|daily|202001 -> 200 with Prefix 'gate/' and Contents keys starting 'binance/spot/klines,1m/B/BTCUSDT/'.

**Fix.** In api/listings.ts: `const p = partition?.prefix; const prefix = !p ? asked.prefix : asked.prefix.startsWith(p) ? asked.prefix : p.startsWith(asked.prefix) ? p : null;`. Fold `prefix === null` into the existing `hidden` short-circuit (`{ objects: [], truncated: false }`). Pass the narrowed prefix to the page; keep echoing `asked.prefix`.

**Tests to add.**
- tests/listings.test.ts: prefix=gate/ with a binance partition gives 200 and no Contents
- prefix=binance/ with a binance partition gives the whole partition
- prefix=<partition prefix>B/BTCUSDT/ gives only that symbol's keys

**Verifier notes.** Found independently by both lenses; both verifiers confirmed at medium.

## CAT-04: Calls to prospector have no timeout, retry anything (including writes and timeouts), and every refusal is reported as 'not answering'

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/prospector.ts:11`
  - `services/catalog/src/prospector.ts:16-41`
  - `services/catalog/src/reports.ts:76`
  - `services/catalog/src/reports.ts:82-115`
  - `services/catalog/src/api/reports.ts:30-36`
  - `services/catalog/src/api/lenses.ts:144-157`
  - `services/prospector/src/reports.ts:76-104`

**Problem.** `send` and `settle` call fetch with no AbortSignal and retry on any thrown error. A prospector that accepts the connection but stalls (or a long settlement: prospector confirms each failed/mismatched file one after another) runs into undici's 300 s headers timeout; that error is retried, so up to about 15 minutes pass before a 502, and the same report is re-posted while prospector is still confirming the first, probing the venue repeatedly. `send` retries POST/PUT/DELETE on any throw, so a reset after prospector committed turns a successful create into a relayed 409 or 404. api/reports.ts maps every throw, including a deterministic prospector 400 or 500 (`Refused`), to 502 'The collector is not answering'; hauler's `ask` retries every 5xx forever, so a report prospector will never accept stalls that venue's walk indefinitely.

**Evidence.** reports.ts:85 and prospector.ts:19 fetch without `signal`; reports.ts:97-100 `if (err instanceof Refused || attempt >= ATTEMPTS) throw err; ... RETRY_MS * attempt`; prospector.ts retries everything; api/reports.ts:35 answers every throw 502 'not answering'. Prospector settles one file at a time (services/prospector/src/reports.ts:81-83). hauler/src/catalog.ts `ask` retries 5xx and TypeError while not halting.

**Fix.** Both fetches: `signal: AbortSignal.timeout(PROSPECTOR_MS)` (e.g. 15_000 for lens calls; pick a longer value for reports, see CAT-10). Retry only connection-level failures before a response: `err.cause?.code` in ECONNRESET, ECONNREFUSED, EPIPE, UND_ERR_SOCKET. Never retry TimeoutError, AbortError, UND_ERR_HEADERS_TIMEOUT or UND_ERR_BODY_TIMEOUT. For non-idempotent methods (POST /lenses) retry only ECONNREFUSED (request certainly not sent). Fold `settle` into `send` (`const a = await send('POST','/reports', ids); if (a.status < 200 || a.status >= 300) throw new Refused(a.status, ...)`), so there is one retry loop (see CAT-22). Give `Refused` a `status`. In api/reports.ts: Refused 4xx -> 400 'ReportRefused' with prospector's message (hauler then logs it and moves on); Refused 5xx -> 502 'CollectorError'; keep 502 ServiceUnavailable 'not answering' for connection failures and timeouts. Fix the settle/send docblocks to say exactly what is retried, and 'tried up to three times' (ATTEMPTS = 3 is three attempts in all).

**Tests to add.**
- mock prospector (local http server): ECONNRESET on the first attempt is retried once and succeeds
- a 400 from prospector gives a catalog 400 ReportRefused with exactly one attempt
- a 500 gives 502 CollectorError with one attempt
- a prospector that never answers gives 502 within the timeout and is not retried (small timeout or injectable)
- a timed-out lens write is not retried

**Verifier notes.** Merged from correctness-security F5 and efficiency-quality-testing F6; both verifiers confirmed at medium. The first verifier noted the hauler interaction makes the status mapping worse than reported. Resolving a 409 after a retried create (GET and compare) and making settlement asynchronous were split out into CAT-10.

## CAT-05: Docs and docblocks state things the code does not do, or contradict each other

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/service.ts:5-7`
  - `services/catalog/src/config.ts:8-11`
  - `services/catalog/src/config.ts:33`
  - `services/catalog/src/types.ts:19`
  - `services/catalog/src/types.ts:22`
  - `services/catalog/src/types.ts:25`
  - `services/catalog/docker/compose.yml:3-6`
  - `services/catalog/docker/compose.yml:21-23`
  - `services/catalog/src/contents.ts:22-23`
  - `services/catalog/src/prospector.ts:11`
  - `services/catalog/src/reports.ts:76`
  - `docs/services/CATALOG.md:32`
  - `docs/services/CATALOG.md:46-49`
  - `docs/modules/CATALOG-API.md:74`
  - `docs/modules/CATALOG-API.md:80`
  - `docs/modules/CATALOG-API.md:144-151`
  - `docs/modules/CATALOG-API.md:220-221`
  - `docs/modules/CATALOG-API.md:262`
  - `docs/modules/CATALOG-API.md:335-341`
  - `services/catalog/README.md:20-24`

**Problem.** False or contradictory today: (1) service.ts:6 says rate limiting comes with the server; service-kit applies it only when `rateLimit` is set, and service.ts sets none. (2) config.ts:9, types.ts:19 ('opened here to read and to store lenses') and compose.yml:4 ('It writes only lenses') contradict database.ts (`readOnly: true`), index.ts ('It writes nothing') and the README; lens writes are forwarded to prospector. (3) types.ts Config.token says 'Sent to the catalog on every request' (it is checked here and sent to prospector); Config.prospectorApi and compose.yml:23 mention only reports, but lens writes are forwarded too. (4) contents.ts:22-23 'Nothing here reaches the database, and nothing here filters' is false (seriesFor, throughLens, venueIds, hostsOf). (5) prospector.ts:11, reports.ts:76, CATALOG.md:32 'tried again, three times' with ATTEMPTS = 3 (three attempts in all). (6) config.ts logs 'Configuration loaded and validated!' but validates nothing. (7) CATALOG.md:46 'Nothing is shared in code with prospector' contradicts CATALOG.md itself and both package.json files depending on @tradebot/lenses. (8) CATALOG-API.md:74 says the venue list holds only venues with something; without a lens every venue row is listed. (9) CATALOG-API.md:80 says lens figures cost 'resolving the lens: a few seconds'; they are one aggregate over lens_member. (10) CATALOG-API.md:144-147 books variant example uses {depth, mode}; LEVELS is books: ['kind','depth']. The bybit date sentence at :150-151 is a venue fact in a module doc. (11) CATALOG-API.md:262 says 'Two filters S3 does not have' then lists three. (12) The Errors table (335-341) omits 400 for bundle, InvalidArgument for max-keys, MalformedReport, 422 NoSuchPartition, and 502 for lens writes. (13) The README environment table omits CATALOG_DB, which config.ts reads. (14) CATALOG-API.md:220-221 '.partNN' is misleading notation (gate's parts are 10-digit epochs).

**Evidence.** service.ts:14-16 has no rateLimit key; express.ts:286 `if (this.#config.rateLimit)`. database.ts:26-31 `new DatabaseSync(path, { readOnly: true })`. prospector.ts:23 sends the token to prospector; prospector.ts:41 `ATTEMPTS = 3` with `if (attempt >= ATTEMPTS) throw err`. t3.cjs: GET /venues -> [['binance',3],['gate',3],['okx',0]]; venueTotals LEFT JOINs from every venue (queries.ts:57-60). figures.ts:13 lensFigures is one aggregate. vocabulary.ts:66 `books: ['kind', 'depth']`. config.ts:26-28 reads CATALOG_DB.

**Fix.** Rewrite each to the current behaviour. config.ts:8-11: 'The database is prospector's: it creates, migrates and writes it; this service opens it read-only, and every write (lenses, reports) is forwarded to prospector. The two must share a host because a WAL database is shared through memory.' types.ts:19 'opened read-only'. Config.token: 'Checked on every request to this API and sent to prospector with every forwarded write; empty turns both off.' Config.prospectorApi: 'Where prospector answers; lens writes and reports are forwarded there.' compose.yml:3-6, :21-23: the service writes nothing; every write is forwarded. service.ts: drop 'rate limiting' (and coordinate with CAT-13, which changes body parsing). contents.ts:22-23: the projections (intoShapes, intoMarkets, intoSymbols) are pure folds; the exported entry points read the rows they fold; drop 'nothing here filters'. Retry wording: 'tried up to three times' (or whatever CAT-04 leaves). config.ts log: 'Configuration loaded'. CATALOG.md:46-49: 'The catalog's queries are its own, written against prospector's tables; what a lens is, and how its members are kept, is @tradebot/lenses, which both services use. The table shapes are the contract.' CATALOG-API.md:74: 'every venue; under a lens, only those it lets something through from'. CATALOG-API.md:80: under a lens every figure is the lens's, summed off lens_member; no rule is evaluated. CATALOG-API.md:144-147: `{ "kind": "incremental", "depth": "500" }` (and the 200 one); replace the bybit sentence with a venue-neutral one or a pointer to docs/venues. CATALOG-API.md:220-221: keep 'date is a month (202001) or a day (20200101)'; change `.partNN` to `.part<part>` (whatever the path holds at {PART}: an hour, a numbered piece, a slice epoch). CATALOG-API.md:262 'Three filters'. Errors table: add 400 (bundle, max-keys/InvalidArgument, MalformedReport), 422 NoSuchPartition, and 502 for a report or lens write prospector did not answer (update again after CAT-04 adds ReportRefused/CollectorError). README: add CATALOG_DB (default /data/catalog/catalog.db; override for tests and local runs). The page-cost text (listing.ts:16-17, CATALOG.md:99-109) is handled in CAT-06.

**Tests to add.**
- no tests; afterwards grep services/catalog and docs for 'store lenses', 'writes only lenses', 'rate limit', 'Two filters', '"mode"', 'validated!', 'Nothing is shared'

**Verifier notes.** Merged from correctness-security F13, efficiency-quality-testing F10 and F12. All confirmed at medium (F12 low). One sub-claim refuted: file dates do NOT reach yyyymmddhh(mi). Every adapter's dateOf yields 6 or 8 digits (gate cuts its 10-digit stamps to the day, gate.ts:58-59), so 'a month or a day' is correct and must be kept.

## CAT-06: Unfiltered listing does not seek by date behind the cursor, and the docs claim nothing behind the cursor is read

- **Severity:** medium
- **Category:** efficiency
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/listings/listing.ts:11-21`
  - `services/catalog/src/listings/listing.ts:128-138`
  - `services/catalog/src/listings/listing.ts:136`
  - `services/catalog/src/database.ts:13-16`
  - `docs/services/CATALOG.md:99-109`

**Problem.** In the page statements, `AND (s.prefix, f.date) >= (?2, ?4)` is a row-value comparison SQLite cannot use as a range on file_series, so for all:any every file of the cursor's series behind the cursor is read and discarded. All six variants also plan `USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY`: the rest of the cursor's prefix group is read and sorted before the first row is emitted. This runs on the only request thread inside one read transaction. listing.ts:16-17 and CATALOG.md ('nothing behind the cursor ... is read', 'a page never waits for more than that') are therefore false; startOf's own docblock (listing.ts:74-76) contradicts them.

**Evidence.** EXPLAIN QUERY PLAN against prospector's CATALOG_SCHEMA (plan.cjs, plan.test.ts): all:any 'SEARCH f USING INDEX file_series (series_id=?)' and 'USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY' for all six. With `f.date >= CASE WHEN s.prefix = ?2 THEN ?4 ELSE '' END` the plan becomes 'file_series (series_id=? AND date>?)' (plan2.cjs). Benchmarks: 300k-file series, pages at 0/50%/99%: 115/66/22 ms before, 96/48/4 ms after the CASE rewrite; the sort still dominates (see CAT-09). 100k series walked in 1,000-key pages: 4,035 ms total.

**Fix.** listing.ts:136 (and wherever the same row value appears among the six statements): replace `(s.prefix, f.date) >= (?2, ?4)` with `f.date >= CASE WHEN s.prefix = ?2 THEN ?4 ELSE '' END`. Equivalent, since `s.prefix >= ?2` already holds. Verify with EXPLAIN QUERY PLAN that every statement shows `date>?` on file_series or file_pending. Correct listing.ts:11-21 and CATALOG.md 'Listings' to the real cost: rows before the cursor's date in its own series are skipped through the index; the rows of the cursor's prefix group from the cursor onward (within the lens's months where there is a lens) are read and sorted together before the first key is returned, so a page costs about one prefix's remaining files; nothing in earlier series, past the prefix or outside the lens is read. No dates or past timings (CLAUDE.md).

**Tests to add.**
- optional tests/plans.test.ts (after CAT-07): EXPLAIN of the all:any statement contains 'date>?'
- existing listing paging tests must still pass

**Verifier notes.** Merged from correctness-security F4 (verifier: low, implement) and efficiency-quality-testing F2 (verifier: medium, full redesign deferred). Severity set to medium: the doc is wrong today and the cost is real for large prefix groups (keys.ts says a day can hold tens of thousands of parts), but it is an efficiency cost of ~100 ms per page, not a failure. The redesign that removes the sort is CAT-09.

## CAT-07: Tests run on a hand-copied, drifted copy of prospector's schema, not in WAL mode

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/tests/fixture.ts:19-25`
  - `services/catalog/tests/fixture.ts:174-218`
  - `services/catalog/tests/readonly.test.ts:17-27`
  - `services/prospector/src/database/schema.ts:70-544`

**Problem.** tests/fixture.ts re-types tables, indexes and the series_prefix trigger. It already differs from CATALOG_SCHEMA: no STRICT, no file.partition_id, no pattern.holds, no series.tip, no instrument.kind/state, no foreign keys, and missing indexes file_when, file_partition, series_key and series_instrument. The planner can pick different plans than in production, so plan regressions (CAT-06) and schema drift cannot fail a test. openScratch never sets WAL, so readonly.test.ts proves read-only access on a rollback-journal file while production is WAL.

**Evidence.** fixture.ts `CREATE TABLE file (venue_id ..., downloaded_at TEXT, PRIMARY KEY (venue_id, path))` vs schema.ts:103 `partition_id INTEGER NOT NULL REFERENCES partition (id)` and `) STRICT;`; series_key at :501, journal_mode WAL in ON_OPEN at :540. A verifier ran node:sqlite readOnly on a WAL database (both closed and with a live writer): reads worked and writes were refused, so the behaviour is right but untested. schema.ts imports nothing, so a test-only relative import works.

**Fix.** In tests/fixture.ts delete SCHEMA and `import { CATALOG_SCHEMA, ON_OPEN, AT_CREATION } from '../../prospector/src/database/schema';` (test-only relative import; tests are outside the catalog tsconfig include and vitest resolves it). Or move them into a shared package if the owner prefers. openScratch/scratch: apply AT_CREATION, then ON_OPEN (WAL, foreign_keys=ON), then CATALOG_SCHEMA. putFiles and the other helpers: upsert the partition row first (logic now in `tally`) and fill partition_id and the other real NOT NULL columns, respecting STRICT types. readonly.test.ts: open in WAL, keep a writer connection open and insert while the read-only connection reads; assert the read sees committed data and writes throw /readonly/.

**Tests to add.**
- the whole existing suite passes on the real schema
- readonly.test.ts in WAL with a concurrent writer
- optional tests/plans.test.ts: EXPLAIN QUERY PLAN every prepared listing, keys, partitions and queries statement and assert the expected index; add 'no TEMP B-TREE' only once CAT-09 lands

**Verifier notes.** Merged from correctness-security F15 (schema part) and efficiency-quality-testing F21. Confirmed at low and medium; medium kept because it hides real regressions. Effort M because the insert helpers need partition_id.

## CAT-08: The token check, the error handler, the markets view, saved-lens size and several listing paths have no tests

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/api/index.ts:31-40`
  - `services/catalog/src/api/index.ts:53-61`
  - `services/catalog/src/api/index.ts:68-80`
  - `services/catalog/src/contents.ts:157-208`
  - `services/catalog/src/api/lenses.ts:80-86`
  - `services/catalog/src/api/lenses.ts:115-126`
  - `services/catalog/src/lenses/figures.ts:34-46`
  - `services/catalog/src/listings/s3.ts:67-68`

**Problem.** Coverage is about 89% overall, but api/index.ts is 66.7% (requireToken's 401 and onError never hit: every suite mounts with token '' on its own express() with no failing route); contents.ts 63.5% (intoMarkets, GET /venues/:venue, never called); figures.ts 33% (savedLensSize, GET /lenses/:slug/size); lenses.ts 81-85 (PUT with unsound slug) and 116-125; s3.ts 68-69 (ContinuationToken/StartAfter echo). stillWanted's drop of disconnected requests is untested. None of the bugs in CAT-01..04 or the malformed-input items is caught by an existing test.

**Evidence.** Verifier re-ran coverage: api/index.ts lines 35-37 and 69-79 uncovered, contents.ts 158-207, figures.ts 35-45, lenses.ts 81-85/116-125. `grep x-catalog-token tests/*.ts` finds nothing. The only socket.destroy (listings.test.ts:357) belongs to a stand-in prospector.

**Fix.** Add tests/api.test.ts mounting through the real `mount` with token 'secret' (and body parsing as arranged by CAT-13). Add the listed contents, lens and listing tests. Malformed-body and repeated-parameter cases belong with CAT-02, CAT-11 and CAT-12.

**Tests to add.**
- api.test.ts: 401 without the token; 401 with a wrong token (also of equal length); passes with the right token; an empty configured token lets a request with no header through
- 400 with the parser's message for malformed JSON; 413 for a body over the limit
- 500 {error:'Internal error'} for a throwing route, logged once (register a throwing route before onError, or export onError)
- stillWanted: open a raw socket, write a GET, destroy immediately, assert a spy route never ran
- contents.test.ts: GET /venues/:venue names each market's datasets, variants, grains and symbol counts; counts an instrument once across bar lengths; leaves the @ bucket out of symbol counts
- lens.api.test.ts: GET /lenses/:slug/size sums its partitions and reports updating; 404 for an unknown slug; PUT refuses an unsound new slug
- listings.test.ts: V2 echoes StartAfter and resumes after it; continuation-token wins over start-after; & and < in keys are escaped in XML

**Verifier notes.** Merged from efficiency-quality-testing F20 and the trust-boundary part of correctness-security F15. Confirmed at medium.

## CAT-09: Listing pages still sort the whole remainder of the cursor prefix group; removing that needs a page-reader redesign

- **Severity:** medium
- **Category:** efficiency
- **Decision:** DEFER
- **Locations:**
  - `services/catalog/src/listings/listing.ts:128-138`
  - `services/catalog/src/database.ts:13-16`

**Problem.** Even after CAT-06, `ORDER BY s.prefix, f.date, f.path` cannot be served by the index (several series share a prefix; path is not indexed), so every page statement uses a temp B-tree over the rest of the cursor's prefix group. A page costs O(files left in the prefix group), and walking one large group is O(N^2 / max-keys) on the single request thread, inside one read transaction that holds back prospector's checkpoints.

**Evidence.** After the CASE rewrite, a 300k-file series still costs 96/48/4 ms per page at 0/50/99%; about 1 ms is achievable with seek-and-stop. Plan shows 'USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY' for all six statements.

**Fix.** If approved: read the series in range in prefix order (`SELECT id, prefix, pattern FROM series WHERE prefix >= ? AND prefix < ? ... ORDER BY prefix` with the existing lens/partition/pending slice filters); for each prefix group run one per-series statement (`... WHERE series_id = ? AND date >= ? AND existence='confirmed' [AND downloaded_at IS NULL] [AND month bounds] ORDER BY date, path LIMIT maxKeys+1`), binding the cursor date only for the cursor's prefix; k-way merge the group's iterators by key in JS and stop at maxKeys+1. A lighter alternative: give each page an upper date bound and widen month by month while the page is short. Then add a plan test asserting no 'TEMP B-TREE' and update the cost description from CAT-06.

**Tests to add.**
- paging equivalence: the new reader returns the same keys and NextMarker as the current one across lens, partition and pending variants
- plan test: no page statement contains 'TEMP B-TREE'
- timing guard on a large synthetic series (optional)

**Verifier notes.** From efficiency-quality-testing F2 (verifier: defer, effort L) and the deferred part of correctness-security F4. Real series today are one instrument's daily or monthly files (thousands of rows), so not urgent.

## CAT-10: Long report settlements and retried creates: synchronous settlement can outlast any sane timeout

- **Severity:** medium
- **Category:** robustness
- **Decision:** DEFER
- **Locations:**
  - `services/catalog/src/reports.ts:82-103`
  - `services/prospector/src/reports.ts:76-104`
  - `services/catalog/src/prospector.ts:16-37`

**Problem.** Prospector settles a report synchronously, confirming each failed and mismatched file with the venue one at a time. A report of up to 10,000 keys taken during a venue outage can take minutes. Once CAT-04 adds a timeout, such a report will time out (and correctly not be retried), yet it may still be settling in prospector. Separately, a POST /lenses whose response is lost after prospector committed cannot be told apart from a failure without an extra read.

**Evidence.** services/prospector/src/reports.ts:81-83 `for (const file of report.failed) ... await confirm(...)`; MAX_REPORT is 10,000 keys.

**Fix.** Options for the owner: (a) prospector answers 202 and confirms in the background (catalog then answers 202/207 without per-key confirmation results); (b) cap failed+mismatched keys per report at a size prospector can confirm well within the timeout, and answer 400/413 above it; (c) on a retried POST /lenses that answers 409, GET /lenses/:slug and answer 201 if it matches the body sent.

**Tests to add.**
- depends on the option chosen: e.g. a report with N failed keys over the cap is refused with a clear message; or settlement answers 202 and records later

**Verifier notes.** Split out of correctness-security F5 and efficiency-quality-testing F6; both verifiers said the asynchronous settlement and the 409-resolution need the owner's decision.

## CAT-11: Report bodies are checked loosely: a non-JSON body settles nothing with 200, and a wrongly typed ETag makes prospector refuse the whole report

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/reports.ts:62-70`
  - `services/catalog/src/reports.ts:126-143`
  - `services/catalog/src/api/reports.ts:24-33`
  - `services/prospector/src/reports.ts:42-53`
  - `services/prospector/src/etag.ts:15-19`

**Problem.** `shapeOf` reads `(body ?? {})`, so a report sent as text/plain (express.json leaves req.body undefined) is answered 200 and an empty report is sent to prospector; the files stay pending. Mismatched entries are checked only for a string `Key`; `Size` and `ETag` are forwarded as sent. Prospector builds claims with `etagOf(one.ETag)` before markDownloaded, so a numeric ETag throws, nothing is recorded, prospector answers 500, the catalog 502, and the downloader re-sends forever. A string Size ('506') compares unequal to every number. keysIn and resolveReport each parse the body separately.

**Evidence.** repro2.test.ts: POST /listings/report with text/plain -> 200 {}; stand-in prospector got {downloaded:[],failed:[],mismatched:[]}. reports.ts:137 checks only Key; etag.ts:16 `raw?.replace(...)` is a TypeError on a number. hauler sends JSON and only {Key, Size?: number}, so in-repo clients are not affected.

**Fix.** shapeOf: return null unless `body !== null && typeof body === 'object' && !Array.isArray(body)`; require each mismatched item to be a plain object with string Key, `Size === undefined || (Number.isSafeInteger(Size) && Size >= 0)`, `ETag === undefined || typeof ETag === 'string'`; otherwise null (400 MalformedReport). Update the MalformedReport message to say Size is a whole number and ETag a string. Forward only Key, Size, ETag. In api/reports.ts compute the shape once and use it for both the MAX_REPORT check and resolution; skip settle() when all three resolved id lists are empty. Optional (prospector unit): compute claims after markDownloaded, or guard etagOf with typeof.

**Tests to add.**
- refuses a report sent as text/plain (400 MalformedReport)
- mismatched with ETag 5 -> 400; Size '506' -> 400
- Size 506 with ETag '"abc"' is forwarded unchanged
- an empty report does not call prospector

**Verifier notes.** Merged from correctness-security F6 and efficiency-quality-testing F5; both verifiers lowered to low because only a misconfigured or third-party client triggers it.

## CAT-12: Repeated query parameters are treated as absent: `lens=a&lens=a` lists the unfiltered catalog

- **Severity:** low
- **Category:** security
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/lenses/requested.ts:10-12`
  - `services/catalog/src/lenses/requested.ts:31-37`
  - `services/catalog/src/listings/s3.ts:28-45`
  - `services/catalog/src/listings/s3.ts:126-127`
  - `services/catalog/src/api/contents.ts:121-127`

**Problem.** Express 5's default query parser makes a repeated key an array. `text()` (copied in s3.ts and api/contents.ts) treats any non-string as absent, and `lensSlug` accepts the query only when it is a string. So a repeated `lens` gives null, meaning no lens and the whole catalog, contradicting 'an unknown lens is never the whole catalog in its place'. A repeated prefix lists from the root, a repeated marker/continuation-token restarts paging (a client loops), a repeated partition drops the filter, a repeated max-keys falls back to 500.

**Evidence.** t2.cjs: /listings?lens=gate-only -> only gate keys; with lens repeated -> binance and gate keys; /venues likewise. /listings?prefix=gate/&prefix=binance/&max-keys=1&max-keys=2 -> 200 Prefix '' MaxKeys 500 with every key. hauler sends the lens as a header and builds queries with URLSearchParams.set, so it is not affected.

**Fix.** Shared helper in a new api/query.ts: `queryText(raw): string | undefined | typeof INVALID` (INVALID for anything neither undefined nor a string). requestOf: before anything else, for prefix, marker, continuation-token, start-after, max-keys, list-type, pending, partition, return `${k} may be given once` when INVALID (the route maps a string to 400 InvalidArgument). lensSlug: when the header is absent and req.query.lens is defined but not a string, return a sentinel (e.g. false) that lensRequested turns into undefined, so callers answer 422 NoSuchLens; message says the lens parameter must be given once. Use the same helper in api/contents.ts.

**Tests to add.**
- /listings?lens=x&lens=x -> 422, never the whole catalog
- /venues?lens=x&lens=x -> 422
- /listings?prefix=a/&prefix=a/ -> 400 InvalidArgument
- repeated max-keys -> 400

**Verifier notes.** Merged from correctness-security F2 and efficiency-quality-testing F7; both verifiers lowered to low: a lens is a scope, not access control (the same token reads everything), and only a buggy or hand-written client triggers it.

## CAT-13: The 5 MB JSON body is parsed before the token check; the token compare is not constant-time; no rate limiting

- **Severity:** low
- **Category:** security
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/service.ts:5-17`
  - `services/catalog/src/api/index.ts:15-16`
  - `services/catalog/src/api/index.ts:32-40`
  - `packages/service-kit/src/net/servers/express.ts:272-286`

**Problem.** service-kit's #applyBuiltins installs `express.json({ limit })` in the server constructor; requireToken is added later in mount(), so any client that reaches the port can make the single thread JSON.parse up to 5 MB per request before its 401. requireToken compares with `!==`. No rateLimit is configured, though the service.ts docblock claims it.

**Evidence.** express.ts:272-276 #applyBuiltins runs in the constructor; api/index.ts:15 `app.use(requireToken(token))` after; api/index.ts:34 `req.headers['x-catalog-token'] !== token`; service.ts:16 `json: { limit: '5mb' }` with no rateLimit. compose publishes the port to the host.

**Fix.** service.ts: set `json: false` on the server spec and update the docblock (body parsing is done after the token check; give the limits; no rate limiting). In mount(): register requireToken first, then `express.json({ limit: '256kb' })` for everything except POST /listings/report, which gets `express.json({ limit: '5mb' })` as route middleware; move the 5 MB rationale there, stated on its own terms ('a report may name up to MAX_REPORT (10,000) keys'). Check onError still maps body-parser errors (entity.too.large -> 413, entity.parse.failed -> 400). requireToken: hash the configured token once (`createHash('sha256')`), hash the header per request, compare with `timingSafeEqual`. Leave adding a rateLimit to the owner.

**Tests to add.**
- a POST with no token and a 1-2 MB invalid-JSON body -> 401 (not 400), route never ran
- a lens POST over 256 kB -> 413
- a report under 5 MB with the token is accepted; over 5 MB -> 413
- 401 with a wrong token of equal length

**Verifier notes.** Merged from correctness-security F7 and efficiency-quality-testing F19; both verifiers confirmed at low (timing attack near theoretical; the default empty CATALOG_TOKEN opens the API anyway). Coordinate the service.ts docblock wording with CAT-05.

## CAT-14: Partition and listing filters accept malformed values: `settled-before` compared as a raw string, flags parsed three ways, list-type unchecked

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/api/contents.ts:65-66`
  - `services/catalog/src/api/contents.ts:74`
  - `services/catalog/src/api/contents.ts:76`
  - `services/catalog/src/partitions.ts:85-112`
  - `services/catalog/src/listings/s3.ts:33`
  - `services/catalog/src/listings/s3.ts:43`

**Problem.** `settled-before` is passed raw to settledEdge, sorted with run start times and compared with updatedAt as a string: 'garbage' sorts above every ISO stamp so the limit falls away (or is silently ignored when a run is open), and '+01:00' offsets compare wrongly. `settled` is true for anything but 'false' (settled=0 means settled), `downloaded` only for 'true', `pending` for 'true' or '1'. Any list-type other than '2' silently means V1.

**Evidence.** t3.cjs: GET /venues/binance/partitions?settled-before=garbage -> 200 with partitions; settled=0 filtered as settled. contents.ts:66 `!== 'false'`; contents.ts:74 `=== 'true'`; s3.ts:43 `['true','1'].includes(...)`.

**Fix.** In api/query.ts add `flag(raw): boolean | undefined | 'invalid'`: absent -> undefined; '' / 'true' / '1' -> true; 'false' / '0' -> false; else 'invalid'. Use it for settled and downloaded (400 '<name> must be true or false') and for the listing's pending in requestOf (InvalidArgument). Keep `?settled` with an empty value meaning true. settled-before: `const ms = Date.parse(raw)`; 400 'settled-before must be an ISO 8601 instant' when NaN or the input does not start with \d{4}-\d{2}-\d{2}; pass `new Date(ms).toISOString()` so offsets normalise to Z. requestOf: InvalidArgument for list-type other than undefined, '1' or '2'. Document the accepted spellings once in CATALOG-API.md.

**Tests to add.**
- settled=0 lists unsettled partitions; settled=maybe -> 400
- settled-before=garbage -> 400
- settled-before=2026-11-01T00:00:00+01:00 behaves like 2026-10-31T23:00:00.000Z
- downloaded=1 is honoured
- pending=yes -> 400; pending=0 is not pending
- list-type=3 -> 400

**Verifier notes.** Merged from correctness-security F12 and efficiency-quality-testing F8; confirmed at low. The strict Z-only regex suggested by one reviewer was replaced by Date.parse plus normalisation, which accepts valid offsets.

## CAT-15: Catalog docs break CLAUDE.md rules: offerings explained by their consumers, other services' internals, history and dated measurements

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/listings/shape.ts:11-13`
  - `services/catalog/src/listings/shape.ts:17-28`
  - `services/catalog/src/service.ts:10-11`
  - `services/catalog/src/api/index.ts:10-12`
  - `services/catalog/src/api/reports.ts:9`
  - `services/catalog/src/reports.ts:7`
  - `services/catalog/src/api/lenses.ts:15-17`
  - `services/catalog/src/api/lenses.ts:106-108`
  - `services/catalog/src/api/contents.ts:30-32`
  - `services/catalog/src/types.ts:185-190`
  - `services/catalog/src/types.ts:220`
  - `services/catalog/src/types.ts:377-381`
  - `services/catalog/src/queries.ts:26-31`
  - `services/catalog/src/listings/listing.ts:105-108`
  - `services/catalog/src/listings/listing.ts:118-122`
  - `services/catalog/src/listings/s3.ts:12`
  - `docs/modules/CATALOG-API.md:189`
  - `docs/modules/CATALOG-API.md:236`
  - `docs/modules/CATALOG-API.md:301`
  - `docs/services/CATALOG.md:113-119`

**Problem.** CLAUDE.md: a provider's doc never explains an offering by who uses it; no history; not framed around the motivating problem. The catalog is a provider, yet shape.ts says 'Everything here exists for the downloader'; intervalOf's docblock speaks of 'the consumer'; service.ts justifies 5 MB by 'a report forwarded from a downloader'; api/lenses.ts says 'the only consumer that writes here is a form' and 'The editor asks on every change'; api/contents.ts justifies /partitions by 'a consumer that handles partitions whole'; SeriesFilter (types.ts:377-381) justifies `symbol` by another service's 'reconciliation ... destructive decision'; ListingFile.id (types.ts:185-190) documents prospector's VACUUM policy; CATALOG-API.md:189/236/301 describe what a downloader does. History and timings: queries.ts:26-31 ('took a second to read each time ... lens editor'), listing.ts:119-121 ('55 seconds for three pages of gate'), CATALOG.md:114/119 ('Measured on 2026-10-04', '0.2 s on the same day'), s3.ts:12 ('until something needs them').

**Evidence.** Quoted text at the cited lines; grep 'downloader|editor|a form|consumer|Measured on' over services/catalog/src and the two docs.

**Fix.** shape.ts:11-13: 'The listing states what only the shape knows about a file (its interval, its part, its ending), so a key says what the file is without its URL.' (or drop the interval part if CAT-21 deletes intervalOf). service.ts: 5 MB because 'a report may name up to MAX_REPORT (10,000) keys' (moves into mount() with CAT-13). api/index.ts: 'The catalog's public API: listings, contents, lenses, and reports, forwarded to prospector, which settles them.' api/reports.ts, reports.ts, types.ts:220: replace 'a downloader' with 'a client' or state the protocol. api/lenses.ts:17: 'Every write validates first and says what is wrong in a person's words.' api/lenses.ts:106-108: 'Takes the definition in the body, so a definition not yet stored can be sized.' api/contents.ts:30-32: 'A venue's partitions, slice by slice, with their counts and settledness. Unpaged.' Delete the SeriesFilter reconciliation paragraph with the dead fields (CAT-21). ListingFile.id: 'The file row's rowid, which is how prospector names a file.' (drop VACUUM). queries.ts:26-31: 'Held for SERIES_MS: every view folds a venue's series, and the registry changes only when a survey finds an instrument, so a minute-old read is current enough.' listing.ts:105-122: 'The slices are worked out once per page, before the walk; CROSS JOIN fixes the walk order so the series index drives it, in prefix order.' (no 55 s story). CATALOG.md:113-119: state the cost structure without dates (aligned with CAT-06). s3.ts:12: 'Not implemented: delimiter, encoding-type, fetch-owner.' (adjust with CAT-17). CATALOG-API.md:189/236/301: state the guarantee (keys are stable; a file reappears in later walks until reported) without describing a downloader; move downloader behaviour into hauler's doc if it is not already there, with an optional pointer.

**Tests to add.**
- no tests; grep afterwards for 'downloader', 'editor', 'a form', 'Measured on', '55 seconds', 'took a second'

**Verifier notes.** Merged from correctness-security F14 and efficiency-quality-testing F11; confirmed at low. Verifier: 'a downloader' as the generic party of the listing/report protocol (api/index.ts, api/reports.ts) is borderline; rewording is optional there, the rest are clear violations.

## CAT-16: A hand-made marker whose name does not match its series skips keys that sort after it; a `|` in a symbol breaks the cursor and key lookup

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/listings/listing.ts:44`
  - `services/catalog/src/listings/listing.ts:74-89`
  - `services/catalog/src/listings/keys.ts:55`

**Problem.** `startOf` takes the start date from the fifth '|' field of the marker's file name and ignores the folder. In S3, marker/start-after may be any string. For `binance/spot/klines,1m/B/BTCUSDT/201901/a|b|c|d|9` the SQL starts the series at date '9' and skips every file, though every 2020 key sorts after the marker. Likewise `.../201901/a|b|c|d|20190115` skips 20190101..14 although all real 201901 keys sort after it. The split also assumes no '|' in a symbol, which prospector's PREFIX_OF does not forbid; then both the cursor and `filesOfKeys` read the wrong field and such files cannot be reported (NoSuchKey).

**Evidence.** t1.cjs: GET /listings?prefix=binance/&marker=binance/spot/klines,1m/B/BTCUSDT/201901/a|b|c|d|9 -> 200 with Contents []. listing.ts:86 `name.split('|')[4]?.split('.')[0] ?? parts[depth]!`. Service-issued NextMarker values are always well-formed, so only hand-made markers hit this.

**Fix.** In startOf, trust the name's date only when the name is exactly what keyOf would build for that prefix: build `expected = `${venue}|${market}|${dataset}|${depth===4 ? '@' : parts[4]}|`` from parts[0..depth-1] (parts[2] already includes ',variant'); if `name.startsWith(expected)`, date = name.slice(expected.length).split('.')[0]; otherwise date = parts[depth] (the folder), a safe lower bound because rows left of the cursor are dropped key by key (listing.ts:44). In keys.ts filesOfKeys:55, take the date as what follows the expected name prefix, and answer NoSuchKey when the prefix does not match. This also handles '|' in a symbol. (The reviewer's 'smaller of folder and name date' fix is wrong for the 20190115 case.)

**Tests to add.**
- a marker whose name date is '9' still lists the later-month keys of that series
- a marker `<series>/201901/a|b|c|d|20190115` lists the 20190101 file
- a series whose symbol contains '|' (seeded directly) can be listed across pages and reported

**Verifier notes.** correctness-security F8, confirmed at low; the verifier corrected the fix.

## CAT-17: `delimiter` is ignored silently, so a delimiter-aware client misreads a flat listing

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/listings/s3.ts:12-13`
  - `services/catalog/src/listings/s3.ts:28-46`
  - `services/catalog/src/listings/s3.ts:102-112`
  - `services/catalog/src/api/listings.ts:26`

**Problem.** requestOf never reads delimiter, encoding-type or fetch-owner. A delimiter=/ request gets a flat listing with no CommonPrefixes, which a delimiter-aware client treats as valid. max-keys=0, which S3 accepts, is answered 400.

**Evidence.** t1.cjs: /listings?prefix=&delimiter=/&max-keys=2 -> 200 with full keys, no CommonPrefixes; /listings?max-keys=0 -> 400.

**Fix.** In requestOf, when delimiter is present and non-empty, return an error the route answers 501 NotImplemented ('delimiter is not supported; keys are listed flat'); change the return type to `ListingRequest | { status: number; code: string; message: string }` and map it in api/listings.ts:26. Keep ignoring encoding-type and fetch-owner (botocore/AWS CLI add encoding-type=url automatically; ignoring is compatible as long as no EncodingType element is sent), and say in the docblock that they are ignored. Optional: accept max-keys=0 and answer an empty, non-truncated page without querying.

**Tests to add.**
- delimiter=/ -> 501 NotImplemented
- encoding-type=url -> 200 with no EncodingType element
- max-keys=0 (if adopted) -> empty page, IsTruncated false

**Verifier notes.** correctness-security F9, confirmed at low. The reviewer's proposal to refuse encoding-type and fetch-owner was rejected by the verifier (would break standard S3 tooling).

## CAT-18: XML answers can be ill-formed: control characters from the request are echoed raw

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/listings/s3.ts:63-75`
  - `services/catalog/src/listings/s3.ts:88-92`
  - `services/catalog/src/listings/s3.ts:99`
  - `services/catalog/src/api/listings.ts:22-31`

**Problem.** fast-xml-parser escapes & < > ' " but passes C0 control characters and non-characters through. Prefix, Marker, StartAfter, ContinuationToken and the NoSuchLens/NoSuchPartition messages echo request values, so prefix=%01 yields a document conforming XML parsers reject; the client fails with a parse error instead of a clear 400.

**Evidence.** xml.mjs and a verifier rerun: building {Prefix:'a\u0001<&\uFFFE'} yields `<Prefix>a\u0001&lt;&amp;\uFFFE</Prefix>` (raw 0x01 byte).

**Fix.** In requestOf define `const NOT_XML = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;` and return '<param> holds a character XML cannot carry' (400 InvalidArgument) when prefix, marker, start-after, continuation-token or partition matches. In api/listings.ts:22, do not echo a matching slug into NoSuchLens; say 'No such lens'. Refuse rather than strip (a stripped prefix would list something else). Optionally have asXml replace NOT_XML matches with U+FFFD for database-sourced values, and note it in the docblock.

**Tests to add.**
- GET /listings?prefix=%01 -> 400 InvalidArgument, body is well-formed XML (XMLValidator)
- a prefix with & and < is escaped: `<Prefix>a&lt;&amp;</Prefix>`

**Verifier notes.** Merged from correctness-security F10 and efficiency-quality-testing F16; confirmed at low. The reviewers' regexes arrived garbled; the one above is spelled with escapes.

## CAT-19: PUT/DELETE /lenses/:slug forward unvalidated slugs (`..` reaches prospector's root) and relay non-JSON answers

- **Severity:** low
- **Category:** security
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/api/lenses.ts:75-103`
  - `services/catalog/src/api/lenses.ts:144-157`
  - `services/catalog/src/prospector.ts:19-31`
  - `services/catalog/src/prospector.ts:45-50`

**Problem.** PUT and DELETE forward `encodeURIComponent(slug)` without lensNameIsSound. encodeURIComponent leaves '.', and WHATWG URL resolves dot segments, so '..' or '%2E%2E' becomes http://prospector:8080/ and '.' becomes /lenses/. Nothing else is reachable today, but the request leaves the lens namespace, and prospector's express HTML 404 ('Cannot DELETE /') is relayed via res.json(<html string>).

**Evidence.** `new URL('http://prospector:8080/lenses/' + encodeURIComponent('..')).href` -> 'http://prospector:8080/'. prospector.ts parsed() returns raw text for non-JSON; lenses.ts:150-153 sends it with res.json.

**Fix.** In PUT and DELETE, answer `res.status(404).json({ error: 'No such lens' })` when `!lensNameIsSound(slug)` (with the typeof guard from CAT-02), before forwarding. In stored(), when `typeof answer.body === 'string'`, log {status, body} at warn and answer `res.status(answer.status >= 500 ? 502 : answer.status).json({ error: 'The collector refused the request' })`.

**Tests to add.**
- PUT and DELETE /lenses/%2E%2E -> 404 and send() not called (mock fetch)
- a mocked prospector answering text/html 404 gives a JSON error body

**Verifier notes.** correctness-security F11, confirmed at low; the other lens rated the traversal harmless today but agreed rejecting '.'/'..' makes it airtight.

## CAT-20: Every lensed request resolves the full lens scope and reads the lens twice, even where only its id is used; the scope cache is global

- **Severity:** low
- **Category:** efficiency
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/lenses/requested.ts:18-23`
  - `services/catalog/src/lenses/scope.ts:16-45`
  - `services/catalog/src/lenses/scope.ts:149`
  - `services/catalog/src/api/listings.ts:21`
  - `services/catalog/src/api/reports.ts:20`
  - `services/catalog/tests/contents.test.ts:40`

**Problem.** lensRequested calls lensNamed (SELECT * plus JSON.parse), then lensScope(slug), which calls lensNamed again and runs a separate partitions_through select; after each catch-up step it rescans lens_member. /listings and /listings/report use only `lens.id`. SCOPES is a module-global Map keyed by slug: not per database (tests clear it through `_test_scopes`), never drops deleted lenses.

**Evidence.** requested.ts:19-21; scope.ts:17-21; api/listings.ts reads only lens?.lens and lens?.lens?.id; api/reports.ts only lens?.lens. Cost is modest: a stable lens costs two small reads and a JSON.parse per request.

**Fix.** Add `lensOf(db, req): Lens | null | undefined` (one lensNamed; undefined for an unknown slug) for api/listings.ts and api/reports.ts; keep a scoped `lensRequested` that calls `lensScope(db, lens)` for contents. Change lensScope to take the Lens already read; read updated_at and partitions_through in one statement prepared once per db. Key the cache `WeakMap<DatabaseSync, Map<number, HeldScope>>` by lens id; remove `_test_scopes` and the clear in contents.test.ts:40.

**Tests to add.**
- listing through a lens does not build the scope (spy on lensScope)
- a scope cached on one database is not served for another database with the same slug

**Verifier notes.** efficiency-quality-testing F9; verifier lowered from medium to low (cached after the first build; recreated-lens collision practically impossible).

## CAT-21: Dead exports, dead filter branches and an unused production function with a long docblock

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/listings/shape.ts:17-36`
  - `services/catalog/src/vocabulary.ts:49-53`
  - `services/catalog/src/partitions.ts:15-16`
  - `services/catalog/src/partitions.ts:131-134`
  - `services/catalog/src/queries.ts:14-15`
  - `services/catalog/src/queries.ts:33-44`
  - `services/catalog/src/queries.ts:101-103`
  - `services/catalog/src/types.ts:5-6`
  - `services/catalog/src/types.ts:119`
  - `services/catalog/src/types.ts:124-129`
  - `services/catalog/src/types.ts:383-408`
  - `services/catalog/src/contents.ts:102-107`

**Problem.** `slicesOf` (and its prepared `slices` statement), `venues` (and VenueRow), `nextMonth` have no callers; `intervalOf` (with a 20-line docblock of venue facts) is used only by tests/shape.test.ts, so it reads as an offering the listing does not have. SeriesFilter's live/symbol/symbols fields and their seriesFor branches are never set by any caller; Series.urlSymbol and retiredAt are read only by those branches. 9 type re-exports are unused. partitionsOfVenue is a trivial wrapper.

**Evidence.** `npx knip --workspace services/catalog --include exports` reports slicesOf, venues, nextMonth and 9 unused exported types. grep: intervalOf only in shape.ts and tests/shape.test.ts. Both seriesFor callers (contents.ts:60, :88) pass only market, dataset, variant, grain.

**Fix.** Delete slicesOf, the `slices` statement and PartitionStatements.slices (and Slice if unused); venues and VenueRow; nextMonth; intervalOf with DURATION/BYBIT_MINUTES if unused elsewhere and its tests (tests/shape.test.ts:12-34; keep the extensionOf tests); the unused type re-exports in types.ts:5-6; live/symbol/symbols in SeriesFilter with their seriesFor branches and the 'explicit empty symbols' docblock sentences. Stop selecting url_symbol and retired_at and drop urlSymbol/retiredAt from Series only after checking no API response or catalog-ui exposes them. Optionally inline partitionsOfVenue as `partitionContents(db, name, filter, lens?.lens ?? null)`. Do NOT edit knip.json (it already covers services/**); instead add a root `"knip": "knip"` script and run it in `check`/CI. Run tsc and knip afterwards.

**Tests to add.**
- tsc and the suite pass; knip reports no unused exports in services/catalog

**Verifier notes.** Merged from correctness-security F17 and efficiency-quality-testing F13; confirmed at low. Correction: the reviewer's 'add services/catalog to knip' is wrong; knip.json already covers it, but knip is never run.

## CAT-22: Duplicated helpers and one name with two meanings (BUCKET)

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/listings/s3.ts:22`
  - `services/catalog/src/listings/keys.ts:131`
  - `services/catalog/src/vocabulary.ts:11`
  - `services/catalog/src/vocabulary.ts:14`
  - `services/catalog/src/listings/s3.ts:126-127`
  - `services/catalog/src/api/contents.ts:126-127`
  - `services/catalog/src/api/contents.ts:46-50`
  - `services/catalog/src/api/contents.ts:95-99`
  - `services/catalog/src/prospector.ts:16-41`
  - `services/catalog/src/reports.ts:82-115`
  - `shared/lenses/src/draft.ts:208`
  - `shared/lenses/src/types.ts:12`

**Problem.** BUCKET is 'catalog' in s3.ts but the venue-wide symbol '@' in vocabulary.ts, and keys.ts redefines '@' privately. text() is copied in s3.ts and api/contents.ts; the grain check and 400 message twice in api/contents.ts; the retry loop (ATTEMPTS=3, RETRY_MS=500) in prospector.ts and reports.ts; GRAINS duplicates shared/lenses' private GRAINS, whose Grain type is a separate literal union.

**Evidence.** s3.ts:22 `export const BUCKET = 'catalog'`; vocabulary.ts:11 `export const BUCKET = '@'`; keys.ts:131 `const BUCKET = '@'`; reports.ts:114-115 duplicates prospector.ts:41-42.

**Fix.** Rename s3.ts's constant BUCKET_NAME and vocabulary.ts's VENUE_WIDE; import it in keys.ts and update contents.ts. Create api/query.ts with text()/queryText (CAT-12), flag (CAT-14) and `grainOf(req, res): Grain | undefined | null` (null = 400 answered); use it in both contents handlers and in s3.ts. Make settle a wrapper over send so only prospector.ts carries the retry (with CAT-04); delete reports.ts's ATTEMPTS/RETRY_MS. In shared/lenses export GRAINS and BUNDLES and derive `type Grain = typeof GRAINS[number]`; import them in vocabulary.ts and api/contents.ts; rebuild shared/lenses before the catalog tsc.

**Tests to add.**
- existing reports and contents grain-400 tests still pass
- settle on a non-2xx is not retried (with CAT-04/CAT-25)

**Verifier notes.** efficiency-quality-testing F14, confirmed at low. The BUCKET confusion is latent (only contents.ts imports vocabulary's).

## CAT-23: Unknown routes answer Express's HTML 404, not the documented JSON or S3 error shape

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/api/index.ts:14-24`

**Problem.** mount installs routes and onError but no fallback for unmatched paths, so Express's finalhandler answers text/html 'Cannot GET /x'. CATALOG-API.md says errors answer {"error": "..."} and the listing family answers in S3's Error shape.

**Evidence.** GET /nope -> 404 text/html `<!DOCTYPE html>...<title>Error</title>`. /ping is registered in the server constructor, before mount, so a fallback in mount cannot shadow it.

**Fix.** In mount, after mountLenses and before app.use(onError): `app.use((req, res) => { if (req.path === '/listings' || req.path.startsWith('/listings/')) return failed(req, res, 404, 'NoSuchKey', 'No such resource'); res.status(404).json({ error: 'Not found' }); });` (import failed from './listings'). It sits after requireToken, so unknown paths without the token still answer 401.

**Tests to add.**
- GET /nope -> 404 application/json {error:'Not found'}
- DELETE /venues -> JSON 404
- GET /listings/x -> 404 XML Error with Code NoSuchKey

**Verifier notes.** efficiency-quality-testing F15, confirmed at low.

## CAT-24: Read-only connection sets no busy_timeout

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/src/database.ts:26`

**Problem.** Prospector opens the WAL database with busy_timeout 5000; the catalog's read-only connection has 0. A WAL reader can briefly meet SQLITE_BUSY during WAL-index recovery after a prospector restart or while the last connection checkpoints; with 0 the read throws and the caller sees a 500.

**Evidence.** database.ts:26 `new DatabaseSync(path, { readOnly: true })`; verifier on Node 22: `PRAGMA busy_timeout` reads {timeout: 0}; prospector schema.ts:541 'PRAGMA busy_timeout = 5000'. Verifier confirmed the `timeout` option works on a read-only connection.

**Fix.** `return new DatabaseSync(path, { readOnly: true, timeout: 2_000 });` Keep it short (synchronous wait on the only thread). Add a docblock sentence: a reader can briefly meet a lock while prospector recovers or checkpoints the log, and waits rather than failing the request.

**Tests to add.**
- readonly.test.ts: `expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 2000 })`

**Verifier notes.** efficiency-quality-testing F17, confirmed at low.

## CAT-25: Retry tests wait on real timers and never count attempts

- **Severity:** low
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/catalog/tests/lens.api.test.ts:228-240`
  - `services/catalog/tests/listings.test.ts:482-486`
  - `services/catalog/src/prospector.ts:34`
  - `services/catalog/src/reports.ts:100`

**Problem.** 'says so where prospector is not answering' and 'says the collector is not answering rather than failing' each wait the real 500+1000 ms backoff (about 4 s per run with the drops-once test). No test counts attempts or checks that a refusal status is never retried.

**Evidence.** Verbose run: 1566 ms and 1744 ms for the two tests, 700 ms for 'settles the report when prospector drops the connection once'. No useFakeTimers anywhere. The stubbed fetch in lens.api.test.ts:231 does not count calls; the only prospector() stand used is prospector(200, 1).

**Fix.** Make the retry delay injectable from one place (e.g. config.retryMs, default 500, or a shared retry helper per CAT-22) and set it to 0/1 in tests/setup.ts. Avoid faking setTimeout globally: the listings test uses real sockets and undici timers.

**Tests to add.**
- lens.api.test.ts: a fetch stub that always throws a connection error gives 502 after exactly 3 calls
- lens.api.test.ts: prospector answering 409/500 gives exactly 1 call and the status relayed
- listings.test.ts: with prospector(500) the report answers the CAT-04 mapping (502 CollectorError) and stand.got has length 1
- the drops-once test still passes; suite wall time drops by about 4 s

**Verifier notes.** efficiency-quality-testing F23, confirmed at low; verifier preferred an injectable delay over fake timers.

## CAT-26: The public API container mounts the whole repository read-write in every environment

- **Severity:** low
- **Category:** config
- **Decision:** DEFER
- **Locations:**
  - `services/catalog/docker/compose.yml:37-39`
  - `docker/dev.node.Dockerfile:17`
  - `dx/utils/docker.js`

**Problem.** compose.yml mounts `../../../:/live` (the whole monorepo, including any root .env) into the internet-facing catalog container whatever APP_ENV is. Only the dev Dockerfile uses /live; in prod a compromised catalog process gets read-write access to every service's source and configuration.

**Evidence.** compose.yml:38 `- ../../../:/live`; dev.node.Dockerfile `WORKDIR /live`; prod.node.Dockerfile copies into /app and never references /live. The same mount exists in services/{catalog-ui,hauler,hoarder,pipe,prospector,router,stocker}/docker/compose.yml.

**Fix.** Repo-wide: have dx (dx/utils/docker.js) add a docker/compose.dev.yml override (per module or shared) holding the /live mount only when APP_ENV=dev, and remove it from every services/*/docker/compose.yml. In prod the catalog mounts only `${CATALOG_DIR}:/data/catalog`, read-only if the -shm file can still be shared under :ro (check first).

**Tests to add.**
- `docker compose config` for APP_ENV=prod shows no /live mount; dev still runs from /live

**Verifier notes.** correctness-security F16, confirmed at low, deferred because it is a repo-wide tooling decision; fixing only the catalog would make it the odd one out.

## CAT-27: The shared lens package's behaviour is tested from the catalog's suite

- **Severity:** low
- **Category:** testing
- **Decision:** DEFER
- **Locations:**
  - `services/catalog/tests/lens.test.ts:6-8`
  - `services/catalog/tests/members.test.ts:5-7`
  - `services/catalog/tests/fixture.ts:5`
  - `shared/lenses/tests/spans.test.ts`

**Problem.** lens.test.ts (rule evaluation, storage, problems, sizes) and members.test.ts (lens_member upkeep, catchUp, preferred forms) import only from @tradebot/lenses and the fixture; members.test.ts exercises writes the catalog never performs. shared/lenses/tests has only spans.test.ts, so the package's own test run misses most of its behaviour, against the repo's dependency-direction rule.

**Evidence.** lens.test.ts:6 imports from '@tradebot/lenses' only (plus a LensDefinition type); members.test.ts:5 imports catchUp, editLens, lenses, lensNamed, putLens. catchUp/putLens/editLens/dropLens are called only from services/prospector/src. 14 tests in shared/lenses vs 56 in the two catalog files.

**Fix.** After CAT-07 gives one schema source: create shared/lenses/tests/fixture.ts (openScratch plus the write helpers the two files need), building tables from the shared schema; move lens.test.ts and members.test.ts there; keep in the catalog only tests that go through catalog code (lens.api.test.ts, contents and listing tests through a lens); keep catalog fixture helpers still used there.

**Tests to add.**
- `pnpm --filter @tradebot/lenses test` runs about 70 tests; the catalog suite still passes

**Verifier notes.** efficiency-quality-testing F22, confirmed at low, deferred: the move needs a schema the lens package can build from without duplicating prospector's (depends on CAT-07 and possibly a shared schema package).

## CAT-28: extensionOf logs a warning per listed file on every request

- **Severity:** low
- **Category:** efficiency
- **Decision:** DEFER
- **Locations:**
  - `services/catalog/src/listings/shape.ts:46-50`
  - `services/catalog/src/listings/shape.ts:60-66`
  - `services/catalog/src/listings/shape.ts:89-94`
  - `services/catalog/src/listings/keys.ts:24-31`
  - `services/catalog/src/listings/keys.ts:92`

**Problem.** `assumed()` warns every time a file with no usable extension is keyed. keyOf runs for every row of every page and for every file of a series' day in filesOfKeys, so one unrecognised family produces up to max-keys warn lines per page per walk.

**Evidence.** shape.ts:90-93 warns on every call; keys.ts:30 calls extensionOf inside keyOf. The behaviour is documented as intended (shape.ts:48-50 'said aloud, every time it is listed', :89 'Said each time, so that it is met early'); gate's known misnamed families are already in KNOWN.

**Fix.** If the owner agrees: a module-level Set (capped at about 1,000) keyed by `${dirname(path)}|${ending}`; warn only on the first sighting; update the docblocks to 'said once per directory per process'.

**Tests to add.**
- shape.test.ts: spy on logger.warn; two extensionless files in one directory give one warning

**Verifier notes.** efficiency-quality-testing F18, confirmed at low, deferred because throttling reverses a stated design choice.

## Deferred — decisions needed

- **CAT-09** (Listing pages still sort the whole remainder of the cursor prefix group; removing that needs a page-reader redesign): Is a redesign of the listing page reader (per-series indexed reads merged in JS, or month-by-month widening) worth doing now, given current prefix groups are thousands of files? If series of minute files or many parts per day are expected, approve it; otherwise accept the per-page sort and keep the corrected docs from CAT-06.
- **CAT-10** (Long report settlements and retried creates: synchronous settlement can outlast any sane timeout): How should long settlements work: should prospector answer 202 and confirm in the background, or should the catalog cap failed+mismatched keys per report (and at what size)? And should a create whose response was lost be reconciled with a follow-up GET?
- **CAT-26** (The public API container mounts the whole repository read-write in every environment): Should the /live source mount move into a dev-only compose override for all services (via dx), and may the catalog mount its data directory read-only in prod?
- **CAT-27** (The shared lens package's behaviour is tested from the catalog's suite): Where should the canonical CATALOG_SCHEMA live so shared/lenses tests can use it: a test-only relative import of prospector's schema.ts, or a new shared package (e.g. shared/catalog-schema)?
- **CAT-28** (extensionOf logs a warning per listed file on every request): Keep warning on every listing of an unrecognised file family (loud by design), or warn once per directory per process?

## Rejected

- **File dates reach yyyymmddhh(mi) and docs saying 'a month or a day' are wrong (part of correctness-security F13, item 8)**: Refuted by the verifier: every adapter's dateOf yields 6 or 8 digits (gate cuts its 10-digit stamps to the day, gate.ts:58-59). Only the `.partNN` notation is changed (CAT-05).
- **Refuse encoding-type and fetch-owner with 501 (part of correctness-security F9)**: botocore/AWS CLI add encoding-type=url automatically; refusing would break standard S3 tooling. Ignoring is compatible as long as no EncodingType element is sent. Only delimiter is refused (CAT-17).
- **Add services/catalog to knip's checked workspaces (part of correctness-security F17)**: knip.json already covers services/**; the gap is that knip is never run. CAT-21 adds a script instead.
- **Use the marker name's date whenever it starts with the folder month (correctness-security F8's suggested fix)**: Still skips keys for markers like `.../201901/a|b|c|d|20190115`; replaced by the exact-expected-name check in CAT-16.
- **Validate settled-before with a strict Z-only regex (efficiency-quality-testing F8 suggested fix)**: Would reject valid ISO offsets; replaced by Date.parse plus toISOString normalisation (CAT-14).
