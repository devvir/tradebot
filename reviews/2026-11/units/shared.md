# Shared packages review — consolidated (@tradebot/lenses, @tradebot/utils, @tradebot/types)

## Overall assessment

The shared packages (@tradebot/lenses, @tradebot/utils, @tradebot/types) contain two serious defects and a lot of stale or dead material. (1) redactUrl/sanitizeUrl write the plaintext AMQP password to warn logs whenever WHATWG parsing fails ('#', '/', '?' or a bare '%' in the password), at every startup of hoarder, pipe and router. sanitizeUrl's output is also never used to connect: SKFactory (services.ts:41) and router/src/index.ts:11 read raw process.env.QUEUE_URL. (2) problemsWith is the only gate on lens definitions and checks almost no structure. Malformed definitions are stored (201) and then read back with their rules silently gone (numeric bound), match by substring (markets string), are evaluated differently by spansFor and letThrough (unknown effect), or throw on every evaluation (datasets string). A throwing lens stops prospector's round loop for every older lens, and when the lens was settled before its venue had partitions, admit() throws inside the survey's partition-creating transaction. Around those: the lens store reports every SQLite error as 'slug taken' and edits lenses in non-atomic steps; SKFactory health never flags a service that never receives a first message; the shared CSV format cannot tell null from '' (deferred, it is a format decision); parseRules silently accepts malformed modifiers; previewing a lens materialises every partition on the request thread. Documentation: the lens docblocks contradict the code on core semantics (they say rules apply in order and bounds are yyyymmdd; evaluation is order-free and bounds are yyyymm), name consumer symbols (savedLensSize, Shape, seeds) against CLAUDE.md's dependency direction, and carry history/plans. tables.ts and bitmex.ts docblocks name components that do not exist (bitmex-database, assembler stage, data-prepare tool, POOLED_TABLES consumers). CATALOG-LENSES.md and PROSPECTOR.md contradict each other and the code on who writes the lens tables (prospector is the only writer). docs/bitmex/TABLES.md and docs/services/UI.md point at dead shared code. Dead surface: all of @tradebot/types (no importer outside shared), TABLE_SPECS/POOLED_TABLES (disagree with what vault stores), duplicated baseTable, mapGet, arrayToCsv, redactCredentials (unsafe), getExposedPort, lets. Test coverage is thin: utils ~42% lines (csv, security, services, env at 0%), lenses' own suite ~13% (only spans.ts), and consumers test lenses against a possibly stale dist. Restructuring recommendation: (a) put one parse-and-validate function in @tradebot/lenses, used by problemsWith and store.read(), and isolate per-lens failures in prospector; (b) shrink shared/utils to what more than one service uses, and decide one source of truth for BitMEX table schemas (vault TABLE_HEADERS/TABLE_CASTS vs shared TABLE_SPECS/@tradebot/types) before replay work starts; (c) give @tradebot/lenses its own tests and alias workspace packages to src in consumer vitest configs; (d) settle and version the vault CSV format before more data accumulates. No repository files were modified; repro scripts are under reviews/2026-11/units/scratch/shared/ and coverage output under reviews/2026-11/units/scratch/cov-shared-utils and cov-shared-lenses.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| SHR-01 | high | security | IMPLEMENT | redactUrl/sanitizeUrl log the plaintext AMQP credential URL on parse failure; sanitizeUrl's output is never used to connect |
| SHR-02 | high | correctness | IMPLEMENT | problemsWith checks almost no structure: stored lenses lose rules silently, mis-match, disagree between evaluators, or throw and stall lens upkeep / partition creation |
| SHR-03 | medium | docs | IMPLEMENT | Lens docblocks and docs contradict the implemented semantics, name consumers, carry history; CATALOG-LENSES.md/PROSPECTOR.md contradict code on who writes the lens tables |
| SHR-04 | medium | robustness | IMPLEMENT | Lens store: every SQLite error is reported as 'slug taken'; editLens/dropLens write in several statements outside a transaction |
| SHR-05 | medium | robustness | IMPLEMENT | SKFactory reports a message-tracking service healthy forever if it never receives a first message |
| SHR-06 | medium | docs | IMPLEMENT | tables.ts / bitmex.ts docblocks and docs describe consumers and components that do not exist; POOLED_TABLES dead; baseTable duplicated in vault |
| SHR-07 | medium | code-quality | DEFER | Two parallel BitMEX schema registries: unused TABLE_SPECS + @tradebot/types vs vault's TABLE_HEADERS/TABLE_CASTS, already disagreeing |
| SHR-08 | medium | correctness | DEFER | Shared CSV format writes null, undefined and '' identically, so null updates in websocket deltas are lost |
| SHR-09 | medium | testing | IMPLEMENT | Shared packages are largely untested, and consumers test @tradebot/lenses against a possibly stale dist |
| SHR-10 | medium | efficiency | IMPLEMENT | Lens preview (lensSize/resolvedSummary) materialises every partition of every venue on the request thread; resolve() copies each group array per row |
| SHR-11 | low | code-quality | IMPLEMENT | Unused shared exports, duplicated helpers, unsafe redactCredentials, optional Lens.id forcing non-null assertions |
| SHR-12 | low | correctness | IMPLEMENT | @tradebot/types: isISO8601Timestamp rejects every real BitMEX timestamp; isBitmexDataWithSymbol mis-documented and checks only data[0] |
| SHR-13 | low | code-quality | IMPLEMENT | Test helpers: env parser quirks and divergence from dev/tooling, unquoted shell interpolation, exported from the production barrel |
| SHR-14 | low | correctness | IMPLEMENT | union() never merges adjacent month spans although its docblock says it merges spans that touch |
| SHR-15 | low | robustness | IMPLEMENT | parseRules silently alters or accepts malformed modifiers |
| SHR-16 | low | robustness | IMPLEMENT | Vault comma-split read path relies on an unenforced CSV invariant; bare CR is never quoted |
| SHR-17 | low | config | IMPLEMENT | @tradebot/utils imports @tradebot/types without declaring it; root tsconfig omits shared/lenses |
| SHR-18 | low | correctness | IMPLEMENT | sizeOf picks the unit before rounding ('1024 KB' for just under 1 MiB); sizes test docblock is history |

## SHR-01 — redactUrl/sanitizeUrl log the plaintext AMQP credential URL on parse failure; sanitizeUrl's output is never used to connect

