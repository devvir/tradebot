# docs-catalog: consolidated review

## Overall assessment

The catalog's wire behaviour is mostly documented correctly: endpoints, key format, S3 V1/V2 handling, settled semantics and lens evaluation match the code. The serious problems are architecture claims, fiction and rule breaches. (1) Five places say the catalog writes the `lens` table and prospector never reads it. In fact the catalog opens the database read-only, and prospector is the only writer and reads lenses constantly. (2) CATALOG-LENSES says closedness is never asked of the catalog, but the `settled` partitions API exists, and stocker and cold push rely on it. (3) CATALOG-UI.md describes lens-editor controls that do not exist: an instrument search, `every` labels, 'Both/Per instrument/Buckets', and refusals the catalog never makes. It credits prospector's /status facts to 'the catalog', claims an abort is passed on that the proxy drops, and is full of history. (4) UI.md and the _stub/ui README describe an architecture that was never built, env vars nothing reads, a `tb` target that does not exist, and two backends that are gone (BitMEX closed on 2026-09-23, digger retired). (5) Provider docs name their consumers, and settled, lens-through-contents and reporting each have two or three homes. (6) planning/CATALOG.md lists landed work, and ROADMAP links to an anchor and a file that do not exist. Two small code defects were found while verifying: the catalog-ui proxy does not pass aborts on, and `withdrawn` under a lens is the whole venue's. Both are bounded and fixing them is recommended over documenting the defect.

Recommended fresh-start structure: (a) docs/modules/CATALOG-API.md is the only reference for the wire contract (endpoints, params, fields, errors, wire meaning of settled), with no consumer narrative. (b) docs/modules/CATALOG-LENSES.md is the only home for what a lens is (definition, rules, refusals, resolution, members/rebuild, size, and how every endpoint narrows under a lens). Its consumer sections are cut. (c) docs/services/CATALOG.md is the implementation doc: read-only DB, forwarding to prospector (correct retry/502 semantics), the shared @tradebot/lenses package, how pages and lens walks are queried, what is cached, and the stillWanted check. It points to (a) and (b) instead of restating them. (d) docs/services/CATALOG-UI.md shrinks to about a third: proxy/token, routing, the three sections, Surveys polling and order-holding (attributed to prospector /status), and what the page derives itself. History, restated lens and /status semantics, control-by-control layout prose and dev instructions are cut. (e) docs/services/UI.md leaves the tech docs; any time-machine design worth keeping moves to docs/planning/UI.md. (f) READMEs become minimal: purpose, complete env table, commands, links. (g) planning/CATALOG.md loses its landed items; whether to rename or split it is an owner decision. Neighbouring docs that repeat the same errors must be fixed in the same change, so the contradictions do not survive there: ARCHIVES.md:33-35, the archives .env.example ('another machine'), PROSPECTOR.md:2045-2047 and the PROSPECTOR.md status table.

## Summary

| id | severity | category | decision | title |
|---|---|---|---|---|
| DCAT-01 | high | docs | IMPLEMENT | Docs say the catalog writes the lens table and prospector never reads it; prospector is the only writer |
| DCAT-02 | medium | docs | IMPLEMENT | CATALOG-LENSES 'Who reads through one' is wrong about readiness, and provider docs name their consumers |
| DCAT-03 | medium | correctness | IMPLEMENT | catalog-ui proxy does not pass the browser's abort on, so the documented cancellation never takes effect |
| DCAT-04 | medium | correctness | IMPLEMENT | Under a lens, /venues reports the whole venue's `withdrawn`, and `series` always reads n/n |
| DCAT-05 | medium | docs | IMPLEMENT | UI.md and the _stub/ui README describe an unbuilt architecture, unread env vars and gone backends |
| DCAT-06 | medium | docs | IMPLEMENT | CATALOG-UI describes lens-editor controls that do not exist |
| DCAT-07 | medium | docs | IMPLEMENT | CATALOG-UI and the catalog-ui README claim refusals and pre-save sizing the catalog does not do |
| DCAT-08 | medium | docs | IMPLEMENT | CATALOG-UI credits prospector's /status facts to 'the catalog' and to 'this process' |
| DCAT-09 | medium | docs | IMPLEMENT | History phrasing across CATALOG-UI, CATALOG-LENSES and Surveys.tsx; stale 'killed container' claim in PROSPECTOR.md |
| DCAT-10 | medium | docs | IMPLEMENT | CATALOG-API: second host 'never in responses', wrong books variant keys, 'catalog probes', incomplete interval row |
| DCAT-11 | medium | docs | IMPLEMENT | CATALOG.md says nothing is shared in code with prospector, but both use @tradebot/lenses |
| DCAT-12 | low | docs | IMPLEMENT | Forwarding to prospector: retry count, 502 meaning and lens-write retries are misdescribed |
| DCAT-13 | low | docs | IMPLEMENT | CATALOG-API error table and S3-error claim are incomplete |
| DCAT-14 | low | docs | IMPLEMENT | Small inaccuracies in CATALOG-API's listing, contents and key-grammar sections |
| DCAT-15 | low | docs | IMPLEMENT | Catalog caches are undocumented, so contents and lens options can be minutes old |
| DCAT-16 | low | docs | IMPLEMENT | Settled, lens-filtered contents, reporting and lens rule semantics each have several homes |
| DCAT-17 | low | docs | IMPLEMENT | Wrong catalog-ui build and dev instructions, stated in two places |
| DCAT-18 | low | docs | IMPLEMENT | Catalog README restates endpoints incompletely and omits CATALOG_DB |
| DCAT-19 | low | docs | IMPLEMENT | shared/lenses and catalog docblocks contradict the code (rule order, bound format, resolve answer) |
| DCAT-20 | low | docs | IMPLEMENT | planning/CATALOG.md lists landed work and duplicates a note; ROADMAP links to a missing anchor and a missing file |
| DCAT-21 | low | docs | IMPLEMENT | 'the catalog may run on another machine' reads as contradicting the same-host requirement |
| DCAT-22 | low | docs | IMPLEMENT | Dated benchmarks and advocacy framing in CATALOG.md and CATALOG-UI.md |
| DCAT-23 | low | docs | DEFER | Rename or split planning/CATALOG.md, and decide whether ROADMAP's 'data we do not want' item is solved |

## DCAT-01: Docs say the catalog writes the lens table and prospector never reads it; prospector is the only writer