- **Severity:** high
- **Category:** security
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/utils/src/security.ts:17`
  - `shared/utils/src/security.ts:24-38`
  - `services/pipe/src/config.ts:10-19`
  - `services/router/src/config.ts:8-21`
  - `services/hoarder/src/config.ts:16-22`
  - `shared/utils/src/services.ts:41`
  - `services/router/src/index.ts:11`
  - `.env.example:38`

**Problem.** Both helpers catch a parse failure and call logger.warn({ error, url }). The raw URL is logged, and Node's ERR_INVALID_URL error repeats it in error.input. A raw '#', '/' or '?' in the password makes new URL throw; a bare '%' makes decodeURIComponent throw (URIError, url still logged). sanitizeUrl then returns the input unchanged and redactUrl logs it again, so the password is written up to four times per start. sanitizeUrl's docblock claims it handles '/' and ':' but only '@' (and ':' via WHATWG) work. Its output is stored in config.rabbitmqUrl only for a non-empty check and a redacted log line; the actual connection uses raw process.env.QUEUE_URL in SKFactory and router/index.ts (re-checked by consolidator).

**Evidence.** scratch/shared/sec.cjs, scratch/shared/repro-utils.cjs, scratch/v2F1/r.cjs (through the real service-kit pino logger): sanitizeUrl('amqp://user:p#ss@rabbitmq:5672') logs {"error":{"code":"ERR_INVALID_URL","input":"amqp://user:p#ss@rabbitmq:5672"},"url":"amqp://user:p#ss@rabbitmq:5672"}; redactUrl repeats it. The pino logger has no redact paths.

**Fix.** 1) In both catch blocks log only a non-sensitive reason, e.g. logger.warn({ reason: (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? 'unparsable' }, ...). Never log url or the error object. 2) redactUrl's catch: return url.replace(/\/\/[^@/]*@/, '//*****:*****@') when it matches, else '*****'. 3) sanitizeUrl: since its output never reaches a connection, either (preferred, simpler) delete it and have each config.ts check and log redactUrl(process.env.QUEUE_URL ?? '') directly, or keep it AND wire its output into SKFactory's rabbitmq provider and router/index.ts. If kept, rewrite it without WHATWG parsing of raw userinfo: match /^([a-z][a-z0-9+.-]*:\/\/)(.*)@([^@]*)$/is (greedy, splits at last '@'), split userinfo at first ':', per part try decodeURIComponent (fall back to raw) then encodeURIComponent, rebuild, validate with new URL; on failure throw Error('QUEUE_URL is not a valid URL') without the URL. 4) Fix the docblocks to state exactly what is handled.

**Tests to add.** shared/utils/tests/security.test.ts with a spied logger: for passwords containing '#', '/', '?', '%', '100%', '%41'/'%40' (idempotent), '@', ':' and a username with ':', assert no logged argument contains the password (both helpers, plus an unparsable host). redactUrl keeps scheme, host, port and vhost of a parseable URL and leaves a URL without credentials unchanged. If sanitizeUrl is kept: decodeURIComponent(new URL(out).password) equals the original.

**Verifier notes.** Lens A: both verifiers confirmed high. Lens B: first verifier confirmed but lowered to medium (a service with such a password also fails to connect, so the operator notices quickly). Kept high: plaintext credentials reach retained logs regardless. Lens A proposed rewriting sanitizeUrl, lens B removing it; consolidator confirmed sanitizeUrl's result is unused for connecting, so removal is the default and the rewrite is only needed if the owner wants it wired in.

## SHR-02 — problemsWith checks almost no structure: stored lenses lose rules silently, mis-match, disagree between evaluators, or throw and stall lens upkeep / partition creation

- **Severity:** high
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/lenses/src/draft.ts:123-178`
  - `shared/lenses/src/draft.ts:167-170`
  - `shared/lenses/src/rules.ts:55-56`
  - `shared/lenses/src/rules.ts:91`
  - `shared/lenses/src/rules.ts:101-103`
  - `shared/lenses/src/rules.ts:159-165`
  - `shared/lenses/src/store.ts:143-168`
  - `shared/lenses/src/members.ts:90-111`
  - `services/catalog/src/api/lenses.ts:52-71`
  - `services/prospector/src/api/lenses.ts:10-14`
  - `services/prospector/src/lenses.ts:44-62`
  - `services/prospector/src/catalog/cache/partitions.ts:152`

**Problem.** The catalog casts req.body to LensDefinition, runs problemsWith and forwards to prospector, which deliberately validates nothing. faultsIn checks only venue names, grain/bundle values, prefer-on-exclude, the bound regex and bound order. It never checks effect, markets, datasets shape, from/to type or the rule/venue container shapes. (a) Numeric bound: /re/.test(202003) coerces and passes; store.read() then throws on rule.from.slice and its catch returns {format:1,venues:{}}, so the lens (already in the 201 response) lets nothing through. (b) datasets:'trades' or markets:5 pass, then kinds.some / values.includes throw on every evaluation: /lenses/size, /resolve, /check return 500; catchUp throws and prospector's round loop (one try/catch around the whole for loop, lenses newest first) aborts every 30 s, so every older lens is never caught up. If the bad lens was settled before its venue had partitions (whole() never evaluated it), the first partition for that venue reaches admit() inside the survey's partition-creating transaction, which throws and rolls back every time. (c) markets as a string matches by substring ('inverse-perp' admits 'perp'). (d) An unknown effect (e.g. 'Exclude', 'inclde'): spansFor treats any non-'include' as exclude, letThrough ignores it, so resolveSlices and resolve/stored members disagree and resolvedSummary contradicts itself. (e) venues:{binance:{}} or a null rule make problemsWith itself throw (500 instead of 400); venues:'x' yields "No venue called '0'".

**Evidence.** scratch/shared/lens1.cjs, lens2.cjs, lens3.cjs, repro-lenses.cjs, repro-num.cjs, scratch/f2v2/r.cjs (real compiled package, node:sqlite): problems [] for each malformed shape; 'stored numeric lens definition read back: {"format":1,"venues":{}}'; 'round aborted: kinds.some is not a function' with the older lens never caught up; 'partition creation tx failed: kinds.some is not a function' for a lens stored before its venue had partitions; mixed effect gives resolveSlices markets ['inverse-perp'] vs resolve ['spot','inverse-perp'].

**Fix.** 1) In draft.ts add one structural parser (e.g. exported parseDefinition(input: unknown) or an internal pass at the start of problemsWith) that returns LensProblem entries and never throws; run faultsIn only on rules that pass it. Require: definition and venues are plain objects (problem at venue '', rule -1 otherwise); each venue value is an array (rule -1 otherwise); each rule is a non-null plain object; effect in {'include','exclude'} (field 'effect'); markets absent or string[]; datasets absent or an array of plain objects with string dataset and optional string variant; grain/bundle absent, or the accepted form with exactly one of only/prefer; from/to absent or strings (typeof check before the regex); reject unknown rule keys. 2) store.ts read()/months(): apply the same per-rule check, slice bounds only when strings, drop invalid rules one at a time (fail closed per rule) instead of discarding the document, and log once. 3) rules.ts:56: 'else if (rule.effect === "exclude")' (or a shared effectOf helper) so both evaluators agree. 4) members.ts admit(): wrap each lens's evaluation in try/catch, skip and log that lens (leaving partitions_through untouched so catchUp revisits it) so one lens cannot roll back the survey transaction. 5) prospector/src/lenses.ts: move the try/catch inside the per-lens loop, logging the slug. 6) Optionally guard prospector's putLens/editLens handlers with problemsWith too.

**Tests to add.** shared/lenses/tests/draft.test.ts: one case each for numeric from/to, datasets:'trades', datasets:[{}], markets:5, markets:'perp', venues:{binance:{}}, venues:{binance:[null]}, effect:'maybe', venues:'x' — each expects a problem with the right field and no throw. Store test: a raw stored definition with one bad and one good rule reads back with the good rule. rules test: for mixed include/exclude, slices with non-empty spansFor equal the slices of partitions letThrough keeps. Prospector tests: a lens whose rules throw does not stop an older lens finishing its rebuild; admit with a throwing lens does not fail the partition transaction.

**Verifier notes.** Merged lens A F2 and lens B F2+F3. Lens A first verifier rated medium (trigger is a malformed body); lens B first and second verifiers rated high. Kept high: a 201-accepted write silently erases rules or blocks other lenses. Lens B's second verifier said admit() does not crash because it skips updating lenses; lens A reproduced the crash for a lens settled before its venue had partitions (whole() never evaluated it, so it is not updating). Consolidator read members.ts:101-109: admit evaluates every non-updating lens with no per-lens guard, so both observations hold for their scenarios.

## SHR-03 — Lens docblocks and docs contradict the implemented semantics, name consumers, carry history; CATALOG-LENSES.md/PROSPECTOR.md contradict code on who writes the lens tables

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/lenses/src/types.ts:8-10`
  - `shared/lenses/src/types.ts:71-77`
  - `shared/lenses/src/types.ts:84-101`
  - `shared/lenses/src/types.ts:133`
  - `shared/lenses/src/types.ts:153-156`
  - `shared/lenses/src/types.ts:224-230`
  - `shared/lenses/src/spans.ts:6`
  - `shared/lenses/src/spans.ts:23-24`
  - `shared/lenses/src/spans.ts:32`
  - `shared/lenses/src/store.ts:41-45`
  - `shared/lenses/src/store.ts:153-161`
  - `shared/lenses/src/draft.ts:180-183`
  - `shared/lenses/src/members.ts:30-36`
  - `services/catalog/tests/lens.test.ts:108`
  - `services/catalog/tests/lens.test.ts:175`
  - `docs/modules/CATALOG-LENSES.md:13-16`
  - `docs/modules/CATALOG-LENSES.md:148-149`
  - `docs/services/PROSPECTOR.md:2158-2159`

**Problem.** (1) LensRule (types.ts:85-91) says rules apply in order and a list opening with exclude sees nothing; spans.ts:6 says 'composes its rules in order'; LensSpan (types.ts:153-156) says 'then excluding'. The code (rules.ts:41-45, spansFor, letThrough) and CATALOG-LENSES.md:47 are order-free: includes unioned minus excludes unioned, an exclude always wins. (2) types.ts:133 says bounds are yyyymmdd; problemsWith accepts only yyyymm. (3) types.ts:94 example datasets:['trades'] is the wrong shape. (4) union's docblock says it merges spans that touch; it does not (see SHR-14). (5) catchUp's docblock promises 'up to most' but from partition 0 it does one whole pass ignoring most. (6) putLens docblock says the name must be unique; it is the slug. (7) Consumer names in a provider doc (CLAUDE.md dependency direction): savedLensSize (draft.ts:182-183, a catalog function), Shape (types.ts:227, a catalog type), 'what the seeds are keyed by' (types.ts:74, prospector seeds). (8) History/plans (CLAUDE.md 'only what is true today'): spans.ts:23-24 ('31 was tried first'), store.ts:156-160 ('Lenses written before...'), types.ts:77 ('Nothing migrates it today'), types.ts:97-101 ('considered and rejected', also duplicated in CATALOG-LENSES.md), types.ts:10 ('so far'), plus gate-specific venue facts in the Grain docblock. (9) Catalog test names restate the ordered model. (10) CATALOG-LENSES.md:13-16 says the catalog writes the lens table and prospector never reads it, contradicting the same doc at :148-149, PROSPECTOR.md:2158 ('the two tables the catalog writes'), and the code (prospector's api/lenses.ts and lenses.ts are the only writers).

**Evidence.** scratch/shared/spans.cjs: spansFor(..., [{effect:'exclude',to:'202001'},{effect:'include'}]) gives [{from:'202002',to:null}], so a leading exclude takes effect. draft.ts:168 regex /^\d{4}(0[1-9]|1[0-2])$/ with message 'Bounds are written yyyymm.'

**Fix.** types.ts:84-91: 'One rule. A lens lets through what any of its includes match, less what any of its excludes match; where a rule sits never matters; a list of only excludes lets nothing through.' Fix the :94 example to datasets: [{ dataset: 'trades' }]. types.ts:133: 'Inclusive yyyymm months on the period a file covers; absent is open.' LensSpan docblock: union-minus semantics. spans.ts:6: 'A lens unions what its includes match and subtracts what its excludes match.' Remove spans.ts:23-24's history sentence; store.ts:153-161 -> 'A stored bound longer than a month is read as its month.'; remove 'Nothing migrates it today...' (types.ts:77, reword to 'format identifies the rule set a document was written under') and types.ts:97-101 (the rationale lives in CATALOG-LENSES.md). Grain: list the four values and their meaning without venue names or 'so far' (venue facts belong in docs/venues). lensSize: drop the savedLensSize sentence ('How much a definition would put on a disk, summed over the partitions it lets through'). LensOption: drop the Shape comparison. LensDefinition: drop 'and what the seeds are keyed by'. putLens docblock: slug. catchUp: add 'From partition 0 it works the whole lens out in one pass and ignores most.' union docblock: match the code after SHR-14. Rename catalog tests lens.test.ts:108 -> 'lets an exclude take away from an include', :175 -> 'reads the global rules together with a venue's own', and fix its comment. CATALOG-LENSES.md:13-16: the catalog checks a lens and reads it; prospector stores lens and lens_member (keep :148-149 as the single statement). PROSPECTOR.md:2158-2159: prospector stores lens and lens_member on the catalog's behalf.

**Tests to add.** None beyond the renamed catalog tests; the adjacent-month span test lives in SHR-14.

**Verifier notes.** Merged lens A F6 and lens B F5+F6. All verifiers confirmed. Lens B's verifier noted gate examples do not break dependency direction (venues are providers to everything) but are time-relative and go stale; trimming is still reasonable. This is the core of the user's documentation clean-up request.

## SHR-04 — Lens store: every SQLite error is reported as 'slug taken'; editLens/dropLens write in several statements outside a transaction

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/lenses/src/store.ts:40-66`
  - `shared/lenses/src/store.ts:76-106`
  - `shared/lenses/src/store.ts:109-118`
  - `shared/lenses/src/members.ts:37-46`
  - `shared/lenses/src/members.ts:72-74`
  - `shared/lenses/src/members.ts:213`
  - `services/prospector/src/api/lenses.ts:37-43`
  - `services/prospector/src/api/lenses.ts:53-60`

**Problem.** putLens and editLens use a bare catch { return null; }, which prospector maps to 409 'already exists' / 'That address is taken'. SQLITE_BUSY/LOCKED, FULL, READONLY, I/O and STRICT/CHECK failures are all misreported and never logged. editLens runs the UPDATE and then rebuild() (partitions_through=0, rebuilding=1) as separate autocommit statements; if rebuild throws or the process dies between them, the new definition is stored with rebuilding=0 and partitions_through=newest, and catchUp's 'through >= newest' early return means old-rule members are never re-derived. dropLens deletes members then the lens row in two statements. members.ts has a writing() BEGIN IMMEDIATE helper, unexported.