- **Severity:** high
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/modules/CATALOG-LENSES.md:13-16`, `docs/modules/CATALOG-LENSES.md:148-149`, `docs/modules/ARCHIVES.md:29-35`, `services/catalog/docker/compose.yml:4-6`, `services/catalog/src/config.ts:9-10`, `services/catalog/src/types.ts:19`, `docs/services/CATALOG.md:11-23`

**Problem.** CATALOG-LENSES.md:13-16 says 'the catalog writes the `lens` table (the one table it writes) and prospector never reads it'. The same doc at :148-149, CATALOG.md:11-23 and the code all say prospector writes both tables. The false version is repeated in ARCHIVES.md:33-35 ('the catalog writes the `lens` table and nothing else'), the compose comment ('It writes only lenses'), the config.ts docblock ('to read it and to store lenses') and the types.ts:19 comment. An engineer who follows it would write through a read-only connection.

**Evidence.** services/catalog/src/database.ts:26-27 has `new DatabaseSync(path, { readOnly: true })`, and there is no INSERT, UPDATE or DELETE in services/catalog/src. api/lenses.ts forwards POST/PUT/DELETE through `stored()` to prospector's `send()`, and its docblock says 'A lens is stored by prospector, never here'. Prospector writes lenses with putLens/editLens/dropLens (prospector/src/api/lenses.ts:37,53,69). It also reads them: `catchUp(db, lens, STEP)` (prospector/src/lenses.ts:53) and `admit(db, lenses(db), id)` (prospector/src/catalog/cache/partitions.ts:152).

**Fix.** 1. CATALOG-LENSES.md:13-16: replace the paragraph with 'Lenses are defined, checked and read through the catalog's API; prospector, the database's only writer, stores them and keeps `lens_member` current (see CATALOG.md#one-database-one-writer).' Keep only one of this sentence and the :148-149 paragraph. Do not say prospector never reads lenses.
2. ARCHIVES.md:33-35: replace with 'A lens is a consumer's choice of what to read, so it is defined and checked through the catalog; prospector stores it like every other row, and the catalog opens the database read-only.' Add storing lenses to prospector's private API list at :29-30.
3. services/catalog/docker/compose.yml:4-6: change the comment to 'It opens the database read-only and writes nothing; lens writes and download reports are forwarded to prospector, which owns every row.'
4. services/catalog/src/config.ts:9-10: change to 'this service opens the same file read-only'.
5. services/catalog/src/types.ts:19: change to 'The catalog database prospector keeps, opened here read-only.' Rebuild so dist follows.
6. Check: `grep -rn "store lenses\|writes only lenses\|catalog writes" --include='*.md' --include='*.ts' --include='*.yml' . | grep -v node_modules | grep -v dist` returns nothing.

**Tests to add.** None (docs and comments only). Run tsc for the comment edits.

**Verifier notes.** Both verifiers confirmed at high severity. The first verifier also found types.ts:19. The second asked that ARCHIVES.md's private-API list be extended so its two paragraphs agree.

## DCAT-02: CATALOG-LENSES 'Who reads through one' is wrong about readiness, and provider docs name their consumers

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/modules/CATALOG-LENSES.md:8-9`, `docs/modules/CATALOG-LENSES.md:196-210`, `docs/modules/CATALOG-API.md:110-121`, `docs/modules/CATALOG-API.md:188-190`, `docs/modules/CATALOG-API.md:299-305`, `services/catalog-ui/README.md:25-26`, `services/catalog/src/partitions.ts:66-102`, `services/stocker/src/catalog.ts:22-26`, `docs/tooling/COLD-PUSH.md:16-21`

**Problem.** CATALOG-LENSES.md:204-207 says readiness is reached once every file a lens lists is on disk, and that whether a month is closed 'is never asked of the catalog'. The catalog serves `settled` and `settled-before` on /venues/:venue/partitions, and stocker and cold push decide readiness with them. The surrounding section and several other passages also explain the provider by its consumers, against CLAUDE.md's dependency rule:
- CATALOG-LENSES.md:8-9 ('hauler downloads through one, stocker builds through one, cold storage decides through one').
- :196-210: downloader deployments, stocker, cold storage and PROSPECTOR_VENUES.
- CATALOG-API.md:188-190 ('This is what a downloader walks').
- CATALOG-API.md:299-305: the downloader re-lists and re-reports, plus hauler's adoption, which HAULER.md:192 already owns.
- The catalog-ui README:25-26 ('such as the one hauler downloads').

**Evidence.** partitions.ts:66-102 implements `settledEdge`. stocker/src/catalog.ts sends `downloaded=true` and `'settled': 'true'`. COLD-PUSH.md:16-21 asks the partitions endpoint with `downloaded=true` and `settled`. HAULER.md:192 has '### Adopting an archive that already exists'.