**Evidence.** scratch/shared/lens1.cjs and repro-num.cjs: with a trigger RAISE(ABORT,'disk I/O error') or a failing CHECK, putLens on a free slug returns null -> '409 A lens addressed as free already exists'. node:sqlite reports a unique violation as code 'ERR_SQLITE_ERROR', errcode 2067, 'UNIQUE constraint failed: lens.slug'.

**Fix.** In both catch blocks: catch (err) { const e = err as { errcode?: number; message?: string }; if (e.errcode === 2067 && /lens\.slug/.test(e.message ?? '')) return null; throw err; }. Ensure prospector's lens router has an error middleware that logs and returns 500. editLens: compute changed = JSON.stringify(next.definition) !== JSON.stringify(had.definition) before writing and fold the rebuild into the same UPDATE: partitions_through = CASE WHEN ? THEN 0 ELSE partitions_through END, rebuilding = CASE WHEN ? THEN 1 ELSE rebuilding END, binding changed?1:0 twice; drop the separate rebuild() call (keep rebuild exported if used elsewhere). dropLens: export writing (or move it to an internal db.ts) and wrap both DELETEs, or use a single DELETE if lens_member has ON DELETE CASCADE (check the schema). Docblocks: null means only 'the slug is taken' (and for editLens 'no such lens').

**Tests to add.** Duplicate slug -> null; a RAISE(ABORT) trigger or other constraint failure makes putLens and editLens throw; editLens with a changed definition leaves partitions_through=0 and rebuilding=1 straight after one call; dropLens leaves neither lens nor members.

**Verifier notes.** Merged lens A F3 (medium) + F4 (low) and lens B F4 (low). The 'note: null' example in lens A F3 is weak (prospector passes note ?? '') but the disk/locked/I/O cases stand. The crash window is microseconds (synchronous node:sqlite), so the non-atomic part is low on its own; combined item kept at medium for the misreporting.

## SHR-05 — SKFactory reports a message-tracking service healthy forever if it never receives a first message

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/utils/src/services.ts:58`
  - `shared/utils/src/services.ts:85-92`
  - `services/hoarder/src/service.ts:7`
  - `services/hoarder/src/service.ts:13`
  - `services/hoarder/src/messages.ts:23`
  - `services/hoarder/src/messages.ts:34-46`
  - `services/hoarder/src/websocket.ts:58`

**Problem.** With trackMessages, healthy = lastMessageAt === null || Date.now() - lastMessageAt < 30 s. A service that never gets data (subscriptions rejected, wrong venue config, upstream down from the start) answers 200 indefinitely. hoarder, the only user, emits 'message' only after a data frame is published, so control/error/welcome frames do not count. hoarder also keeps an unused lastMessageTime in its own state.

**Evidence.** services.ts:58 initialises lastMessageAt: null; services.ts:88 treats null as healthy; nothing records a start time.

**Fix.** Record startedAt = Date.now() when tracking begins. since = lastMessageAt ?? startedAt; limit = lastMessageAt === null ? startupGraceMs : inactivityMs; healthy = Date.now() - since < limit. Accept trackMessages as boolean | { inactivityMs?: number; startupGraceMs?: number } (defaults 30_000 / 60_000). Include startedAt in the JSON body. Remove hoarder's unused lastMessageTime state and its setState calls.

**Tests to add.** shared/utils/tests/services.test.ts with vi.useFakeTimers and fake Service/res: healthy inside the grace window with no messages; 503 after the grace window with no messages; healthy right after a message; 503 once inactivity has passed since the last message. Note: lens B's F9 test plan asserted '200 when lastMessageAt is null' — that reflects current behaviour and must follow this fix instead.

**Verifier notes.** Lens A F9, confirmed medium by its verifier.

## SHR-06 — tables.ts / bitmex.ts docblocks and docs describe consumers and components that do not exist; POOLED_TABLES dead; baseTable duplicated in vault

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/utils/src/tables.ts:3-9`
  - `shared/utils/src/tables.ts:274-292`
  - `shared/utils/src/tables.ts:294-308`
  - `shared/utils/src/tables.ts:310-326`
  - `shared/utils/tests/tables.test.ts:1-27`
  - `shared/types/src/bitmex.ts:480-485`
  - `services/vault/src/data/headers.ts:7-10`
  - `services/vault/src/data/headers.ts:84`
  - `docs/bitmex/TABLES.md:32-33`
  - `docs/services/UI.md:70`

**Problem.** TABLE_SPECS is 'approximated from bitmex-database/src/types.ts' (no such path). POOLED_TABLES says consumers route by it (none import it). WS_TABLES is described as used 'at task creation time... assembler stage' (no assembler; vault uses it to decode). FREE_TEXT_TABLES names 'the data-prepare tool' (only under dev/tooling/.deprecated). These explain providers by consumers (CLAUDE.md) and the consumers are gone. isBitmexDataWithSymbol is documented as 'Type guard for subscription messages' (copy-paste). docs/bitmex/TABLES.md:32-33 points at tables.ts for typing, but vault casts from casts.ts/headers.ts only; docs/services/UI.md:70 says types live in shared/types, but the UI does not import them. vault re-implements baseTable (headers.ts:84) instead of the shared one; WS_TABLES equals the TABLE_HEADERS entries starting with '_date_' (same fact twice).

**Evidence.** grep -rli assembler -> only tables.ts and routes test data; grep data-prepare -> only tables.ts; grep -rlw POOLED_TABLES services dev -> nothing; vault decode.ts/parse.ts/casts.ts import baseTable from './headers'.

**Fix.** Rewrite docblocks on the provider's own terms: WS_TABLES = 'tables stored as WS message envelopes: each row carries _date_/_action_ and a message spans consecutive rows'; FREE_TEXT_TABLES = 'tables whose fields can contain commas, quotes or newlines and so need RFC 4180 quoting'; drop vault/assembler/data-prepare/bitmex-database mentions. Delete POOLED_TABLES and its tests. Keep one baseTable: delete vault's headers.ts:84 copy and import from @tradebot/utils in decode.ts, parse.ts, casts.ts, headers.ts (or the reverse if SHR-07 moves table knowledge into vault). Fix the isBitmexDataWithSymbol docblock (see SHR-12). Remove 'TABLE_SPECS' from vault headers.ts:7-10's source note. TABLES.md:32-33: point only at services/vault/src/data/headers.ts (columns) and casts.ts (typing). UI.md:70: remove the shared/types claim (or state it only if SHR-07 keeps the package for the UI). Optional: move WS_TABLES/FREE_TEXT_TABLES into vault and derive WS_TABLES from TABLE_HEADERS, with a test pinning the 7 names.

**Tests to add.** Existing vault and utils suites pass; tsc clean in vault and utils; optional vault test pinning WS_TABLES.

**Verifier notes.** Merged lens A F7 + F8 (dead-API part) and lens B F7. All confirmed. TABLE_SPECS's own fate is split out as SHR-07 (deferred) because lens B's verifier asked for owner confirmation before deleting it.

## SHR-07 — Two parallel BitMEX schema registries: unused TABLE_SPECS + @tradebot/types vs vault's TABLE_HEADERS/TABLE_CASTS, already disagreeing

- **Severity:** medium
- **Category:** code-quality
- **Decision:** DEFER
- **Locations:**
  - `shared/utils/src/tables.ts:1`
  - `shared/utils/src/tables.ts:17-272`
  - `shared/types/src/bitmex.ts:30-77`
  - `shared/types/src/bitmex.ts:440-513`
  - `services/vault/src/data/headers.ts:55-84`
  - `package.json:20`
  - `tsconfig.json:24-29`
  - `docs/planning/mental-model.html:1213`

**Problem.** TABLE_SPECS (~250 lines) has no runtime reader; vault keeps its own authoritative TABLE_HEADERS/TABLE_CASTS. They disagree: chat lacks channelID/flair/guild; compositeIndex and tick (stored by vault) are not in BitmexTable; publicNotifications/privateNotifications declare keys ['id'] with no id field. Nothing outside shared imports @tradebot/types; its only importer is tables.ts (type import for TABLE_SPECS). A planned replay consumer could adopt TABLE_SPECS as 'the source of truth' and type rows differently from what vault stores.

**Evidence.** Grep across services/dev/tools/modules/packages: TABLE_SPECS only in a comment at vault headers.ts:10; no importer of @tradebot/types outside shared.

**Fix.** Owner chooses one: (a) delete TableSpec, TABLE_SPECS (and the @tradebot/types import in tables.ts), then delete shared/types, the root devDependency (package.json:20) and the root tsconfig reference, and fix docs that name shared/types (UI.md:70, TABLES.md:33, planning mental-model.html); or (b) make shared the single home: move vault's TABLE_HEADERS/TABLE_CASTS into shared/utils (or shared/types), derive everything (WS_TABLES, pooled tables) from them, and correct the BitMEX types to match. If TABLE_SPECS is kept in the interim, its docblock must say vault's TABLE_HEADERS is authoritative for stored columns.

**Tests to add.** Whichever option: existing vault/utils suites green, tsc clean; for (b) a test asserting the shared schema matches vault's stored headers.

**Verifier notes.** Lens A F8 verifier: delete TABLE_SPECS now, do not move TABLE_HEADERS (design decision for replay). Lens B F7 verifier: TABLE_SPECS carries keys/filter from WS partials the owner may want for replay; confirm first. Lens B F8 verifier: deleting @tradebot/types requires removing TABLE_SPECS or inlining types. The instrument 'pool' mismatch claimed by lens A is not a contradiction (VAULT.md:28: the column exists but the feed leaves it empty).

**Owner question.** Which package owns the BitMEX table schema going forward (for the replay work): delete TABLE_SPECS and @tradebot/types, or move vault's TABLE_HEADERS/TABLE_CASTS into shared and make them the single source of truth? Are TABLE_SPECS's keys/filter wanted for replay?

## SHR-08 — Shared CSV format writes null, undefined and '' identically, so null updates in websocket deltas are lost

- **Severity:** medium
- **Category:** correctness
- **Decision:** DEFER
- **Locations:**
  - `shared/utils/src/csv.ts:28-29`
  - `services/vault/src/data/encode.ts:4-6`
  - `services/vault/src/data/casts.ts:173-174`
  - `services/vault/src/data/parse.ts`

**Problem.** csvValue returns '' for null and undefined, and '' is written unquoted as well. Vault stores WS update messages (only changed fields present) as rows; absent fields are ''. applyCasts drops every '' field on decode, so an update setting a field to null comes back as 'not touched', and an explicit '' becomes absent. A replay applying deltas keeps the old value. Minor: a Date is JSON-stringified into a literally quoted string (negligible: rows come from JSON.parse).

**Evidence.** scratch/shared/csv.cjs: rows with title:'' and body:null both serialise to ',,' and parse back as '',''. casts.ts:173 '} else if (value === "") { continue; }'.

**Fix.** After the owner decision: three-state encoding in csv.ts (absent = unquoted empty; null = unquoted sentinel such as \N; '' = quoted ""), documented in csv.ts; version the file format (header or naming); teach both vault read paths (csv-parse cast with context.quoting; commaSplit treats literal "" as '') and map \N to null in applyCasts. Cheap and safe now regardless: make csvValue throw on non-plain objects (Date, Map, class instances) instead of JSON-stringifying them.

**Tests to add.** Round-trip tests for null, '' and absent through rowToCsv and both vault read paths; a Date input throws.

**Verifier notes.** Lens A F5, confirmed medium, defer: real-world loss depends on BitMEX sending explicit nulls/'' in updates (no fixture in repo shows it), and the fix changes the on-disk format.

**Owner question.** Does captured BitMEX traffic carry explicit nulls or empty strings in update messages? If yes, approve a versioned three-state CSV encoding (absent / \N / "") and decide how existing vault files are handled.

## SHR-09 — Shared packages are largely untested, and consumers test @tradebot/lenses against a possibly stale dist

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/lenses/tests/spans.test.ts`
  - `shared/lenses/package.json`
  - `shared/utils/tests`
  - `shared/types/package.json:6-8`
  - `vitest.config.ts:16-21`
  - `services/catalog/vitest.config.ts`
  - `services/prospector/vitest.config.ts`
  - `services/catalog/tests/lens.test.ts`
  - `services/catalog/tests/members.test.ts`
  - `services/prospector/tests/lenses.test.ts`

**Problem.** utils coverage ~42% lines/24% functions; csv.ts, security.ts, services.ts, stores.ts, testing/* at 0%. lenses' own suite ~13-14% (only spans.ts; draft, members, rules, store at 0%). Both fail the root 60% threshold when coverage runs (no CI workflow or test:coverage script runs it today). @tradebot/types has no test script. Lens logic is exercised by catalog and prospector tests, but those import @tradebot/lenses via main -> dist/index.js with no alias and the root test script does not build first, so an unbuilt src edit can pass them. Untested paths: writing() rollback, putLens/editLens error discrimination, read() fail-closed, structural validation, effect handling, SKFactory spec merging and health, URL helpers.

**Evidence.** npx vitest run --coverage: utils 'Coverage for lines (42.32%) does not meet global threshold (60%)'; lenses statements 14.41%. services/catalog/node_modules/@tradebot/lenses -> ../../../../shared/lenses; shared/lenses/package.json main dist/index.js.

**Fix.** 1) Add resolve.alias for '@tradebot/lenses' and '@tradebot/utils' to their src/index.ts in services/catalog and services/prospector vitest configs (or once in the root vitest.config.ts); confirm all suites pass. 2) shared/lenses/tests: rules.test.ts (pure letThrough/spansFor: bundle-before-grain preference, keep what exists when the preferred form is absent, exclude beats include, order-free); store.test.ts on in-memory DatabaseSync with the lens/lens_member DDL (from catalog tests/fixture.ts:212 or prospector schema): slug collision -> null, editLens rebuilds only on definition change, day bound read as month; draft.test.ts with the SHR-02 cases. 3) shared/utils/tests: csv.test.ts (quoting of ',', '"', LF, CR, doubled quotes, null/undefined, objects, column order, createCsvParser round trip of multi-line quoted field, relaxColumnCount), security.test.ts (SHR-01), services.test.ts (mock @devvir/service-kit to capture spec: QUEUE_URL/CACHE_URL providers, topology passthrough, caller state overrides, healthcheck:false preserved; health per SHR-05), env.test.ts (SHR-13). Skip tests for code SHR-10 deletes. 4) Leave the existing catalog/prospector integration tests in place. 5) shared/types test script only if SHR-07 keeps the package (SHR-12 adds its test).

**Tests to add.** As listed in the fix.

**Verifier notes.** Merged lens A F12, lens B F9 and F10. Lens A's claim that lenses are tested only through catalog with a hand-written schema is wrong: prospector/tests/lenses.test.ts uses the real schema, and admit's skip/advance and catchUp's whole/step branches are covered there and in catalog tests. vault's encode/decode tests pin parts of the CSV byte format. The dist-resolution problem is the substantive defect.

## SHR-10 — Lens preview (lensSize/resolvedSummary) materialises every partition of every venue on the request thread; resolve() copies each group array per row

- **Severity:** medium
- **Category:** efficiency
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/lenses/src/draft.ts:53-72`
  - `shared/lenses/src/draft.ts:63`
  - `shared/lenses/src/draft.ts:75-83`
  - `shared/lenses/src/draft.ts:188-201`
  - `shared/lenses/src/draft.ts:238-245`
  - `services/catalog/src/api/lenses.ts:105-112`
  - `services/catalog/src/api/lenses.ts:137-139`