**Fix.** CATALOG-LENSES.md:
- :8-9 becomes 'It is how a consumer says what it wants without the catalog changing. The endpoints are in CATALOG-API.md; the editor is in CATALOG-UI.md.'
- Delete the readiness paragraph :204-207 outright.
- Replace the rest of :196-210 with one provider-side statement under 'Reading through a lens': '**Pending is the file's, not the lens's.** A file reported downloaded through any lens is no longer pending through any other.' Keep 'a lens never scopes collection' (already said on the catalog's terms) and drop the PROSPECTOR_VENUES sentence.
- Move the 'disjoint lens per downloader' advice to HAULER.md, and readiness-against-a-complete-lens to STOCKER.md and the cold docs, if they do not already say it.
CATALOG-API.md:
- Add one line to the partitions section: 'A lens narrows which partitions are listed; `settled` and `downloaded` say whether each is complete enough to act on.'
- :188-190 becomes 'The catalog as one storage bucket: every venue's files, in S3's shape, each keyed by what the file *is*. A report names files by the same key.'
- :299-305 becomes 'A report is prospector's to settle: the catalog resolves each key to its file and forwards it. Where prospector does not answer or refuses, the report is a `502` and nothing was recorded. Settling the same report twice is harmless, so it can simply be sent again.' Drop the adoption sentence.
catalog-ui README: drop 'such as the one hauler downloads' (done in DCAT-07's README rewrite).

**Tests to add.** None.

**Verifier notes.** Merges reviewer F3 (high) and F10 (medium). The first verifier lowered F3 to medium: CATALOG-API and the consumer docs carry the correct behaviour, and nothing executes this paragraph. It also rejected deleting the section wholesale, because the 'pending is per file' fact is the catalog's own behaviour and must survive.

## DCAT-03: catalog-ui proxy does not pass the browser's abort on, so the documented cancellation never takes effect

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/src/api/routes.ts:52-75`, `services/catalog/src/api/index.ts:50`, `docs/services/CATALOG-UI.md:361-363`, `docs/services/CATALOG.md:143-148`

**Problem.** CATALOG-UI.md:361-363 says leaving a view aborts the request in flight and 'the catalog does not start work for a client that has gone'. CATALOG.md:143-147 says the same of an editor that has moved on. The browser does abort its fetch to catalog-ui, but `forward()` calls `fetch(url, ...)` with no AbortSignal and never watches for the client leaving. The upstream connection stays open, the catalog's `stillWanted` sees `req.socket.destroyed === false`, and the work runs anyway. The only editor that exists reaches the catalog through this proxy.

**Evidence.** routes.ts forward(): `const answer = await fetch(url, { method: req.method, headers: {...}, ...body })`, with no `signal` and no close listener. api/index.ts stillWanted: `if (req.socket.destroyed) return; next();`.

**Fix.** Fix the code so the docs become true. In services/catalog-ui/src/api/routes.ts forward():
```ts
const gone = new AbortController();
if (req.method === 'GET' || req.method === 'HEAD')
  res.on('close', () => { if (! res.writableFinished) gone.abort(); });
const answer = await fetch(url, { ..., signal: gone.signal });
```
In the catch, when `gone.signal.aborted`, return without logging and without a 502. Listen on `res`, not `req`: on Node 22, `req` 'close' fires once the body is consumed by express.json(). Do not cancel writes (POST/PUT/DELETE). Then CATALOG-UI.md:361-363 can stay. Make CATALOG.md:143-147 say the check is on the connection the catalog itself sees, which the proxy closes when its browser leaves.
Fallback if the code is not changed: CATALOG-UI.md:361-363 becomes 'Leaving a view aborts the browser's request; the proxy does not pass the cancellation on, so the catalog still answers it', and CATALOG.md:143-147 is scoped to direct clients.

**Tests to add.** In catalog-ui tests: start a stub upstream that holds its answer, for example for 2 s. Make a GET through forward, then destroy the client socket. Assert that the upstream request's socket closes, or its 'close' event fires, before the delay ends, and that no 502 or warn is logged. A second test checks that a POST is not aborted when the client leaves.

**Verifier notes.** The verifier confirmed the defect and corrected the reviewer's fix (use res.on('close') with writableFinished, GET/HEAD only).

## DCAT-04: Under a lens, /venues reports the whole venue's `withdrawn`, and `series` always reads n/n

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog/src/contents.ts:63-74`, `services/catalog/src/lenses/figures.ts:14-28`, `services/catalog/src/queries.ts:47-61`, `docs/modules/CATALOG-API.md:80`, `docs/modules/CATALOG-LENSES.md:191-193`

**Problem.** CATALOG-API.md:80 says 'Under a lens every figure is the lens's'. In venueContents the lensed branch spreads `...row` from venueTotals and overrides files, bytes, pending, pendingBytes and the months, but not `withdrawn`, so `withdrawn` stays the venue's. `series` becomes `{ withFiles: inside, total: inside }`, so the pair always reads n/n under a lens.

**Evidence.** contents.ts:63-73 returns `{ ...row, firstMonth, lastMonth, files, bytes, pending, pendingBytes, series: { withFiles: inside, total: inside }, hosts }` with no `withdrawn`. lensFigures does not select withdrawn. venueTotals has `COALESCE(SUM(m.withdrawn),0) AS withdrawn` over the whole venue. Impact is limited: catalog-ui renders withFiles/total only in Surveys, which sends no lens.

**Fix.** Code: in services/catalog/src/lenses/figures.ts add `COALESCE(SUM(q.withdrawn), 0) AS withdrawn`, add `withdrawn: number` to LensVenueFigures in types.ts, and set `withdrawn: figures.withdrawn` in contents.ts:63-73. savedLensSize is unchanged. Docs: in CATALOG-LENSES.md#reading-through-a-lens (the single home, see DCAT-16), state that under a lens every figure including `withdrawn` is the lens's, and that `series` counts the series dated inside the lens, so `withFiles` equals `total`. CATALOG-API.md:80 points there.

**Tests to add.** In the catalog contents tests, build a venue with a withdrawn file in a partition outside a lens and none inside it. Assert that GET /venues with x-catalog-lens returns withdrawn 0 and series.withFiles === series.total, and that GET /venues without the lens returns withdrawn 1.

**Verifier notes.** Confirmed medium. The fix chosen is the code fix plus a doc clarification for series.

## DCAT-05: UI.md and the _stub/ui README describe an unbuilt architecture, unread env vars and gone backends

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/services/UI.md:21`, `docs/services/UI.md:45`, `docs/services/UI.md:53`, `docs/services/UI.md:70`, `docs/services/UI.md:88`, `docs/services/UI.md:123-127`, `docs/services/UI.md:131`, `services/_stub/ui/README.md:12-18`, `services/_stub/ui/docker/compose.yml:19-21`, `services/_stub/ui/vite.config.ts:16-21`, `services/_stub/ui/src/components/EnvSwitcher.tsx:4`, `services/_stub/ui/src/data/envs.ts:5`, `docs/DATA_PIPELINE.md:152-157`

**Problem.** UI.md:
- It is a design plan written as fact. src/hooks/, LiveClient/ReplayClient, src/data/channels/*, useChannel, useCandles and TimeControlProvider do not exist.
- Types are said to live in `shared/types`; the stub uses src/types.ts.
- 'Current State (as of April 2026)' says providers do not exist, but DataProvider and EnvProvider do.
- It uses future tense, and says `VITE_*` vars are baked at build time, but the service only runs `pnpm dev` and reads no VITE_* var.
The _stub/ui README:
- It lists VITE_BITMEX_REST_URL/WS_URL, which nothing reads, and omits UI_REST_PROXY and UI_DIGGER_*.
- It gives `tb up gui/bitmex`, but modules/gui does not exist.
- It presents live and replay as working.
Compose sets UI_REPLAY_HOST, which vite.config.ts never reads (it reads UI_DIGGER_HOST), and the EnvSwitcher/envs docblocks repeat the wrong name. Both backends are gone: BitMEX closed on 2026-09-23 and digger is retired (DATA_PIPELINE.md:152-157).

**Evidence.** `ls services/_stub/ui/src` gives App.tsx components data main.tsx styles types.ts utils widgets. `grep useChannel|TimeControl|useCandles` finds nothing. `grep -rn VITE_BITMEX` hits only the README. vite.config.ts:18 has `process.env.UI_DIGGER_HOST`. compose.yml:21 has `UI_REPLAY_HOST: ${UI_REPLAY_HOST:-}`. `ls modules` gives collect infra store.

**Fix.** 1. Remove docs/services/UI.md from the tech docs. Move whatever replay/time-machine design is worth keeping to docs/planning/UI.md, written as an explicit plan with no 'current state' section and no claims about existing files. Delete it outright if the owner does not want it (see owner question).
2. Rewrite services/_stub/ui/README.md in present tense:
- What it is: a BitMEX-era React/Vite dashboard kept as a stub, not wired into any module. BitMEX closed on 2026-09-23 and its replay backend (digger) is retired.
- What exists: a Vite dev server only, routing on `/:symbol`, react-grid-layout with 12 columns persisted to localStorage, most widgets on mockData.ts.
- An env table with what vite.config.ts and compose actually read: UI_PORT (3000), UI_REST_PROXY (default http://proxy, which no module provides), UI_DIGGER_HOST (empty disables Replay), UI_DIGGER_WS_PORT (8180), UI_DIGGER_REST_PORT (3101), UI_DIGGER_CONTROL_PORT (8280).
- Run with `pnpm --filter @tradebot/ui dev`.
- Drop the tb block and the UI.md link, or point the link at the planning doc.
3. Rename UI_REPLAY_HOST to UI_DIGGER_HOST in docker/compose.yml:19-21, EnvSwitcher.tsx:4 and envs.ts:5, or delete the replay wiring.

**Tests to add.** None (docs and dev config). Optionally run `pnpm --filter @tradebot/ui build` or tsc after the docblock edits.

**Verifier notes.** Merges reviewer F7 (medium) and F8 (low after verification). The verifier preferred moving the design to planning over deleting it, because the user intends to implement missing functionality soon.

## DCAT-06: CATALOG-UI describes lens-editor controls that do not exist

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/services/CATALOG-UI.md:300-302`, `docs/services/CATALOG-UI.md:345-347`, `docs/services/CATALOG-UI.md:349-352`, `services/catalog-ui/web/views/Lenses.tsx:33-35`, `services/catalog-ui/web/views/Lenses.tsx:726-728`, `services/catalog-ui/web/views/Lenses.tsx:958-979`, `services/catalog-ui/web/views/Lenses.tsx:1063-1076`

**Problem.** (1) :300-302 says untouched dimensions show as `every`. The pickers show 'All' and the grain/bundle selects show 'Any'. The Lenses.tsx:33-35 docblock repeats `every`.
(2) :345-347 says bundle is 'Both, Per instrument or Buckets'. The select offers Any / Only per Instrument / Only Market Bundles / Prefer per Instrument / Prefer Market Bundles, and `prefer` is undescribed.
(3) :349-352 describes an instrument search (three characters, five shown, then a count). There is no instrument field, because a rule never names an instrument. The only search is the market/dataset Picker, which filters on every keystroke and shows every pick as a pill.

**Evidence.** Lenses.tsx:1063-1066 `BUNDLES = [{ value: 'instrument', label: 'per Instrument' }, { value: 'market', label: 'Market Bundles' }]`. choices() builds Any/Only/Prefer. The Picker placeholder is 'All'. The filter is `includes(wanted)` with no minimum length. Lenses.tsx:958 says 'A rule never names an instrument'.

**Fix.** Delete CATALOG-UI.md:349-352. Replace :345-347 with '**A rule picks a bundle, never an instrument.** Grain and bundle are each Any, Only one form, or (for an include) Prefer one form; see CATALOG-LENSES#the-definition.' In :300-302, 'shown as `every`' becomes 'shown as All (markets, datasets) or Any (grain, bundle)'. Make the same change in the Lenses.tsx:33-35 docblock. State behaviour rather than exact labels where possible, in line with the doc's own rule (:378-381) that control detail lives in the components. DCAT-16 may cut this level of detail further.

**Tests to add.** None.

**Verifier notes.** Confirmed. The verifier added the Lenses.tsx:33-35 docblock.

## DCAT-07: CATALOG-UI and the catalog-ui README claim refusals and pre-save sizing the catalog does not do

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/services/CATALOG-UI.md:324-329`, `docs/modules/CATALOG-LENSES.md:106-109`, `shared/lenses/src/draft.ts:105`, `services/catalog-ui/README.md:25-28`, `services/catalog-ui/web/views/Lenses.tsx:239-252`

**Problem.** CATALOG-UI.md:324-329 lists two refusals 'about meaning': a venue whose rules include nothing, and an empty list in a dimension. `problemsWith` refuses neither, and CATALOG-LENSES.md:106-109 says what a rule matches is never weighed. The catalog-ui README:26-28 says a lens is 'sized before it is saved, and refused where it claims more than a venue publishes'. Both halves are false: only the saved lens is sized, and nothing compares a rule with what a venue publishes.

**Evidence.** draft.ts faultsIn() checks only unknown venue, grain, bundle, exclude+prefer, `yyyymm` bounds and from>to. rules.ts `named(values, one)` returns `values.includes(one)`, so `[]` silently matches nothing. Lenses.tsx:252 requests only `/lenses/${slug}/size`. CATALOG-UI.md:332 itself says 'A draft is never sized'.

**Fix.** CATALOG-UI.md:324-329: '**The catalog decides what can be stored.** A confirm it refuses comes back with its problems, shown on the rule, which stays a draft (what is refused: CATALOG-LENSES#what-is-refused).' Drop the two 'meaning' cases. If wanted, add to CATALOG-LENSES (not here) that a venue including nothing, or an empty list, is stored as written and lets nothing through. In services/catalog-ui/README.md:25-28, replace the lenses bullet with '**lenses**: named slices of the catalog, edited as rules per venue and under All venues; a saved lens shows its exact size and how much of it is downloaded.'

**Tests to add.** None.

**Verifier notes.** Confirmed medium.

## DCAT-08: CATALOG-UI credits prospector's /status facts to 'the catalog' and to 'this process'

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/services/CATALOG-UI.md:118-119`, `docs/services/CATALOG-UI.md:130`, `docs/services/CATALOG-UI.md:142-143`, `docs/services/CATALOG-UI.md:157-161`, `docs/services/CATALOG-UI.md:173`, `docs/services/CATALOG-UI.md:210-223`, `docs/services/CATALOG-UI.md:241`, `docs/services/CATALOG-UI.md:276`, `services/catalog-ui/web/views/Surveys.tsx:555-561`, `docs/services/PROSPECTOR.md:2037-2051`

**Problem.** Surveys polls prospector's /status, but the Surveys text calls the source 'the catalog' throughout (:119, 130, 143, 158, 173, 241, 276). In this doc that means the catalog service. :157-161 says only 'this process' (catalog-ui) can tell whether a loop is alive. That text was carried over from prospector's point of view: `surveying` is prospector's field, and catalog-ui only derives the word `stalled` from it. The Surveys.tsx:555-561 docblock repeats the error. The every-host rule for `completedEver` is stated only here, while PROSPECTOR.md owns /status.

**Evidence.** web/api.ts: `prospector = (path) => ask('/api/prospector'+path)`. Surveys polls `prospector('/status')`. Surveys.tsx State: `if (working && ! of.surveying) return <Badge color="red">stalled</Badge>`. PROSPECTOR.md:2037 says '`surveying` whether **this process** has a loop alive'. collector.ts:260 has `ids.every(id => everCompleted(db, id))`.

**Fix.** 1. Replace 'the catalog' with 'prospector' wherever the Surveys section means the source of /status: :119, :130, :143, :158, :173, :241 ('no separate resume verb') and :276.
2. Rewrite :157-161 as '`stalled` is this page's word for a venue prospector reports as `walking` or `updating` with `surveying: false`: work outstanding, and no loop of prospector's doing it.' Make the same correction in the Surveys.tsx:555-561 docblock.
3. Move the every-host rule into PROSPECTOR.md's Status table: '`completedEver` | whether a pass has ever finished on every one of the venue's hosts'.
4. Then cut CATALOG-UI.md:219-223 to one sentence saying the badge uses the same field. Keep :210-217, which is the consumer's reason for its choice and belongs here per CLAUDE.md.

**Tests to add.** None.

**Verifier notes.** Confirmed. The verifier refuted shrinking :210-223 to a bare pointer: PROSPECTOR.md does not yet state the every-host rule, so it has to move there before it is cut here, and :210-217 is legitimate consumer rationale.

## DCAT-09: History phrasing across CATALOG-UI, CATALOG-LENSES and Surveys.tsx; stale 'killed container' claim in PROSPECTOR.md

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/services/CATALOG-UI.md:163-166`, `docs/services/CATALOG-UI.md:168-171`, `docs/services/CATALOG-UI.md:181-185`, `docs/services/CATALOG-UI.md:244-248`, `docs/services/CATALOG-UI.md:272-274`, `docs/modules/CATALOG-LENSES.md:81-83`, `docs/modules/CATALOG-LENSES.md:162-164`, `docs/services/PROSPECTOR.md:2045-2047`, `services/catalog-ui/web/views/Surveys.tsx:10-17`, `services/catalog-ui/web/views/Surveys.tsx:563-567`

**Problem.** This breaks the 'only what is true today' rule. Examples: 'which is what it was', 'is no longer one of them', 'It took whatever ... before', 'used to have no way ... Without it', 'Reading only the first handed the buttons back', 'Writing `markets: 'all'` everywhere was rejected', 'Sampling is what this replaced'. The killed-container passage also contradicts PROSPECTOR.md:2045-2047, which still says walking with `surveying: false` is what a killed container leaves behind, although startup resumption exists. The Surveys.tsx:10-17 docblock describes an `Alive` column, shown side by side with `state`, that no longer exists. :563 says 'It used to be a column of its own'.

**Evidence.** The quoted text is at the cited lines. prospector/src/index.ts:199 and :289 call `resume(db)` at startup. The Surveys table heads are Venue/State/Runs/WIP/Files/Bytes (Surveys.tsx:143-230).

**Fix.** CATALOG-UI.md:
- :163-166 becomes 'It is shown in red, in the state badge itself: it is a fault rather than a phase.'
- :168-171 becomes 'Two things leave a venue there: a loop that threw its way out while its run row stayed open, and a job no deployment in scope will pick up.'
- Delete :181-185.
- Cut :244-248 to 'Pause works on a waiting venue too: mid-pass it stops after the current page and keeps every cursor; waiting, it means do not start the next update when it falls due.'
- Cut :272-274 to the present rule: the row stays held while `stopping` is true as well as while the request is in flight.
CATALOG-LENSES.md, keeping the rationale in present tense:
- :81-83 becomes 'A rule names only what it constrains: datasets, variants and grains are added over time, and a rule that names only what it constrains absorbs an addition where an enumeration silently stops covering it.'
- :162-164 becomes 'The size is never estimated from a sample: trade volume is too uneven between instruments for a sample to scale.'
PROSPECTOR.md:2045-2047: give the current causes of walking with `surveying: false` (a loop that threw, or a job outside every deployment's scope).
Surveys.tsx:
- Rewrite :10-17 to describe the current table, e.g. 'What every venue is doing, and the buttons that change it. The State badge carries the fault of a job open with nothing working it; see `State`.'
- Delete the 'It used to be a column of its own...' sentence at :563-564.

**Tests to add.** None; run tsc for the comment edits.

**Verifier notes.** Confirmed. The verifier asked that design rationale in CATALOG-LENSES be kept in present tense rather than deleted. It also noted that Surveys.tsx:13-16 is stale because of the Alive column, not because of the 'killed container' phrase (folded in from reviewer F23).

## DCAT-10: CATALOG-API: second host 'never in responses', wrong books variant keys, 'catalog probes', incomplete interval row

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/modules/CATALOG-API.md:21-23`, `docs/modules/CATALOG-API.md:33-39`, `docs/modules/CATALOG-API.md:77-79`, `docs/modules/CATALOG-API.md:144-147`, `docs/modules/CATALOG-API.md:257-259`, `services/catalog/src/vocabulary.ts:67`, `services/catalog/src/listings/s3.ts:56`

**Problem.** (1) :21-23 says bybit's second host appears in no response field, yet :77-79 documents `hosts` keyed primary/secondary, and every listed object carries `Host`.
(2) The books example `{ "depth": "500", "mode": "incremental" }` names a nonexistent level and the wrong order. The level is `kind`, and it comes first.
(3) :77-79 says the catalog lists and probes. Prospector does that; the catalog only reads.
(4) The interval row of the variant table omits volatilityIndex, optionSummary and optionTicker.

**Evidence.** vocabulary.ts LEVELS has `books: ['kind','depth']`, and volatilityIndex/optionSummary/optionTicker have ['interval']. s3.ts has `Host: hosts.get(file.venueId) ?? ''`. contents.ts hostsOf keys by row.host.

**Fix.** - :21-23 becomes 'A venue is a venue. Contents, lenses, paths and parameters are by venue name, whichever servers it publishes from; only `hosts` on a venue row and `Host` on a listed object say which server a file is on.'
- The examples at :144-147 become `{ "kind": "incremental", "depth": "500" }` and `{ "kind": "incremental", "depth": "200" }`.
- :78-79 becomes 'the one prospector lists and probes'.
- The interval row lists klines, markPrice, indexPrice, premiumIndex, volatilityIndex, optionSummary and optionTicker.

**Tests to add.** None.

**Verifier notes.** Confirmed medium.

## DCAT-11: CATALOG.md says nothing is shared in code with prospector, but both use @tradebot/lenses

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/services/CATALOG.md:46-49`, `docs/services/CATALOG.md:136-141`, `services/catalog/package.json:16`

**Problem.** CATALOG.md:46 says 'Nothing is shared in code with prospector'. Both services depend on @tradebot/lenses, and the same doc describes that package at :136-141.

**Evidence.** catalog/package.json has "@tradebot/lenses": "workspace:*". catalog/src/api/lenses.ts imports lensNamed, lensOptions, lensSize, problemsWith and others from it. Prospector imports putLens/editLens/dropLens/catchUp/admit. tests/fixture.ts:5 imports catchUp/editLens/putLens.

**Fix.** Rewrite CATALOG.md:46-49 as: '**One package is shared with prospector: `@tradebot/lenses`**: what a lens is, how it is checked, resolved and stored (see Lenses below). Everything else is this service's own queries against the same tables, and its tests build their own copy of the schema. Some vocabulary is therefore stated in both services (the variant levels, the grains, the canonical key), and the table shapes are the contract between them.'

**Tests to add.** None.

**Verifier notes.** Confirmed medium. The verifier noted the rest of the paragraph (own schema copy in tests, GRAINS stated twice) is accurate.

## DCAT-12: Forwarding to prospector: retry count, 502 meaning and lens-write retries are misdescribed

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/services/CATALOG.md:21-35`, `docs/modules/CATALOG-API.md:297-300`, `services/catalog/src/reports.ts:76`, `services/catalog/src/reports.ts:94-114`, `services/catalog/src/prospector.ts:11-37`, `services/catalog/src/api/reports.ts:31-35`

**Problem.** CATALOG.md:32 says 'tried again, three times'. ATTEMPTS = 3 means three attempts in all, which is two retries. A non-2xx answer from prospector throws Refused, is not retried, and is answered with 502 too, so a 502 also means prospector refused. Lens writes go through the same retry loop, which no doc mentions. A create retried after a dropped connection can come back 409.

**Evidence.** reports.ts: `if (! answer.ok) throw new Refused(...)` and `if (err instanceof Refused || attempt >= ATTEMPTS) throw err;`. api/reports.ts answers every throw with 502 'ServiceUnavailable'. prospector.ts has the same loop for lens writes.

**Fix.** CATALOG.md:32-35 becomes 'A connection prospector drops is retried, up to three attempts in all, because it closes idle keep-alive connections ... and settling twice is harmless. Where prospector still does not answer, or answers with an error, the report is a `502`; ...' After :23 add 'A dropped connection is retried the same way; where the first attempt was stored before the connection went, the retry is answered as a second write would be (a create, `409`).' CATALOG-API.md:297/:300 becomes '`502` where prospector does not answer or refuses the report'. Change the code comments at reports.ts:76 and prospector.ts:11 to 'up to three attempts'.

**Tests to add.** None (docs and comments).

**Verifier notes.** Confirmed low. The 409-on-retry case is narrow (the connection has to drop after prospector processed the write), so it gets one clause, not a section.

## DCAT-13: CATALOG-API error table and S3-error claim are incomplete

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/modules/CATALOG-API.md:56-58`, `docs/modules/CATALOG-API.md:253-254`, `docs/modules/CATALOG-API.md:330-342`, `services/catalog/src/api/index.ts:15-80`, `services/catalog/src/api/lenses.ts:55-86`, `services/catalog/src/api/lenses.ts:148-158`, `services/catalog/src/api/contents.ts:51-56`, `services/catalog/src/api/listings.ts:30-31`

**Problem.** The listing is said to answer errors 'in S3's shape, errors included', but 401 (requireToken), 413 (body parser) and 500 (onError) answer `{ "error" }` JSON on /listings too. The Errors table gives 502 only for reports, but lens writes also answer 502. The table also lacks 400 for an unsound slug and for an unknown `bundle`, and 422 for `NoSuchPartition`.

**Evidence.** index.ts: `res.status(401).json({ error: 'Unauthorized' })` runs before every route. onError answers `res.status(500).json(...)`. lenses.ts stored() catch answers 502. contents.ts:51 says 'bundle must be instrument or market'. listings.ts:30-31 answers NoSuchPartition.

**Fix.** CATALOG-API.md:56-58 becomes 'The listing and its report answer their own refusals in S3's `Error` shape; a refusal before any route runs (401, 413, 500) is `{ "error": … }` everywhere.' Qualify :253-254 the same way. Errors table:
- The 400 row adds 'a lens slug that is not lower case, digits and hyphens of two characters or more; an unknown `bundle`'.
- The 422 row becomes 'a lens named in `x-catalog-lens` or `lens=` that does not exist (`NoSuchLens`), or a `partition=` that names no partition (`NoSuchPartition`)'.
- The 502 row becomes 'prospector did not answer a lens write; or did not answer, or refused, a report'. Prospector's refusals of lens writes are relayed with their own status.
- Leave the 409 row as it is.

**Tests to add.** None.

**Verifier notes.** Four of five sub-points confirmed. The 409-for-PUT gap was refuted: the row is method-agnostic.

## DCAT-14: Small inaccuracies in CATALOG-API's listing, contents and key-grammar sections

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/modules/CATALOG-API.md:29-31`, `docs/modules/CATALOG-API.md:80-82`, `docs/modules/CATALOG-API.md:166`, `docs/modules/CATALOG-API.md:205-228`, `docs/modules/CATALOG-API.md:262`

**Problem.** - :262 says 'Two filters' over a table of three.
- :166 says every venue sub-route takes market/dataset/variant/grain, but /partitions takes `datasets`, `bundle`, `settled` and `settled-before`.
- :29-31 says the variant is answered as an object, but partitions, lens options and the market row's `variants` carry the stored string.
- `.partNN` implies two digits, while bitget uses three (`001`) and gate slices use an epoch.
- :80-81 says lens figures cost 'resolving the lens', but they read lens_member and no rule is evaluated.

**Evidence.** api/listings.ts:13 says 'Three filters'. api/contents.ts:62-66 shows the partitions params. partitions.ts:52 has `variant: row.variant`. bitget.ts:64 has `FIRST_PART = '001'`. gate.ts:101/111 use an epoch part. lenses/scope.ts:9-15 reads lens_member.

**Fix.** - 'Three filters S3 does not have'.
- :166 becomes 'Markets, shapes and symbols take the filters `market`, `dataset`, `variant` and `grain`; partitions takes its own, below.'
- :29-31: shapes answer the variant as an object; the market row's `variants`, partitions and lens options carry the stored string (`incremental,500`), since that is what a filter or rule names.
- In the key grammar (:205-206, :221, :228), write `.part<P>`, where P is the part as the venue writes it: a two-digit hour for gate's hourly files, a three-digit piece for bitget, an epoch for gate's slices.
- :80-81 becomes 'Under a lens every figure is the lens's, read from its `lens_member` rows; those are held until the lens is saved again or admits a partition.' Do not restate any seconds figure.

**Tests to add.** None.

**Verifier notes.** All five confirmed. The 'few seconds' timing is unverified and should be dropped, not restated.

## DCAT-15: Catalog caches are undocumented, so contents and lens options can be minutes old

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog/src/queries.ts:26-31`, `services/catalog/src/queries.ts:69-83`, `shared/lenses/src/draft.ts:96`, `shared/lenses/src/draft.ts:219`, `services/catalog/src/lenses/scope.ts:12-24`, `docs/services/CATALOG.md:51`, `docs/modules/CATALOG-API.md:181-183`

**Problem.** Three things are held between requests and no doc says so:
- Venue series for 60 s, so markets, shapes, symbols and lens-filtered contents trail a survey by up to a minute.
- Lens options for 5 min, so a new dataset is missing from the editor's pick lists.
- Lens scopes until the lens changes or admits a partition.
CATALOG-API.md:183 says contents 'cost nothing to ask', which is misleading.

**Evidence.** queries.ts has `const SERIES_MS = 60_000;`. draft.ts has `const OPTIONS_MS = 5 * 60_000;`. scope.ts has the SCOPES map keyed on updatedAt/partitions_through.

**Fix.** Add a short 'What is held between requests' paragraph under Contents in CATALOG.md: a venue's series for a minute; a lens's scope until it is saved again or admits a partition; partitions, settled state and listing pages are never held. State the 5-minute lens-options hold in the @tradebot/lenses home (CATALOG-LENSES.md, or shared/lenses' README), with a one-line mention in CATALOG.md. CATALOG-API.md:181-183: 'so it is cheap to ask; the answer can be up to a minute behind prospector'.

**Tests to add.** None.

**Verifier notes.** Confirmed and recalibrated from medium to low: the answers are stale, not wrong.

## DCAT-16: Settled, lens-filtered contents, reporting and lens rule semantics each have several homes

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/services/CATALOG.md:25-35`, `docs/services/CATALOG.md:58-65`, `docs/services/CATALOG.md:66-91`, `docs/modules/CATALOG-API.md:80-82`, `docs/modules/CATALOG-API.md:114-121`, `docs/modules/CATALOG-API.md:299-309`, `docs/modules/CATALOG-LENSES.md:184-194`, `docs/VOCABULARY.md:73-76`, `docs/services/CATALOG-UI.md:287-305`, `docs/services/CATALOG-UI.md:335-338`, `docs/services/CATALOG-UI.md:345-347`, `docs/services/CATALOG-UI.md:354-359`

**Problem.** This breaks the 'each subject has one home' rule. The texts agree today, so this is a drift risk rather than a contradiction. The clearest duplicates:
- CATALOG-API.md:299-309 restates how prospector rules on a report, which PROSPECTOR.md owns.
- CATALOG-UI.md restates lens rule semantics that CATALOG-LENSES owns.
- CATALOG-UI.md describes localStorage drafts twice (:335-338 and :354-359).
- CATALOG.md:83-85 repeats the caller-facing 'not a promise' paragraph on settled.

**Evidence.** The cited line ranges.

**Fix.** - Settled: CATALOG-API.md's partitions section owns what a caller can rely on. CATALOG.md drops :83-85 for a pointer, and keeps the implementation (the open run read by venue, one comparison, read once per request, SETTLE_DAYS).
- Lens effects on endpoints: CATALOG-LENSES#reading-through-a-lens is the single home. CATALOG-API.md:80-82 points there. Leave CATALOG.md:58-61 as is, since it is the implementation note (one query on lens_member).
- Reporting: CATALOG-API.md:307-309 is replaced with 'How prospector rules on a failure or a mismatch is in PROSPECTOR.md#reports.'
- CATALOG-UI: replace the semantics at :287-290 and :345-347 with one line pointing to CATALOG-LENSES.md#the-definition, keeping only what the editor shows (every venue's block, All/Any for an absent dimension, per DCAT-06). Merge :335-338 and :354-359 into one paragraph: drafts are kept per lens in localStorage, tagged with the version they were written from, so a reload keeps them, a lens saved elsewhere replaces them, and 'Reload as saved' drops them.

**Tests to add.** None.

**Verifier notes.** The verifier lowered this from medium to low, since no contradiction was found. Conflict resolved: the verifier's refined fix said to keep '`every` for an absent dimension', but DCAT-06 shows no `every` label exists, so All/Any is used.

## DCAT-17: Wrong catalog-ui build and dev instructions, stated in two places

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog-ui/README.md:40-42`, `docs/services/CATALOG-UI.md:375-376`, `services/catalog-ui/package.json:8`, `services/catalog-ui/vite.config.ts:18`, `services/catalog-ui/src/config.ts:13-19`

**Problem.** The README's build comment omits `tsc -p web`. CATALOG-UI.md:375-376 says `dev` runs Vite against the built server 'exactly as in the container'. In fact Vite only proxies /api to localhost:8080, and nothing starts that server. CATALOG_API defaults to http://catalog:8080, and PROSPECTOR_API is the constant http://prospector:8080, so the Surveys tab cannot work outside the module network. The container publishes 9020, not 8080. Dev setup is duplicated, and the vite.config.ts docblock overstates it too.

**Evidence.** package.json has `"build": "tsc -p web && vite build && tsc -b"` and `"dev": "vite"`. vite.config.ts has `proxy: { '/api': 'http://localhost:8080' }`. compose has `${CATALOG_UI_PORT:-9020}:8080`.

**Fix.** README.md:40: `# tsc -p web && vite build && tsc -b`. README.md:41-42: '`dev` serves the page with Vite and proxies `/api` to a catalog-ui server on :8080, which you start yourself (`CATALOG_API=http://localhost:<catalog port> pnpm --filter @tradebot/catalog-ui start` after a build); the Surveys tab needs prospector's module network.' Delete CATALOG-UI.md:375-376 so the README is the one home. Soften the vite.config.ts docblock to say the page talks to its own origin, as it does in the container.

**Tests to add.** None.

**Verifier notes.** Confirmed low.

## DCAT-18: Catalog README restates endpoints incompletely and omits CATALOG_DB

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `services/catalog/README.md:10-18`, `services/catalog/README.md:22-26`, `services/catalog/src/config.ts:13`, `services/catalog/src/config.ts:28`, `docs/modules/CATALOG-API.md:3-4`

**Problem.** The README lists endpoints, although CATALOG-API.md says it is the only home for them, and the list omits /venues/:venue/partitions. The env table omits CATALOG_DB, the database path override that config.ts reads. LOG_LEVEL, NODE_ENV and TZ, which compose passes, are undocumented too.

**Evidence.** config.ts has `dbPath: process.env['CATALOG_DB'] ?? CATALOG_DB`. `grep -rn CATALOG_DB --include=*.md` finds nothing.

**Fix.** Replace the endpoint block with 'It serves venue contents, the bucket listing and lenses; every endpoint is in CATALOG-API.md.' Add the row `CATALOG_DB` | `/data/catalog/catalog.db` | path of the database inside the process; compose leaves it at the `CATALOG_DIR` mount, and setting it runs the service against another file (e.g. outside compose). Optionally note that compose passes LOG_LEVEL (info), NODE_ENV and TZ (UTC) through.

**Tests to add.** None.

**Verifier notes.** Confirmed low.

## DCAT-19: shared/lenses and catalog docblocks contradict the code (rule order, bound format, resolve answer)

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `shared/lenses/src/types.ts:85-101`, `shared/lenses/src/types.ts:133`, `shared/lenses/src/store.ts:156-161`, `services/catalog/src/api/lenses.ts:134`

**Problem.** - The LensRule docblock says rules apply in order, read top to bottom, and that a list opening with exclude sees nothing. spansFor is order-free.
- types.ts:133 says bounds are `yyyymmdd`, but they are `yyyymm`.
- store.ts:156 is history ('Lenses written before a bound was a month').
- api/lenses.ts:134 says resolve answers 'how many series', but it answers slices, partitions and spans.

**Evidence.** rules.ts spansFor says 'Order-free. The includes are one set and the excludes another'. draft.ts:167-170 says 'Bounds are written yyyymm'. draft.ts:74-83 resolvedSummary.

**Fix.** - LensRule (:85-91): 'One rule. A lens lets through what any of its includes match, less what any of its excludes match; where a rule sits never changes the result, and an exclude always wins over an include it overlaps (see `spansFor`).' Keep the 'states only what it constrains' paragraph and drop the 'considered and rejected' paragraph (:97-101).
- types.ts:133: 'Inclusive `yyyymm` bounds on the period a file covers; absent is open.'
- store.ts:156-161: 'Bounds as months: any longer stamp is truncated to its month, which is how a bound is compared everywhere.'
- api/lenses.ts:134: 'by venue: how many slices and partitions, and the month spans its rules bound them to.'

**Tests to add.** None; run tsc.

**Verifier notes.** The verifier dropped the contents.ts:114 item: VOCABULARY.md defines where a venue keeps a file as the catalog's business, so that wording is not wrong. The Surveys.tsx items moved to DCAT-09.

## DCAT-20: planning/CATALOG.md lists landed work and duplicates a note; ROADMAP links to a missing anchor and a missing file

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/planning/CATALOG.md:11-12`, `docs/planning/CATALOG.md:30-31`, `docs/planning/CATALOG.md:38-41`, `docs/planning/CATALOG.md:58`, `docs/planning/CATALOG.md:61`, `docs/ROADMAP.md:230-240`

**Problem.** - 'Moving stocker onto the catalog' (:11-12) has landed: planning/STOCKER.md says 'Stocker runs on the catalog'.
- Hauler item 4 (:58, cold scripts and stocker on hauler's layout) has landed too.
- The live-database-as-backup note appears twice.
- ROADMAP.md:235 links `planning/CATALOG.md#unsolved-what-to-do-about-data-we-do-not-want`, and no such heading exists.
- ROADMAP.md:240 links planning/SCOPING.md, which does not exist.
- 'retried now' is history phrasing.

**Evidence.** `ls docs/planning` gives BUGS.md CATALOG.md COLD.md REST.md STOCKER.md archived mental-model.html. There is no 'Unsolved' heading in planning/CATALOG.md. stocker/src/catalog.ts reads settled partitions through STOCKER_LENS, and COLD-PUSH.md reads the partitions endpoint.

**Fix.** In docs/planning/CATALOG.md: delete the stocker sentence at :11-12; delete Hauler item 4; merge :30-31 into :38-41 so the backup note appears once; change 'are retried now' to 'are retried'. In docs/ROADMAP.md: remove the dead `#unsolved-...` anchor, and remove the planning/SCOPING.md link or restate that item without it. What to do with the 'data we do not want' paragraph itself is DCAT-23.

**Tests to add.** Optionally run a link check over docs/ (grep for `](` targets and verify that files and anchors exist).

**Verifier notes.** Confirmed low. The verifier said renaming or splitting the file is a taste call for the owner (deferred as DCAT-23), and that whether lens `prefer` fully closes the roadmap item is the owner's call.

## DCAT-21: 'the catalog may run on another machine' reads as contradicting the same-host requirement

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/services/CATALOG-UI.md:32-35`, `services/catalog-ui/src/api/routes.ts:10-14`, `docs/services/CATALOG.md:37-38`, `modules/collect/archives/README.md:41`

**Problem.** CATALOG-UI.md and the routes.ts docblock justify the proxy with 'the catalog may run on another machine'. CATALOG.md and the archives README require the catalog to share prospector's host, because SQLite WAL is shared through memory. The intended meaning (another machine from the browser) is ambiguous.

**Evidence.** CATALOG.md:37 says 'they must run on the same host'. catalog-ui config.ts has `PROSPECTOR_API = 'http://prospector:8080'`.

**Fix.** In CATALOG-UI.md:32-35 and routes.ts:10-14, replace 'and the catalog may run on another machine' with 'and the catalog's port need not be reachable from wherever the browser is open'. Keep the token paragraph as the second reason. Fix the archives .env.example 'another machine' wording in the same change.

**Tests to add.** None.

**Verifier notes.** The verifier was uncertain: it reads this as an ambiguity rather than a hard contradiction. It survives (1 confirmation vs 0.5) because the rewording is one phrase.

## DCAT-22: Dated benchmarks and advocacy framing in CATALOG.md and CATALOG-UI.md

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/services/CATALOG.md:114-115`, `docs/services/CATALOG.md:119`, `docs/services/CATALOG-UI.md:8-12`, `docs/services/CATALOG-UI.md:42-44`

**Problem.** CATALOG.md has point-in-time measurements ('Measured on 2026-10-04 ... 110 ms', '0.2 s on the same day'). CATALOG-UI.md:42-44 speculates about a neighbour ('could be changed'). :8-12 argues for the design ('not modesty about scope ... an afternoon') rather than describing it.

**Evidence.** The quoted lines.

**Fix.** Delete the two measurement sentences in CATALOG.md and add no replacement; the preceding sentences already state the cost property. Delete CATALOG-UI.md:42-44. Trim :8-12 to 'Everything it does follows from one rule: **it renders what the API said, and adds nothing.** No reshaping, no defaults, no computed fields, no second opinion. A question this cannot answer is one the catalog cannot answer.'

**Tests to add.** None.

**Verifier notes.** Confirmed low (the reviewer's confidence was medium).

## DCAT-23: Rename or split planning/CATALOG.md, and decide whether ROADMAP's 'data we do not want' item is solved

- **Severity:** low
- **Category:** docs
- **Decision:** DEFER
- **Locations:** `docs/planning/CATALOG.md`, `docs/ROADMAP.md:230-235`, `docs/modules/CATALOG-LENSES.md:59-77`

**Problem.** The file is titled 'Catalog: what is left', but most of it is hauler and prospector work (okx 'drop', ticket ramp, bitget seed, thin series, refreshing unindexed venues). Its intro explicitly scopes it to all three, though. ROADMAP.md:230-235 calls the two-renderings problem unsolved, while lens grain/bundle `{ prefer }` now chooses one rendering per month.

**Evidence.** planning/CATALOG.md:8-12 intro and :46-97. CATALOG-LENSES.md:59-77 describes `prefer`.

**Fix.** Pending the owner: either rename it docs/planning/ARCHIVES.md, or split it into planning/PROSPECTOR.md and planning/HAULER.md, keeping only 'Instruments as an entity' and 'An audit of the counters' under the catalog. For ROADMAP, either drop the paragraph as solved and point to CATALOG-LENSES#the-definition, or keep it as an open question without the dead link.

**Tests to add.** None.

**Verifier notes.** The verifier judged the rename a taste call, and whether prefer closes the roadmap item an owner call.

## Deferred: decisions needed

- **DCAT-05** (IMPLEMENT): Should the BitMEX-era replay/time-machine design in UI.md be kept as docs/planning/UI.md, or deleted along with UI.md? Separately, is the _stub/ui service itself worth keeping now that both its backends are gone?
- **DCAT-23** (DEFER): (1) Should planning/CATALOG.md be renamed to planning/ARCHIVES.md, split per service (PROSPECTOR/HAULER/CATALOG), or left as a cross-service plan? (2) Does lens `prefer` grain/bundle plus settled partitions fully solve ROADMAP's 'what to do about data we do not want' (a month published in two renderings), so the paragraph can be dropped?

## Rejected

- **F15 sub-point: 409 missing for a PUT renaming onto a taken slug**: The 409 row says 'a lens address already taken' without naming a method, so it already covers PUT.
- **F23 sub-point: contents.ts:114 'the catalog's business' should say prospector's**: VOCABULARY.md defines where a venue keeps a file as the catalog's internal business, and intoShapes in that file does the collapsing; the wording is not wrong.
- **F9 sub-point: shrink CATALOG-UI.md:210-223 to a bare pointer to PROSPECTOR.md**: PROSPECTOR.md does not state the every-host completedEver rule, and :210-217 is the consumer's rationale, which CLAUDE.md assigns to the consumer doc. Replaced by moving the rule first (DCAT-08).
- **F10/F3 sub-point: delete the whole 'Who reads through one' section**: It holds a provider fact (pending is per file, not per lens) that must survive. Replaced by rewriting it to provider-only statements (DCAT-02).
- **F17 sub-point: restate the 'few seconds' lens-figure cost**: The timing is unverified; it is dropped rather than corrected.
- **F12 sub-point: keep '`every` for an absent dimension' in CATALOG-UI**: No `every` label is rendered (DCAT-06); All/Any is used instead.