**Problem.** resolve() reads every partition row (13 columns) of every venue the definition names, sorted by ORDER BY c.id, q.month that nothing needs, and groups with groups.set(key, [...groups.get(key) ?? [], one]). resolvedSummary calls resolve and resolveSlices, so venuesIn runs twice. All synchronous node:sqlite on the catalog's request thread, intended to be called on each editor change, so every other catalog request queues behind it.

**Evidence.** scratch/shared/bench.cjs at 384k partitions: re-run by verifier gives lensSize ~2.1 s and resolvedSummary ~2.1 s; rows alone 1.3 s; push-based grouping 1.9 s (reviewer had measured 3.1-3.4 s).

**Fix.** (1) Group with push: const had = groups.get(key); if (had) had.push(one); else groups.set(key, [one]); (or share a groupSiblings helper with members.ts whole()). (2) Drop ORDER BY from partitionsOf. (3) In resolvedSummary compute venuesIn once and pass it to internal variants of resolve and resolveSlices. (4) Optional: skip venues whose slices no include matches (spansFor on slicesOf first); a narrower lensSize query using stmt.iterate().

**Tests to add.** A test asserting lensSize and resolvedSummary totals are unchanged for a fixture with mixed grains and bundles (catalog lens.test.ts or shared/lenses once SHR-09 lands).

**Verifier notes.** Lens B F11. Verifier confirmed mechanism but spread-copy is ~12% of the call, not a third; most cost is materialising rows. No UI client calls /lenses/size or /resolve yet, so the cost is prospective.

## SHR-11 — Unused shared exports, duplicated helpers, unsafe redactCredentials, optional Lens.id forcing non-null assertions

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/utils/src/security.ts:39-45`
  - `shared/utils/src/csv.ts:25-26`
  - `shared/utils/src/csv.ts:38-41`
  - `shared/utils/src/stores.ts:4-14`
  - `shared/utils/src/index.ts`
  - `shared/utils/src/testing/compose.ts:53-84`
  - `shared/lenses/src/rules.ts:70`
  - `shared/lenses/src/rules.ts:132-133`
  - `shared/lenses/src/draft.ts:229-230`
  - `shared/lenses/src/types.ts:32`
  - `shared/lenses/src/store.ts:79`
  - `shared/lenses/src/index.ts:1-7`
  - `knip.json`

**Problem.** No importer outside shared for redactCredentials, arrayToCsv/csvStringValue, mapGet (stores.ts), getExposedPort, lets. redactCredentials is unsafe (reveals the first 5 characters, all of a short secret: 'abc' -> 'abc*****') and its docblock is copied from redactUrl. csvStringValue duplicates csvValue. venueNames is defined identically in rules.ts and draft.ts. Lens.id is optional although every Lens comes from a NOT NULL row, causing ~13 'lens.id!' assertions. editLens re-declares LensWrite inline. lensNameIsSound validates a slug. The lenses barrel exports evaluation internals nobody imports. knip's shared/** workspace treats every barrel export as public, so none of this is reported.

**Evidence.** knip --include-entry-exports: arrayToCsv csv.ts:25, redactCredentials security.ts:43, mapGet stores.ts:4, getExposedPort compose.ts:59, lets rules.ts:70.

**Fix.** Delete redactCredentials, arrayToCsv + csvStringValue, stores.ts (and its index export), getExposedPort, lets. Move venueNames into one internal module imported by rules.ts and draft.ts. Make Lens.id: number required and remove the '!' assertions. Type editLens's 'to' as Partial<LensWrite> (or LensWrite). Optional (owner taste): trim lenses/index.ts to what consumers import (lensNamed, lenses, putLens, editLens, dropLens, catchUp, admit, problemsWith, lensOptions, lensSize, resolveSlices, resolvedSummary, lensNameIsSound, union, types) keeping internals importable by tests; rename lensNameIsSound to slugIsSound (touches catalog api); set includeEntryExports for shared/** in knip.json.

**Tests to add.** Existing suites and tsc pass; knip reports nothing new.

**Verifier notes.** Merged lens A F8 (unused helpers, redactCredentials) and lens B F14. All confirmed by grep. Env-parser divergence from lens B F14 moved to SHR-13.

## SHR-12 — @tradebot/types: isISO8601Timestamp rejects every real BitMEX timestamp; isBitmexDataWithSymbol mis-documented and checks only data[0]

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/types/src/bitmex.ts:480-485`
  - `shared/types/src/bitmex.ts:486-513`
  - `shared/types/src/bitmex.ts:253`
  - `shared/types/src/bitmex.ts:259`
  - `shared/types/src/bitmex.ts:287`

**Problem.** ISO8601_REGEX requires \.\d{4}Z and the docblock says 'exactly 4 digits', but its own example, BitMEX and Date#toISOString use 3. The guard returns false for every valid input. isBitmexDataWithSymbol carries a copied 'Type guard for subscription messages' docblock and inspects only data[0]. Interfaces carry open-question comments ('// Only in Rest API?'). No caller today, so latent.

**Evidence.** isISO8601Timestamp('2026-02-15T19:27:38.368Z') -> false; '...38.3680Z' -> true.

**Fix.** If SHR-07 deletes the package, delete these instead. Otherwise: regex \.\d{3}Z$ and docblock 'exactly 3 digits'; isBitmexDataWithSymbol docblock 'Whether every item carries a symbol' and implement as data.length > 0 && data.every(one => 'symbol' in one); replace '// Only in Rest API?' comments with facts per docs/venues or remove them.

**Tests to add.** shared/types/tests/bitmex.test.ts (+ test script): true for '2026-02-15T19:27:38.368Z' and new Date(0).toISOString(); false for 4-digit fraction, no fraction, month 13.

**Verifier notes.** Merged lens A F15 (ISO part), A F7 (docblock part) and lens B F8. Lens A F7's verifier corrected that the docblock matches the regex; it is the regex that is wrong. Lens B F8 lowered to low (no callers). Decision depends on SHR-07 but is safe either way.

## SHR-13 — Test helpers: env parser quirks and divergence from dev/tooling, unquoted shell interpolation, exported from the production barrel

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/utils/src/index.ts:10`
  - `shared/utils/src/testing/compose.ts:6`
  - `shared/utils/src/testing/compose.ts:21-24`
  - `shared/utils/src/testing/compose.ts:39`
  - `shared/utils/src/testing/env.ts:13-71`
  - `dev/tooling/src/shared/utils/env.ts:9-34`
  - `services/pipe/tests/setup.ts`
  - `services/pipe/tests/global-setup.ts`
  - `services/router/tests/setup.ts`

**Problem.** parseEnvFile keeps inline ' # comments' in values, interpolates ${VAR} inside single quotes (dotenv/compose treat them literally), and resolves a lone '"' to ''. loadEnvFile swallows every error (not only ENOENT) and its '! process.env[key]' overwrites variables deliberately set to '', contradicting its docblock. dev/tooling has its own parseEnvFile with different semantics (strips comments, not quotes), so the same file parses differently. composeCmd interpolates projectName unquoted into a shell string and retries with execSync('sleep'). index.ts re-exports ./testing into the runtime barrel every service imports. All test-only impact.

**Evidence.** env.ts:64 'if (! process.env[key])'; env.ts:69 bare catch; compose.ts:23 '--project-name ${config.projectName}'.

**Fix.** parseEnvFile: require length >= 2 before stripping quotes; strip whitespace-then-# comments from unquoted values; skip interpolation for single-quoted values. loadEnvFile: use process.env[key] === undefined; rethrow unless err.code === 'ENOENT'; update the comment. Quote or argument-array the compose command (execFileSync('docker', [...])). Pick one .env grammar: have dev/tooling reuse the shared parser, or document why they differ; run dev/tooling/tests/shared/utils/env.test.ts. Optional: move ./testing to a subpath export; this needs typesVersions ({"*": {"testing": ["dist/testing/index.d.ts"]}}) alongside exports because the repo uses module commonjs / node10 resolution, then update the three importers to '@tradebot/utils/testing'.

**Tests to add.** shared/utils/tests/env.test.ts: quoted literal, single-quoted value not interpolated, interpolation from earlier keys and process.env, inline comment stripped, export prefix removed, empty pre-set variable preserved, missing file ignored, directory path throws.

**Verifier notes.** Merged lens A F14, lens B F15 (barrel/compose part), B F16 (env part), B F14 (parser divergence). Lens B F15's verifier judged the production cost of the barrel negligible (builtin child_process, lazy path), so the subpath split is optional, and a plain exports map alone would not type-resolve under node10.

## SHR-14 — union() never merges adjacent month spans although its docblock says it merges spans that touch

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/lenses/src/spans.ts:32`
  - `shared/lenses/src/spans.ts:89-91`
  - `shared/lenses/src/draft.ts:81`

**Problem.** disjoint uses strict a.to < b.from on yyyymm strings, so [202001,202012] and [202101,202112] stay two spans; including 2019, 2021, then 2020 yields three contiguous spans. Membership (holds) is correct; only reported spans (LensSlice.spans, resolvedSummary) are wrong and read like gaps.

**Evidence.** scratch/shared/spans.cjs: union([{from:'202001',to:'202012'}], {from:'202101',to:'202112'}) -> two spans; unioning 202001, 202002, 202003 one by one -> three spans.

**Fix.** Add an internal 'separate' predicate for union only: (a.to !== null && b.from !== null && after(a.to) < b.from) || (b.to !== null && a.from !== null && after(b.to) < a.from), reusing spans.ts's after(). Keep the strict disjoint in without. Docblock: 'merging anything it overlaps or meets at a month boundary'.

**Tests to add.** spans.test.ts: [202001,202012] u [202101,202112] -> [{from:'202001',to:'202112'}]; 2019, 2021, then 2020 -> one span 201901..202112; a one-month gap (201912 / 202102) stays two spans; the existing 'share no day' test still holds.

**Verifier notes.** Lens B F12 and part of lens A F6; confirmed. Lens A offered changing the docblock to 'overlaps' as an alternative; fixing the code is preferred.

## SHR-15 — parseRules silently alters or accepts malformed modifiers

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/utils/src/routes.ts:26`
  - `shared/utils/src/routes.ts:38-44`
  - `shared/utils/src/routes.ts:77`
  - `shared/utils/src/routes.ts:81-87`
  - `shared/utils/src/routes.ts:175-196`
  - `services/router/src/config.ts:35-46`
  - `services/pipe/src/bindings.ts:86-97`

**Problem.** Whitespace is stripped globally, header values included ('hello world' -> 'helloworld'; documented in the grammar but surprising). Only the first '(' and final ')' are checked: 'topic:b(key:x)(key:y)' gives routingKey 'x)(key' replace 'y'. A repeated key: modifier silently keeps the last. Header/replace on sources are accepted; router's toSource drops source headers silently (and a source key without an exchange).

**Evidence.** parseRules('q > ex@topic:x(header:note=hello world)') -> headers {note:'helloworld'}; parseRules('a > topic:b(key:x)(key:y)') -> {value:'x)(key',replace:'y'}; parseRules('q(header:a=1) > r') -> source headers ignored by router.

**Fix.** Split on '|', '>', '&' and trim pieces instead of stripping all whitespace; inside modifiers split on ',' and trim each token, keeping internal spaces in header values; update the grammar doc at routes.ts:26. parseItem: throw if modifier content has '(' or ')' or the item has more than one '(' / ')' not at the end. parseModifiers: throw on duplicate key: and duplicate header names. Do not add a side parameter to the shared parser (pipe's rules are stricter by design: no replace/headers on either side, no key on destinations); instead make router's toSource throw on source headers and on a source routing key without an exchange.

**Tests to add.** routes.test.ts: '(key:x)(key:y)', '(key:x,key:y)', 'b(key:x))' throw; a header value with a space is preserved. Router config tests: source header and source key without exchange throw.

**Verifier notes.** Merged lens A F11 and lens B F13. Lens A suggested a parser-level side argument; lens B's verifier showed pipe's checks differ, so consumers keep their own validation. Empty rule string is already rejected by router's validateConfig.

## SHR-16 — Vault comma-split read path relies on an unenforced CSV invariant; bare CR is never quoted

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/utils/src/csv.ts:33-35`
  - `shared/utils/src/csv.ts:38-41`
  - `shared/utils/src/tables.ts:310-326`
  - `services/vault/src/data/parse.ts:32`
  - `services/vault/src/data/parse.ts:46-74`
  - `services/vault/src/data/parse.ts:139`

**Problem.** rowToCsv quotes fields containing ',', '"' or LF for any table, but vault reads non-FREE_TEXT tables with readline + line.split(','), assuming nothing is quoted. A comma-bearing or object value in such a table would shift every later column with no error. csvValue does not quote CR, and readline treats a bare CR as a line end, splitting a record. Latent today: no non-free-text table vault writes has such columns.

**Evidence.** rowToCsv({ a: [[1,2],[3,4]] }, ['a']) -> '"[[1,2],[3,4]]"'; rowToCsv({a:'x\ry'}) emits the CR unquoted.

**Fix.** Add CR to the quoting triggers in csvValue (and csvStringValue if SHR-11 has not deleted it). Do NOT throw at write time (would drop live data). In vault's commaSplit, take a slow path for any line containing a double quote and parse that line with csv-parse/sync. Have vault's encode log a once-per-table warning when a value in a non-FREE_TEXT table needed quoting (a quoted LF would still break the line reader; the warning makes it visible).

**Tests to add.** rowToCsv/createCsvParser round trip for CR, LF, quotes, commas; vault parse test where a non-free-text line carries a quoted comma field and returns the right column count.

**Verifier notes.** Lens A F10. Verifier confirmed low and replaced the reviewer's 'throw in encode' with the slow-path read plus warning.

## SHR-17 — @tradebot/utils imports @tradebot/types without declaring it; root tsconfig omits shared/lenses

- **Severity:** low
- **Category:** config
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/utils/src/tables.ts:1`
  - `shared/utils/package.json:13-17`
  - `shared/utils/tsconfig.json`
  - `package.json:20`
  - `tsconfig.json:24-29`

**Problem.** tables.ts type-imports @tradebot/types, which shared/utils/package.json does not list and its tsconfig does not reference; it resolves only through the root devDependency symlink. pnpm's topological build does not know utils must follow types. Works today by accident (utils lands in a later chunk via service-kit/rabbitmq); breaks with 'pnpm --filter @tradebot/utils... build' or graph changes. The root tsconfig references omit shared/lenses.

**Evidence.** shared/utils/node_modules contains only @devvir and csv-parse; node_modules/@tradebot/types -> ../../shared/types; verifier compiled utils against an unbuilt types package and got TS2307.

**Fix.** If SHR-07 removes TABLE_SPECS, drop the import (and the root devDependency if the package goes). Otherwise add "@tradebot/types": "workspace:*" to shared/utils dependencies and "references": [{ "path": "../types" }] to shared/utils/tsconfig.json. Either way add { "path": "shared/lenses" } to root tsconfig references. Verify with pnpm install and a clean 'pnpm --filter @tradebot/utils... build' (rm -rf shared/*/dist).

**Tests to add.** Clean filtered build succeeds.

**Verifier notes.** Merged lens A F13 and lens B F15 (config part). Both verifiers: latent, not flaky; the reviewers' failure scenarios were overstated.

## SHR-18 — sizeOf picks the unit before rounding ('1024 KB' for just under 1 MiB); sizes test docblock is history

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `shared/utils/src/sizes.ts:11-21`
  - `shared/utils/tests/sizes.test.ts:14-18`

**Problem.** sizeOf(1048575) -> '1024 KB' (likewise at every unit edge). Negative/NaN/past-TB inputs print oddly but no caller (hauler/fetch.ts, stocker/scan.ts) passes them. The sizes.test.ts docblock ('The case that prompted this...') is motivation/history, against CLAUDE.md.

**Evidence.** sizeOf(1024*1024-1) -> '1024 KB'; sizeOf(1023.96*1024) -> '1024 KB'.

**Fix.** Decide the unit on the rounded value: while (unit < UNITS.length - 1 && (unit === 0 ? scaled : Math.round(scaled * 10) / 10) >= 1024) { scaled /= 1024; unit++; } (or a post-loop rescale when the rounded value reaches 1024). Optional explicit handling of non-finite/negative input. Replace the test docblock with a statement of the behaviour it pins.

**Tests to add.** sizes.test.ts: sizeOf(1048575) === '1 MB', sizeOf(1023.96*1024) === '1 MB', sizeOf(1023.9*1024) === '1023.9 KB', sizeOf(1024**3 - 1) === '1 GB'.

**Verifier notes.** Merged lens A F15 (sizeOf part) and lens B F16 (sizeOf + test docblock). Cosmetic, logs only.

## Deferred — decisions needed

- **SHR-07** (Two parallel BitMEX schema registries: unused TABLE_SPECS + @tradebot/types vs vault's TABLE_HEADERS/TABLE_CASTS, already disagreeing): Which package owns the BitMEX table schema going forward (for the replay work): delete TABLE_SPECS and @tradebot/types, or move vault's TABLE_HEADERS/TABLE_CASTS into shared and make them the single source of truth? Are TABLE_SPECS's keys/filter wanted for replay?
- **SHR-08** (Shared CSV format writes null, undefined and '' identically, so null updates in websocket deltas are lost): Does captured BitMEX traffic carry explicit nulls or empty strings in update messages? If yes, approve a versioned three-state CSV encoding (absent / \N / "") and decide how existing vault files are handled.

## Rejected

- **Lens tests run only through catalog against a hand-written schema (lens A F12 sub-claim)** — Wrong: services/prospector/tests/lenses.test.ts exercises lenses against the real schema; admit's skip/advance and catchUp's whole/step branches are covered. The real gap (dist resolution, in-package tests) is kept in SHR-09.
- **TABLE_SPECS contradicts vault on instrument 'pool' (lens A F8 sub-claim)** — Not a contradiction: VAULT.md:28 documents the column as present but always empty from the feed.
- **putLens null on 'note: null' from a client (lens A F3 example)** — Cannot happen: prospector passes note ?? '' and editLens uses to.note ?? had.note. Other non-unique errors still justify SHR-04.
- **Throwing in vault encode when a value would need quoting (lens A F10 suggested fix)** — Would drop live data in a collector; replaced by read-side slow path plus warning in SHR-16.
- **Shared parseRules 'side' parameter letting router and pipe drop their checks (lens A F11 / lens B F13 suggestion)** — Pipe's rules are stricter than destination-only by design, so a single parser-level rule cannot replace them.
- **Production cost of re-exporting test helpers from the utils barrel (lens B F15 sub-claim)** — Negligible: builtin child_process and a lazy path.resolve. Kept only as optional hygiene in SHR-13.
- **Flaky pnpm -r build race on @tradebot/types (lens A F13 / lens B F15 failure scenario)** — Does not fire today (topological chunks order types first); latent only, kept as SHR-17.
- **Spread-copy grouping costs a third of lens preview time (lens B F11 figure)** — Re-measured at ~12%; the mechanism stands in SHR-10 with corrected numbers.
- **CSV Date values double-quoted (lens A F5 side note)** — Negligible: rows come from JSON.parse and never contain Date; folded into SHR-08's 'throw on non-plain objects' as a cheap guard.
