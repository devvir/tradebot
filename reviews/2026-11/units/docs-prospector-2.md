# Review: docs-prospector-2 — docs/services/PROSPECTOR.md (line 1500 to end)

## Overall assessment

The scoped half of docs/services/PROSPECTOR.md (line 1500 to the end: pacing, transport, known gaps, configuration, the API, storage, and the long '## Venues' section on series bounds, generation, preamble, probing, reconciliation and parts) carries at least two older designs alongside the current one. One is a preamble that probed for series ends and recorded an `end` bound. The other is a reconciliation made of a tip lift plus a delete. Each design change seems to have added a paragraph saying what changed rather than rewriting the old text, so the file contradicts itself (reconciliation, the preamble, series identity, empty-series handling) and runs to 3,018 lines. Many smaller facts are correct: netgate settings, the HTTP/2 stream cap, worker count, report limits, status fields and migration mechanics. The confirmed factual errors are these. Reconciliation is described wrongly in two incompatible ways. The preamble is described as a removed five-step model. The block latch is said to fire on the first refusal (the code needs five). Bitget's 'three confirmations' does not exist (it drops at once), and okx's 404 drop is undocumented. The concurrency figures (bybit 30, 600 per venue, 4,300) are ones no adapter declares. Generation bounds omit probingLag. The series unique index is misdescribed. The storage section has the wrong table count and an impossible 'catalog writes' claim. The lens API routes are missing. CLAUDE.md is broken throughout: dozens of history sentences, plan text, consumers named in a provider doc, and venue docs naming prospector. Several docblocks in services/prospector/src carry the same wrong facts and are likely their source. Recommended order: fix the content (DPR2-01..12, 14..25), including the docblocks in DPR2-17 in the same pass. Then decide on the restructuring (DPR2-13): a ~300-line PROSPECTOR.md overview (goal, lifecycle, full API, configuration, storage summary), PROSPECTOR-SERIES.md as the single home for the data model and its rules, and PROSPECTOR-TRANSPORT.md for pacing and transport. Venue measurements move to docs/venues/* and plans to docs/planning/CATALOG.md. Nothing in docs/planning/CATALOG.md's Prospector section has landed (okx's 'drop' is still in okx.ts:40), so nothing there needs cutting. Outside the doc lens, for a code reviewer: bitget's `refusesUs` (adapters/bitget.ts:44) ignores the status, so any non-AmazonS3-served answer, 2xx included, counts toward a stand-down, and CloudFront's 503 LimitExceeded would not trip the standard test. Also, `OkxContext.ranges` (okx.ts:22) is computed on every getContext and never read, and okx's `findEnd` is dead code.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| DPR2-01 | high | docs-correctness | IMPLEMENT | Reconciliation ("What a completed update pass is worth") describes the wrong algorithm and contradicts the doc's other description |
| DPR2-02 | high | docs-correctness | IMPLEMENT | The preamble and "series life" sections describe a removed model (probing for ends, an `end` bound, constructed-key venues only, runs inside getContext) |
| DPR2-03 | medium | docs-correctness | IMPLEMENT | Pacing says a block latches on the first refusal; the code needs five consecutive 403/429s (or the adapter's `refusesUs`) and eases after 30 minutes |
| DPR2-04 | medium | docs-correctness | IMPLEMENT | Absence confirmation: bitget's "three confirmations" is wrong, `'drop'` bypassing confirmation is undocumented, and okx's 404 drop is missing |
| DPR2-05 | medium | docs-correctness | IMPLEMENT | Generation bounds: END omits probingLag, "no start produces no path" is outdated, and venue-wide generation is misdescribed |
| DPR2-06 | medium | docs-correctness | IMPLEMENT | Series identity is described as COALESCE(url_symbol, symbol) enforced by the table; the index is on instrument_id and COALESCE(url_symbol, ''), and the name rule lives in the registry |
| DPR2-07 | medium | docs-correctness | IMPLEMENT | Storage: "Seventeen tables" is wrong, "the two tables the catalog writes" is impossible, the schema location is wrong, and migration 001 is misdescribed |
| DPR2-08 | medium | docs-completeness | IMPLEMENT | The API table and route list leave out the three lens routes |
| DPR2-09 | medium | docs-correctness | IMPLEMENT | "Every request passes the gate / goes through send / is sent from a worker" is false for venue API calls |
| DPR2-10 | medium | docs-correctness | IMPLEMENT | The concurrency arithmetic uses figures no adapter declares (bybit 30, 600 per venue, 4,300 total) and a nonexistent `CONCURRENCY` |
| DPR2-11 | medium | docs-correctness | IMPLEMENT | OVERDUE_DAYS: the "first Monday" venue is misattributed, "acts exactly once" is wrong, and plan text sits in Known gaps |
| DPR2-12 | medium | docs-claude-md | IMPLEMENT | History and "no longer" narration throughout the scoped text (rule: only what is true today) |
| DPR2-13 | medium | docs-structure | DEFER | Structure: "## Venues" holds ~750 lines of the series model, and several subjects are explained two or three times in one file |
| DPR2-14 | low | docs-correctness | IMPLEMENT | Known gaps contradict the deletion and recreation of empty series |
| DPR2-15 | low | docs-correctness | IMPLEMENT | PROSPECTOR_VENUES lists the wrong venues; .env.example omits bitget; compose.yml has an orphaned comment |
| DPR2-16 | low | docs-claude-md | IMPLEMENT | The API and Reports sections explain the provider by its consumers and describe catalog/downloader internals |
| DPR2-17 | low | docs-docblock | IMPLEMENT | Stale docblocks in services/prospector repeat or seed the doc's wrong facts |
| DPR2-18 | low | docs-correctness | IMPLEMENT | The "empty series" section gives an outdated, contradictory reason for reading the file table |
| DPR2-19 | low | docs-completeness | IMPLEMENT | The `open` table leaves out the "never asked about → closed" case |
| DPR2-20 | low | docs-claude-md | IMPLEMENT | Venue measurements are duplicated in the service doc, and venue docs name prospector |
| DPR2-21 | low | docs-clarity | IMPLEMENT | "Reconcile" names two different mechanisms, and "slice" names both a table and the write queue |
| DPR2-22 | low | docs-correctness | IMPLEMENT | Carrying requests misstates the keep-alive setup and presents a guideline as a guarantee |
| DPR2-23 | low | docs-completeness | IMPLEMENT | Parts: gate's behaviour is described incompletely |
| DPR2-24 | low | docs-correctness | IMPLEMENT | The bybit/secondary `surveying()` rationale ignores existence-based confirmation |
| DPR2-25 | low | docs-claude-md | IMPLEMENT | The migration policy paragraph is contributor process duplicated in the migrations index docblock |

## DPR2-01: Reconciliation ("What a completed update pass is worth") describes the wrong algorithm and contradicts the doc's other description

- **Severity:** high
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:2894-2938`
  - `docs/services/PROSPECTOR.md:2596-2603`
  - `docs/services/PROSPECTOR.md:1775-1784`
  - `docs/services/PROSPECTOR.md:2316-2318`
  - `services/prospector/src/catalog/series.ts:503-690`
  - `services/prospector/src/sync.ts:405`

**Problem.** 2898-2903 describes reconciliation as two statements (`tip := max(tip, TODAY - OVERDUE_DAYS)` and a DELETE). 2905 says "Bounds are not among them" and 2922 says a fully found series "has already carried its own tip up past the floor". The code has three steps and returns {lifted, removed, corrected}; its own docblock says "Three statements". 2600-2603 contradicts 2898 by saying reconciliation recomputes bounds, and it cites a `file_bounds` read that exists nowhere in the code. 1775-1784 restates the rule a second time, and 2316-2318 says `first` is filled by "reconciliation's own third step" as if that were its only writer. The section also carries history ("Reconciliation used to fill...", "unifying the two changed no number").

**Evidence.** series.ts reconcile: step 1 `proof = min(row.last, lastClosed(grain, start)); upto = max(proof, floor)` with floor = lastSettled(grain, start); step 2 `remove(db, held, row)` when no non-absent file; step 3 rewrites first/last and runs `summary.corrected++` (series.ts:678). The bounds are two ordered `SELECT date FROM file WHERE series_id=? AND existence <> 'absent' ORDER BY date [DESC] LIMIT 1` lookups on the file_series index. `grep -rn file_bounds` matches only PROSPECTOR.md:2601. sync.ts:405 passes `began(db, venueId)` (the pass's start).

**Fix.** Make 'What a completed update pass is worth' (2894-2938) the one home for `reconcile` and rewrite it from series.ts:503-690. It runs only after a pass that generated every URL it owed and drained `wip`, once per venue, as of the job's start time and not the clock, and it yields every YIELD_EVERY series. Per series: (1) floor = lastSettled(grain, START); tip := max(tip, floor, min(last, lastClosed(grain, START))), skipping the min when last is NULL, counted as `lifted`. The tip never lowers and never passes an unclosed period. (2) If `file` holds no row with existence <> 'absent', delete the series (`removed`); the check reads the file table, not `first`. (3) Otherwise set first/last to the oldest and newest non-absent file dates, counting changed rows as `corrected` (expected zero). Either note that step 1 uses the pre-correction `last`, so a newest file withdrawn on this pass can still lift the tip, or leave the order unstated. Delete 'Bounds are not among them', 'It only ever raises... carried its own tip', 'Reconciliation used to fill...' and 'unifying the two changed no number'. Keep the delete-reads-`file` rationale, but drop its history framing. In 2600-2603, replace 'one ordered read of `file_bounds`' with 'two ordered lookups per series on the `file_series` index'. Cut 1775-1784 to one sentence plus a link. Fix 2316-2318: a sighting writes `first`, and reconciliation only corrects it.

**Tests.** None (docs only). Afterwards, grep the doc for 'TODAY - OVERDUE_DAYS' and 'file_bounds' and expect no matches. Check the new text against series.ts:585-690 line by line.

**Verifier notes.** Both verifiers confirmed at high severity. Verifier 1 noted the nuance that step 1 reads the pre-correction last. Verifier 2 confirmed that sync.ts:405 passes the pass's start, so the 'as of the pass's own start' paragraph is correct and can stay.

## DPR2-02: The preamble and "series life" sections describe a removed model (probing for ends, an `end` bound, constructed-key venues only, runs inside getContext)

- **Severity:** high
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:2311-2323`
  - `docs/services/PROSPECTOR.md:2343-2360`
  - `docs/services/PROSPECTOR.md:2859-2874`
  - `docs/services/PROSPECTOR.md:2283`
  - `docs/services/PROSPECTOR.md:526-536`
  - `docs/services/PROSPECTOR.md:2770-2890`
  - `services/prospector/src/preamble.ts:10-29`
  - `services/prospector/src/preamble.ts:180-250`
  - `services/prospector/src/sync.ts:299-313`
  - `services/prospector/src/database/schema.ts:471-496`
  - `services/prospector/src/adapters/okx/instruments.ts:113-139`

**Problem.** 2343-2355 says a constructed-key adapter reconciles the table 'on every start, before the context is built' in five steps, and two of those steps probe for an end and for the newest start. The state table (2315-2318) and the retirement table (2861-2866) assume a per-series start/end bound and say 'end recorded — never generated for again'. 2859 says the preamble is 'the only place a series is retired'. None of this exists. The preamble runs only on a fresh update pass, never on a resume and never in getContext, and it runs for every adapter with `instruments`, which is all eight, listing venues included. It floors missing tips, creates series with a tip at the covered floor, revives relisted rows, writes `state`, and backfills only series with first IS NULL. It records no end; whether keys are still generated is `open()`'s decision. 526-536 wrongly says listing venues have 'no reconciliation step', which contradicts 2784. The 'partial' row at 2283 attributes discovery to getContext.

**Evidence.** sync.ts:306 `if (doing === 'partial' && updateStarted(db, venueId) === null) { const found = await preamble(...)`. All eight adapter files declare `instruments:` (binance.ts:35, bitget.ts:37, bybit.primary.ts:35, bybit.secondary.ts:39, gate.ts:43, htx.ts:31, kucoin.ts:27, okx.ts:43). preamble.ts:199-203 says it 'says nothing about where the series *ended*'. recordSeries is given `{ tip: floor(shape.grain, covered, null) }` (preamble.ts:180-182). The series table has no end column. okx's getContext calls only symbolRanges, a pure DB read. okx/instruments.ts `findEnd` is referenced only by its `_test_findEnd` export.

**Fix.** Make '### The preamble: asking the venue what it lists' (~2770) the one home and describe preamble.ts as it is now. When: at the start of every update pass that is not a resume (sync.ts:306), for any adapter with an `instruments` hook (all eight today), run to completion before generation. Steps: (1) floorTips: a series with a first and no tip gets the period below its first. (2) An empty listing or a failed `agrees` check (AGREEMENT 0.5) refuses the whole step. (3) Each live listed instrument with no active series either has its non-retired rows revived (state=active, tip floored at lastSettled(grain, coveredTo), last untouched) or gets one series per live pattern that can carry the symbol, with transforms and urlSymbolFor applied and the tip at the floor. (4) `delisted` is written only for markets the listing spoke about, skipping retired patterns and `{SYMBOL}`-less buckets. (5) Backfill runs only for series with first IS NULL. State that it records no end, and that whether a quiet or delisted series is still generated for is `open()`'s decision (link to the `open` section). Delete 2343-2360 and the retirement table plus the 'Stopped means...' paragraph at 2859-2874. Move the patience-window explanation to `open` if it is not already there. Reduce 2311-2323 to the active/delisted meaning of `state`, with no end bound. In the occasion table at 2283, remove 'reconciling' from the 'partial' row. Rewrite 526-536 so it says every venue with a listing, walked or not, runs the preamble on fresh update passes, and that a walk remains the authority on what the archive holds. Fix the anchor at 530 if a heading is renamed.

**Tests.** None (docs only). After editing, `grep -n '\bend\b'` near the series and preamble sections should find no per-series end bound. Optional (outside the docs lens): remove the dead okx `findEnd` / `_test_findEnd` and any test covering only them, then run the prospector test suite.

**Verifier notes.** Both verifiers confirmed at high severity. Verifier 2 also found that okx's `findEnd` is dead code, which may be why the stale model survived. Removing it is optional and is a code change.

## DPR2-03: Pacing says a block latches on the first refusal; the code needs five consecutive 403/429s (or the adapter's `refusesUs`) and eases after 30 minutes

- **Severity:** medium
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:1535-1548`
  - `services/prospector/src/pace.ts:25`
  - `services/prospector/src/pace.ts:577-603`
  - `services/prospector/src/pace.ts:813`
  - `services/prospector/src/http.ts:54-58`
  - `services/prospector/src/http.ts:190-191`
  - `services/prospector/src/http.ts:236-270`
  - `services/prospector/src/adapters/bitget.ts:43-44`

**Problem.** The doc says `send` latches the venue's gate 'the moment it sees one' and that 'Anything refusing without naming a key is read as a block'. The code counts a refusal only when the adapter's `refusesUs` says so, or by default when the reply is a 403/429 without `x-amz-error-code`. It stands the venue down only after REFUSALS_BEFORE_BLOCK = 5 consecutive refusals, logs the ones below that, and resets the count on any other answer. The doc also leaves out the 30-minute EASE_AFTER_MS that forgets escalation, and it presents `server: AmazonS3` as part of the standard test when only bitget's override reads that header.

**Evidence.** pace.ts:25 `REFUSALS_BEFORE_BLOCK = 5`; pace.ts:582-591 logs 'Venue refused a request; retrying' and returns below 5; http.ts:54-58 `adapter.refusesUs?.(status, headers) ?? standard(status, headers)` with standard = 403/429 && no x-amz-error-code; pace.ts:813 `EASE_AFTER_MS = 30 * 60_000`; bitget.ts `refusesUs: (_s, h) => h.get('server') !== 'AmazonS3'`.

**Fix.** Rewrite 1535-1548. A response is a refusal aimed at us when the adapter's `refusesUs(status, headers)` says so; with no override, it is a 403 or 429 without `x-amz-error-code`. Bitget's override counts any answer not served by `AmazonS3`, whatever its status. Refusals are answers and are never retried (`answered` in http.ts). After REFUSALS_BEFORE_BLOCK (5) consecutive refusals, with no other answer between them, the venue's gate is stood down for every caller. Any other answer resets the count, and refusals below five are only logged. The first pause is `standDownMs` and doubles per round up to `ceilingMs`; a refusal during a pause belongs to that round. The doubling is forgotten after 30 quiet minutes (EASE_AFTER_MS). Remove 'and AmazonS3 as the server' from the generic S3 description. Optional docblock and log fixes: change the log string at pace.ts:588 to drop 'retrying', since the request is not retried.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed and lowered the severity from high to medium (the doc is wrong, but the real behaviour is safer than documented); no second verdict was given, which is consistent with medium. For a code reviewer, outside this unit: bitget's refusesUs ignores the status, so a 2xx/404/5xx served by CloudFront without `server: AmazonS3` counts toward a stand-down, and bitget's 503 LimitExceeded from CloudFront would not trip the standard test.

## DPR2-04: Absence confirmation: bitget's "three confirmations" is wrong, `'drop'` bypassing confirmation is undocumented, and okx's 404 drop is missing

- **Severity:** medium
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:2684-2687`
  - `docs/services/PROSPECTOR.md:2706-2710`
  - `docs/services/PROSPECTOR.md:2715-2720`
  - `docs/services/PROSPECTOR.md:2726`
  - `docs/services/PROSPECTOR.md:2728-2732`
  - `services/prospector/src/probe.ts:221`
  - `services/prospector/src/probe.ts:230-243`
  - `services/prospector/src/probe.ts:609-630`
  - `services/prospector/src/adapters/bitget.ts:47-53`
  - `services/prospector/src/adapters/okx.ts:35-40`
  - `services/prospector/src/reports.ts:229`

**Problem.** 2731 says bitget 'still takes its three confirmations'. No three exists: CONFIRMATIONS is 30 for confirmed rows and 2 for assumed ones, and a `'drop'` verdict skips confirmation entirely. Bitget drops an S3-served 403 and okx drops every 404, so the opening claim at 2684 ('only once the venue has given it more than once') is false for both probed venues. The verdict table at 2709 does not say that 'drop' bypasses the count. 2715-2720 says probing honours `notFoundCodes`, but the probe decides absence as `verdict === 'drop' || status === 404`, and `notFoundCodes` is read only by reports. 2726 ('confirming it a hundred times') does not match 2/30.

**Evidence.** probe.ts:241 `if (verdict !== 'drop' && row.tries + 1 < confirmations(row)) return;`; probe.ts:623 CONFIRMATIONS = {confirmed: 30, assumed: 2}; bitget.ts:52 `(status === 403 && headers.get('server') === 'AmazonS3' ? 'drop' : null)`; okx.ts:40 `status === 404 ? 'drop' : null` (marked TEMPORARY, see docs/planning/CATALOG.md); notFoundCodes is read only at reports.ts:229, and no adapter declares one.

**Fix.** At 2684, qualify the claim with 'unless the adapter's rule answers `'drop'`, which sets the key down on that answer'. Change the 'drop' row at ~2709 to 'absent now: the row is spent on this answer, with no confirmation count'. Replace 2730-2732 with: 'Bitget's `ruleOnFailure` answers `'drop'` for an S3-served 403, so a missing key is set down on its first answer and asked again by the next update.' Add one sentence saying okx's rule currently answers `'drop'` on every 404, with a pointer (not an explanation) to docs/planning/CATALOG.md for its removal. Correct 2715-2720: `notFoundCodes` is read by the reports' absence classification, and the probe treats only 404 and `'drop'` as absence. Fix 'a hundred times' at 2726 so it matches CONFIRMATIONS.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed and added the notFoundCodes and 'hundred times' errors. Whether probe.ts should honour `notFoundCodes` is a possible code question for the owner, but the doc fix does not depend on it.

## DPR2-05: Generation bounds: END omits probingLag, "no start produces no path" is outdated, and venue-wide generation is misdescribed

- **Severity:** medium
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:2516-2519`
  - `docs/services/PROSPECTOR.md:2300-2303`
  - `docs/services/PROSPECTOR.md:2305-2309`
  - `services/prospector/src/update.ts:69-75`
  - `services/prospector/src/update.ts:104`
  - `services/prospector/src/update.ts:216-230`
  - `services/prospector/src/update.ts:258-259`
  - `services/prospector/src/update.ts:312-329`

**Problem.** The formula comment gives END as 'yesterday, or last month', but every adapter sets probingLag 3 (bitget 4), and `under()` stops lag-1 days earlier. The formula also leaves out the seeded skip span. 'A series with no start produces no path' is wrong: generation needs a tip, not a `first`, and every series the preamble creates has first=NULL and a tip, and does generate. 2305-2309 says a venue-wide file is generated 'from the earliest start that dataset records'; in fact it is generated from its own tip like any other series.

**Evidence.** update.ts:104 `under(series.grain, now, series.retiredAt, rules?.lag)`; update.ts:319-321 `lastClosed(grain, lag > 1 ? now - (lag-1) days : now)`; update.ts:258-259 `generable = open(series) && series.tip !== null`; update.ts:228-230 warns 'Series with no known start skipped'; update.ts:216-218 says a symbol-less series is generated 'no different from here'.

**Fix.** In the formula block write `END := min(last period closed probingLag days ago, retired_at)` and point to 'How far behind today a probing update asks' (~469) instead of restating the lags. Add one line for the seeded skip span `[last+1, lastSettled(seededAt)]` (update.ts:69-75), or point to it. Rewrite 2300-2303 as: 'A series with no tip generates nothing: it is skipped and logged (`Series with no known start skipped`). A series with a tip and no `first` — every one the preamble creates — generates from the period after its tip.' Replace 2305-2309 with 'A venue-wide file has no instrument, and its series is generated from its own tip like any other.'

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed all three claims.

## DPR2-06: Series identity is described as COALESCE(url_symbol, symbol) enforced by the table; the index is on instrument_id and COALESCE(url_symbol, ''), and the name rule lives in the registry

- **Severity:** medium
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:2485-2491`
  - `docs/services/PROSPECTOR.md:2197-2198`
  - `docs/services/PROSPECTOR.md:2525-2530`
  - `services/prospector/src/database/schema.ts:498-502`
  - `services/prospector/src/catalog/series.ts:990-994`
  - `services/prospector/src/catalog/series.ts:1071-1078`

**Problem.** 2485-2491 says SQLite enforces series identity as a unique index over COALESCE(url_symbol, symbol), and that a spelled-out url_symbol 'collides as it should' with an implicit one. The table index is actually (pattern_id, COALESCE(instrument_id, 0), COALESCE(url_symbol, '')), and the series table has no symbol column. The name-based rule exists only in memory, in the registry's `identity()`, which refuses a second series of one shape whose keys carry the same name.

**Evidence.** schema.ts:501-502 `CREATE UNIQUE INDEX ... series_key ON series (pattern_id, COALESCE(instrument_id, 0), COALESCE(url_symbol, ''))`; series.ts:1071-1078 identity() keys on `urlSymbol ?? symbol`; series.ts:990-994 'The registry refuses two series of one shape whose keys carry one name before either reaches here'. Writers store NULL when the spelling equals the symbol (preamble.ts:181, paths.ts:194, kucoin.ts:75).

**Fix.** Replace 2485-2491 with: 'A series is one shape and the name its keys carry — `url_symbol` where there is one, otherwise the symbol. Two series of one shape that resolve to the same name would generate the same URLs, so the registry (`identity()` in `catalog/series.ts`) refuses the second before it is written. The table's own unique index is narrower: pattern, instrument (none for a venue-wide file) and `url_symbol` with NULL as `''`. Writers therefore store NULL, never a copy of the symbol, where the archive spells the instrument as the venue does.' Keep 2197-2198 as the short form, noting that it describes the table index. Cut the history at 2525-2530 ('It used to...', 'is now a separate question').

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed the SQL error but corrected the reviewer's suggested fix: the reviewer's text ('two instruments whose keys resolve to the same name are also allowed') would be wrong, because identity() refuses them. The fix above uses the verifier's two-layer description.

## DPR2-07: Storage: "Seventeen tables" is wrong, "the two tables the catalog writes" is impossible, the schema location is wrong, and migration 001 is misdescribed

- **Severity:** medium
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:2134`
  - `docs/services/PROSPECTOR.md:2137-2142`
  - `docs/services/PROSPECTOR.md:2153-2159`
  - `docs/services/PROSPECTOR.md:2218-2222`
  - `docs/modules/CATALOG-LENSES.md:148-149`
  - `services/catalog/src/database.ts:26`
  - `services/prospector/src/database/schema.ts:74-496`
  - `services/prospector/src/database/migrations/001-core.ts:36-44`

**Problem.** schema.ts creates 16 tables, and the doc's own list names 16, yet the text says 'Seventeen'. 2159 calls lens/lens_member 'the two tables the catalog writes'. That contradicts 2137-2142 and CATALOG-LENSES.md:148, and it is impossible because the catalog opens the database read-only. 2134 puts the schema in src/catalog/, but it is src/database/schema.ts. 2218 says migration 1 carries 'two lists of gate files'; it ships three exclusion sets. 2220-2222 contains history ('what an earlier arrangement got backwards').

**Evidence.** `grep -c 'CREATE TABLE' schema.ts` = 16; catalog database.ts:26 `new DatabaseSync(path, { readOnly: true })`; 001-core.ts:40-43 runs VENUES, ZERO_BYTE_UPLOADS, SPOT_AT_A_FUTURES_URL, MISFILED_AT_BYBIT.

**Fix.** (1) 'Seventeen tables' -> 'Sixteen tables'. (2) End the list with '`lens` and `lens_member` are the lenses stored through the private API, and what each lets through', dropping 'the two tables the catalog writes'. (3) Line 2134 -> 'The schema lives in `src/database/schema.ts`, with the migrations beside it in `src/database/migrations/`'. (4) Line 2218 -> 'the schema with the venue rows and the shipped exclusions (gate's two zero-byte upload tests, gate's 85 spot files at futures URLs, bybit's one misfiled DOTUSDT day)'. (5) Cut the 'earlier arrangement got backwards...' clause.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed and added the wrong schema location (2134) and the history clause.

## DPR2-08: The API table and route list leave out the three lens routes

- **Severity:** medium
- **Category:** docs-completeness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:1961-1970`
  - `docs/services/PROSPECTOR.md:2142-2151`
  - `services/prospector/src/api/index.ts:85-87`
  - `services/prospector/src/api/lenses.ts:28-77`
  - `docs/modules/CATALOG-API.md:7-8`

**Problem.** The private API mounts POST /lenses, PUT /lenses/:slug and DELETE /lenses/:slug, but the table lists only surveys, pause, status and reports, and the routes sentence names only api/collector.ts and api/reports.ts. CATALOG-API.md sends readers here for the private API, so the lens write routes are documented nowhere.

**Evidence.** api/index.ts:85-87 `mountCollector; mountReports; mountLenses(app, db)`. lenses.ts: POST 400 without a slug, 409 when the slug is taken, otherwise 201; PUT 404 or 409, otherwise 200; DELETE 404 or 204. lensesChanged() runs after POST and PUT, not after DELETE.

**Fix.** Add these rows: `POST /lenses` (store a new lens `{slug, name, note, definition}`; 400 without a slug, 409 when the slug is taken, 201 with the lens); `PUT /lenses/:slug` (replace a lens whole; 404 when there is none, 409 when the new slug is taken, 200 with the lens); `DELETE /lenses/:slug` (204, or 404). Add one sentence: a write answers once the row is stored, nothing is validated again here, and membership is worked out afterwards in the background (`src/lenses.ts`), with the lens answering `updating` until then. Name `api/lenses.ts` in the routes sentence. Move the lens paragraph from Storage (2142-2151) to a `### Lenses` subsection of The API, leaving in Storage only that the tables live here.

**Tests.** None (docs only). Check the status codes against api/lenses.ts as you write them.

**Verifier notes.** Verifier 1 confirmed and corrected the reviewer: lensesChanged() is not called on DELETE.

## DPR2-09: "Every request passes the gate / goes through send / is sent from a worker" is false for venue API calls

- **Severity:** medium
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:1502-1511`
  - `docs/services/PROSPECTOR.md:1520-1521`
  - `docs/services/PROSPECTOR.md:1584`
  - `docs/services/PROSPECTOR.md:2757-2768`
  - `services/prospector/src/metadata.ts:9`
  - `services/prospector/src/metadata.ts:20-48`
  - `services/prospector/src/adapters/bitget/symbols.ts:81-82`
  - `services/prospector/src/pace.ts:12-13`
  - `services/prospector/src/pace.ts:104-115`

**Problem.** 1505, 1520 and 1584 say every request passes the pace gate, goes through `send`, and is sent from a worker. Instrument-listing calls go through `fetchJson`, which uses global fetch on the main thread with no Pace, tickets or worker, and bitget's archive-name search is a raw fetch POST. 1510-1511 justifies per-host pacing by the instrument API being a separate machine, which makes no sense when API calls are not paced at all. The doc's own 2759 says so, and 2767 carries history ('It began as one venue's').

**Evidence.** metadata.ts:9 'It also sits outside the pace gate'; metadata.ts:48 `await fetch(url, { signal })`; bitget/symbols.ts:81-82 'A POST, which `fetchJson` does not speak' `await fetch(SEARCH, ...)`. Neither imports paceFor, send or carry. pace.ts labelOf already separates bybit/primary from bybit/secondary.

**Fix.** Narrow 1505, 1520 and 1584 to 'every request to a venue's archive'. Replace 1510-1511 with: 'The key is the adapter's label (venue, plus `host` where one venue has two adapters, as bybit's primary and secondary do) and the URL's hostname, so a request to any other address never draws on the base's budget. Calls to a venue's own API are not paced here at all — see Asking a venue about itself.' Do not give bybit primary/secondary as the reason for per-hostname keying, since the label already separates them. At 2767-2768, drop the history and state: '`fetchJson` in metadata.ts serves every adapter's instrument listing; bitget's archive-name search is a POST and uses a bare `fetch` with a timeout.' Mention the `metadataGap` spacing only after checking its value in metadata.ts.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed but corrected the reviewer's replacement rationale: bybit primary and secondary already get separate Paces through the label, so per-hostname keying is defensive only. The verifier also judged 'One implementation, seven callers' accurate (seven venues' instrument modules import fetchJson), so only the history clause needs to go.

## DPR2-10: The concurrency arithmetic uses figures no adapter declares (bybit 30, 600 per venue, 4,300 total) and a nonexistent `CONCURRENCY`

- **Severity:** medium
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:1828-1830`
  - `docs/services/PROSPECTOR.md:1835`
  - `docs/services/PROSPECTOR.md:1842-1844`
  - `docs/services/PROSPECTOR.md:1880-1882`
  - `services/prospector/src/adapters/bybit.primary.ts:29`
  - `services/prospector/src/adapters/bybit.secondary.ts:33`
  - `services/prospector/src/pace.ts:30-32`
  - `services/prospector/src/pace.ts:62-63`
  - `services/prospector/src/config.ts:35`

**Problem.** 'Bybit's 30 was earned by being turned away' (1829) is false: bybit declares 2000/500 (primary) and 5000/500 (secondary). '4,300 in flight — 600 each, and 100 for okx' is false: the sum is 7x500 + 100 = 3,600. The '~600 in flight' arithmetic at 1842-1844 rests on a figure no adapter uses. 1835 names `CONCURRENCY`, which does not exist.

**Evidence.** Adapter pacing: binance 2000/500, bitget 2500/500, bybit primary 2000/500, bybit secondary 5000/500, gate 2000/500, htx 2000/500, kucoin 5000/500, okx 100/100. `grep -rnw CONCURRENCY src` finds nothing.

**Fix.** Delete the bybit-30 sentence at 1829. At 1835, replace `CONCURRENCY` with 'a venue's `concurrency`' (the ceiling `lanesFor` applies). At 1880-1882, prefer removing the hard-coded numbers: 'each adapter declares its cadence and concurrency beside its evidence; the sum across venues is larger than one machine can hold open, which is why PROSPECTOR_CONCURRENCY (default 200) pools them.' If you keep a number, use '3,600 — 500 each and 100 for okx'. At 1842-1844, keep the formula (in flight ≈ cadence × time per missing key) and drop the dated per-venue arithmetic, or move it to the venue docs. Do not add an unmeasured 'cannot be reached' claim for kucoin or bybit secondary. The matching pace.ts:30-32 docblock fix is in DPR2-17.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed but rejected the reviewer's added claim that kucoin and bybit secondary cannot reach 5,000/s. That claim rests on an assumed latency, and the default PROSPECTOR_CONCURRENCY of 200 caps in-flight requests machine-wide anyway.

## DPR2-11: OVERDUE_DAYS: the "first Monday" venue is misattributed, "acts exactly once" is wrong, and plan text sits in Known gaps

- **Severity:** medium
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:1735-1737`
  - `docs/services/PROSPECTOR.md:1761-1763`
  - `docs/services/PROSPECTOR.md:1769-1771`
  - `docs/services/PROSPECTOR.md:2752-2753`
  - `docs/venues/BINANCE.md:16`
  - `docs/venues/BINANCE.md:22`
  - `docs/venues/GATE.md:172`
  - `services/prospector/src/dates.ts:131-154`
  - `services/prospector/src/probe.ts:209-210`
  - `services/prospector/src/catalog/series.ts:410`
  - `services/prospector/src/catalog/series.ts:436-460`

**Problem.** 1761 attributes the 'first Monday' monthly publication to gate and 1736 attributes it to bybit; BINANCE.md says it is binance's, and GATE.md:172 says gate publishes on the 7th or the 1st. dates.ts:131-133 carries the same misattribution. 2752 says OVERDUE_DAYS 'acts exactly once, in reconciliation' (repeated in probe.ts:209-210), but through lastSettled it sets the reconciliation floor, the preamble/backfill start for new or relisted series, the seeded skip span, the starting tip of a series a walk creates, and open()'s patience. dates.ts says 'three readers' and 'A walk has no use for it', and both are stale. 1769-1771 (a per-venue distribution to come) and the proposal at 1735-1737 are plans.

**Evidence.** BINANCE.md:22 'A month is not published on the 1st but on the **first Monday**'; dates.ts:141-150 'One number, three readers'; series.ts:442 `lastSettled(grain, since)` in walkEdge; lastSettled callers: series.ts:593, :442, :278, preamble.ts:387, backfill.ts:65, update.ts:122.

**Fix.** PROSPECTOR.md:1736-1737 and 1761, and dates.ts:131-133: attribute the longest documented wait to binance (a month published on its first Monday, up to the 7th), or cite gate's 7d candles on the 7th (GATE.md:172); the 'fifteen is twice the worst' argument holds either way. PROSPECTOR.md:2752-2753 and probe.ts:209-210: state that probing never settles a period by the clock, and that OVERDUE_DAYS (through lastSettled) sets the reconciliation floor, the preamble/backfill start for new or relisted series, the seeded skip span, the starting tip of a series a walk creates, and open()'s patience window. Drop 'any more' and the 'abandoned table went with...' sentence. dates.ts:140-152: list the full set of readers and delete 'A walk has no use for it'. Move 1769-1771 and the 'encoding when a file is expected...' proposal at 1735-1737 to docs/planning/CATALOG.md (which has no such entry today), keeping in Known gaps only the present fact that nothing models when a file is expected.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed and widened the scope to the dates.ts:131-133 and probe.ts:209-210 docblocks.

## DPR2-12: History and "no longer" narration throughout the scoped text (rule: only what is true today)

- **Severity:** medium
- **Category:** docs-claude-md
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:1784`
  - `docs/services/PROSPECTOR.md:1860-1864`
  - `docs/services/PROSPECTOR.md:1874`
  - `docs/services/PROSPECTOR.md:1883`
  - `docs/services/PROSPECTOR.md:1888`
  - `docs/services/PROSPECTOR.md:1925-1931`
  - `docs/services/PROSPECTOR.md:2220-2223`
  - `docs/services/PROSPECTOR.md:2340-2341`
  - `docs/services/PROSPECTOR.md:2405-2406`
  - `docs/services/PROSPECTOR.md:2521-2526`
  - `docs/services/PROSPECTOR.md:2627-2635`
  - `docs/services/PROSPECTOR.md:2637-2640`
  - `docs/services/PROSPECTOR.md:2645-2646`
  - `docs/services/PROSPECTOR.md:2652-2668`
  - `docs/services/PROSPECTOR.md:2752-2753`
  - `docs/services/PROSPECTOR.md:2767-2768`
  - `docs/services/PROSPECTOR.md:2906-2913`
  - `docs/services/PROSPECTOR.md:2937-2938`

**Problem.** CLAUDE.md forbids history in tech docs. The scoped text keeps narrating past designs: 'no longer can be... used to serve', 'That is no longer something to tune around', 'Summed figures once came back as connect timeouts', 'what an earlier arrangement got backwards', 'It used to', 'The old rule was...', 'A walk used to state its own tips separately', 'Nothing crawls a tip forward any more... That was a real bug', 'The `abandoned` table went with the rule that filled it', 'It began as one venue's', 'Reconciliation used to fill...', 'unifying the two changed no number'. Several are paragraphs long (2627-2635, 2652-2668).

**Evidence.** Quoted phrases at the cited lines.

**Fix.** Delete the narrated history at each location and keep only the current rule it ends with. Replacement for 2652-2668: 'Generation reads the run's own cursor, never a tip, and never writes one. A generated key is a question, and a `wip` row dropped without settling is never regenerated, so a tip may not move past a period that has not been answered or waited out. An existing tip is lifted only by reconciliation after a finished pass; the preamble and a walk set a tip only when they create or revive a series (and floorTips gives a tip to a series with a first and none).' Fix 2637-2640 ('there is one place that happens: reconciliation') to match. For 2627-2635, keep only 'a start floors generation; keys below it already in `wip` keep being probed and can lower it'. For 1888 and 1929-1931, state the constraint: per-adapter in-flight figures can each be right while their sum exceeds what the machine can carry, so a machine-wide pool caps the total. Delete 2767-2768's first clause, 2906-2908 and the last clause of 2937-2938. Where a rationale matters, phrase it as a present constraint, not a past bug. Many of these sit in sections rewritten by DPR2-01, -02 and -11, so do this pass after those.

**Tests.** None (docs only). Afterwards, grep the doc for 'used to', 'no longer', 'any more', 'once ', 'old rule', 'earlier' and 'now ' and review each remaining hit.

**Verifier notes.** Verifier 1 confirmed but corrected the reviewer's replacement: 'a tip is moved only by reconciliation' is false, because the preamble (preamble.ts:134, :182, :297) and a walk (series.ts:410) also set tips.

## DPR2-13: Structure: "## Venues" holds ~750 lines of the series model, and several subjects are explained two or three times in one file

- **Severity:** medium
- **Category:** docs-structure
- **Decision:** DEFER
- **Locations:**
  - `docs/services/PROSPECTOR.md:2249-3018`
  - `docs/services/PROSPECTOR.md:164-175`
  - `docs/services/PROSPECTOR.md:2278-2287`
  - `docs/services/PROSPECTOR.md:149-153`
  - `docs/services/PROSPECTOR.md:2272-2273`
  - `docs/services/PROSPECTOR.md:1526-1533`
  - `docs/services/PROSPECTOR.md:1826-1912`
  - `docs/services/PROSPECTOR.md:2568-2573`
  - `docs/services/PROSPECTOR.md:2872-2874`
  - `docs/services/PROSPECTOR.md:2587-2593`
  - `docs/services/PROSPECTOR.md:2622-2625`
  - `docs/services/PROSPECTOR.md:2605-2614`
  - `docs/services/PROSPECTOR.md:2637-2650`
  - `docs/services/PROSPECTOR.md:518-540`
  - `docs/services/PROSPECTOR.md:2770-2890`
  - `docs/services/PROSPECTOR.md:1684-1717`

**Problem.** Under '## Venues', which should describe the registry, the doc carries the pattern/series schema, bounds, `open`, the sighting rules, tip ownership, absence confirmation, the preamble, reconciliation and parts. The 'one home' rule is broken repeatedly. The occasion table appears at 164-175 and again at 2278-2287. 'A scanner sees only what it was promised' appears at 149 and 2272. Cadence versus concurrency appears at 1526-1533 and 1826-1912. Patience as 'two windows' appears at 2568-2573 and 2872-2874. Tips have one writer at 2605-2614 and 2637-2650. Discovery appears at 518-540 and 2770-2890. The 'pattern.retired_at' entry in Known gaps (1684-1717) is design, not a gap. The file is 3,018 lines and contradicts itself repeatedly (see DPR2-01, -02, -06, -14, -18).

**Evidence.** `grep -n '^#' docs/services/PROSPECTOR.md` and the duplicated passages at the cited lines.

**Fix.** Bounded step, which can be done with the content fixes: delete the second copy of each duplicated passage and leave a one-line pointer (2278-2287 to 164-175; 2272-2273 to 149; 2872-2874 to `open` at ~2568; fold 2605-2614 and 2637-2650 into one 'tips' subsection; 1526-1533 to 'On pace and parallelism'). Move the retired_at text out of Known gaps into the series-bounds section, keeping in Known gaps only the real gap (nothing infers a retirement date). The full split is the owner's decision. Proposed layout: (1) PROSPECTOR.md, ~300 lines: goal, lifecycle and states, the full private API on its own terms, complete configuration, and a storage summary with the table list. (2) PROSPECTOR-SERIES.md as the single home for pattern slots, slice/partition, instrument and series identity, first/last/tip, open(), generation bounds (probingLag, seeded skip), sighting rules, preamble, three-step reconciliation, absence confirmation and parts. (3) PROSPECTOR-TRANSPORT.md: Pace (5-refusal latch, refusesUs, ease-after), tickets and ramp, workers, HTTP/2 and HTTP/1.1, DNS cache, netgate, and a plain statement that instrument-API calls bypass all of it. '## Venues' would then keep only the registry, the adapter-as-server rule and the hook list.

**Tests.** None (docs only). After any split, check that every internal anchor link (including CATALOG-API.md's PROSPECTOR.md#the-api) still resolves.

**Verifier notes.** Verifier 1 confirmed the duplications and recommended DEFER: the split is an information-architecture decision and is best done after the content fixes. The bounded pointer and dedupe step can be implemented now.

**Owner question.** Do you want PROSPECTOR.md split into an overview plus PROSPECTOR-SERIES.md (data model and rules) and PROSPECTOR-TRANSPORT.md (pacing and transport), or kept as one file with the duplicates removed? If split, should the split happen in the same pass as the content fixes (DPR2-01..12) or right after them, so the same text is not edited twice?

## DPR2-14: Known gaps contradict the deletion and recreation of empty series

- **Severity:** low
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:1679-1682`
  - `docs/services/PROSPECTOR.md:1746-1749`
  - `docs/services/PROSPECTOR.md:1791-1804`
  - `docs/services/PROSPECTOR.md:2331-2336`
  - `services/prospector/src/catalog/series.ts:626-655`
  - `services/prospector/src/sync.ts:405`

**Problem.** The 1791-1804 gap says a series with last NULL 'stays in generation on every pass', but every finished pass deletes series with no non-absent file. 1681 says a never-answered seed series is deleted 'and nothing recreates it', but the next preamble recreates any symbol still listed on a live shape. 1746 describes the bad-spelling symptom as a persistently active series, when it is really a series that the preamble creates and reconciliation deletes on every pass.

**Evidence.** series.ts:651-655 `if (real.first === null) { remove(db, held, row); summary.removed++; continue; }`, with the comment 'If the symbol is still listed on a live shape, the next preamble creates the series again and backfills it'.

**Fix.** Rewrite the gap at 1791-1804 rather than deleting it, as '### A listed instrument that never publishes is asked about every pass': its series is deleted by each finished pass (no file) and created again by the next preamble from the covered floor, so the venue is asked about it for that window every pass until something publishes. Keep the rationale that closing on absence alone would be worse. In 1679-1682: '...is deleted by the reconciliation after the first completed pass, and recreated by the next preamble only while the venue lists the symbol on a live shape.' In 1746-1749: describe the symptom as the same series created by the preamble and removed by reconciliation on every pass, visible as steady preamble `created` and reconciliation `removed` counts for the venue, with no file ever recorded for them.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed, lowered the severity to low, and rejected the reviewer's suggestion to delete the gap outright: the per-pass cost of asking is a real operational fact.

## DPR2-15: PROSPECTOR_VENUES lists the wrong venues; .env.example omits bitget; compose.yml has an orphaned comment

- **Severity:** low
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:1813`
  - `services/prospector/src/venues.ts:35-37`
  - `services/prospector/src/venues.ts:71-89`
  - `services/prospector/src/config.ts:62-71`
  - `modules/collect/archives/.env.example:42`
  - `services/prospector/docker/compose.yml:48-51`

**Problem.** The row's 'all' default and the example 'binance,bybit,htx,kucoin' read like the complete list, and they leave out gate, okx and bitget. An empty value means every venue. .env.example:42 leaves out bitget. compose.yml:48-51 has a comment about an HTTP/1.1 connection ceiling with no variable under it.

**Evidence.** venues.ts:35-37 registry: binance, bybitPrimary, bybitSecondary, gate, htx, kucoin, okx, bitget; config.ts:66 throws on unknown names; adaptersFor([]) returns all.

**Fix.** PROSPECTOR.md:1813: set the default to 'empty (every registered venue)' and the description to 'comma-separated subset of binance, bitget, bybit, gate, htx, kucoin, okx (case-insensitive); an unknown name fails startup. It limits which venues this process will survey or resume; it starts nothing on its own.' Add bitget to the CSV list at .env.example:42. Delete the orphaned HTTP/1.1 comment at compose.yml:48-51.

**Tests.** None. Optionally run `docker compose -f services/prospector/docker/compose.yml config` to confirm the file still parses.

**Verifier notes.** Verifier 1 confirmed and lowered the severity to low.

## DPR2-16: The API and Reports sections explain the provider by its consumers and describe catalog/downloader internals

- **Severity:** low
- **Category:** docs-claude-md
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:1950-1954`
  - `docs/services/PROSPECTOR.md:2075-2077`
  - `docs/services/PROSPECTOR.md:2101-2103`
  - `docs/services/PROSPECTOR.md:2159`
  - `docs/services/CATALOG.md:17-34`
  - `docs/modules/CATALOG-API.md:297-310`

**Problem.** CLAUDE.md says a provider's doc explains its offering on its own terms. 1950-1953 explains the private API by its callers (the catalog settles reports, catalog-ui starts surveys), and its caller list is incomplete because lens writes also arrive here. 2075-2077 describes the catalog's key resolution and lens check, which CATALOG.md:26-31 already covers. 2101-2103 describes downloader behaviour and duplicates CATALOG-API.md:305.

**Evidence.** Quoted text at the cited lines; CATALOG.md:26-31.

**Fix.** 1950-1954 -> '**Private to the archives module.** Prospector publishes no API port: it is reachable only on the module's network. It starts, pauses and reports on surveys, settles reports of what became of listed files, and stores lenses. What exists is served by the catalog — see CATALOG-API.md.' 2075-2077 -> '**A file id is the file's rowid**, which is how this service names a file. The answer counts what was `recorded`, `withdrawn` and `corrected`, and `unknown` for ids that name no confirmed file.' 2101-2103 -> '**Settling is idempotent**: a file reported again is settled again to the same result, so a report may be repeated any number of times.' Leave the downloader and catalog flow to CATALOG.md.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed and lowered the severity to low: apart from the incomplete caller list, nothing is factually wrong; the cost is future drift.

## DPR2-17: Stale docblocks in services/prospector repeat or seed the doc's wrong facts

- **Severity:** low
- **Category:** docs-docblock
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/pace.ts:30-31`
  - `services/prospector/src/pace.ts:135-145`
  - `services/prospector/src/probe.ts:609-611`
  - `services/prospector/src/database/schema.ts:373-377`
  - `services/prospector/src/types.ts:714-717`
  - `services/prospector/src/types.ts:2122`
  - `services/prospector/src/dates.ts:140-152`
  - `services/prospector/src/adapters/okx/instruments.ts:14-16`
  - `services/prospector/src/adapters/okx.ts:19-27`
  - `services/prospector/src/catalog/series.ts:211-213`
  - `services/prospector/src/deliver.ts:207`

**Problem.** CLAUDE.md covers docblocks, and each of these is false today. pace.ts:31 'bybit... having earned its 30' (bybit declares 2000/5000). pace.ts:~143 'seven hosts surveyed today permit 360 requests in flight' (eight adapters, 3,600). probe.ts:610 'Three attempts' (CONFIRMATIONS 30/2). schema.ts:376-377 and types.ts:714-717/2122 list `{EPOCH_HH}`/`{EPOCH_MI}` as gate slots filled through slotsFor (only bybit.primary has slotsFor, and gate's epochs are parts). dates.ts 'three readers' and 'A walk has no use for it'. okx/instruments.ts:15 names a `span` table that does not exist. series.ts:212 names `pattern.state`, which does not exist (the column is retired_at). deliver.ts:207 names a `wired` symbol that does not exist. okx.ts:19 says ranges are 'brought up to date first', but symbolRanges is a pure read whose result `OkxContext.ranges` nobody reads.

**Evidence.** `grep -rn slotsFor adapters` finds only bybit.primary.ts:44; schema.ts has no span table and no pattern.state; probe.ts:623 CONFIRMATIONS; scanners/probed.ts reads only base, keyRoot and head from OkxContext.

**Fix.** Edit docblocks only. (1) pace.ts:30-31: drop the bybit-30 clause and keep the general rule. (2) pace.ts:~142-145: replace the 'seven hosts… 360… connect timeouts' clause with 'the per-venue limits sum to far more than one machine can open at once, so this ceiling is what bounds the total'. (3) probe.ts:609-611: refer to `CONFIRMATIONS` by the row's existence. (4) schema.ts:373-377: list only `{MONTH_LAST_DAY}` (bybit) as an adapter-filled slot, plus `{PART}` if it belongs there; drop gate from types.ts:714-717, and write 'the one that needs it' at types.ts:2122. (5) dates.ts:140-152: list every reader including walkEdge (see DPR2-11) and delete 'A walk has no use for it'. (6) okx/instruments.ts:14-16: drop the `span` sentence. (7) series.ts:211-213: `pattern.state` -> `pattern.retired_at`. (8) deliver.ts:207: delete the `wired` sentence or name the Tickets pool in pace.ts. (9) okx.ts:19: fix the docblock so it does not describe an update that never happens. Optional code cleanup: remove `ranges` from OkxContext (types.ts:339) and the symbolRanges call in okx.ts getContext.

**Tests.** Run `npx tsc --noEmit -p services/prospector` and the prospector test suite after any edit to types.ts or okx.ts (and after the optional OkxContext.ranges removal).

**Verifier notes.** Verifier 1 confirmed every item and added types.ts:714-717/2122, the dates.ts 'three readers' count and okx.ts:19. It also corrected the reviewer: symbolRanges has no side effects, so getContext runs an unused query.

## DPR2-18: The "empty series" section gives an outdated, contradictory reason for reading the file table

- **Severity:** low
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:2338-2341`
  - `docs/services/PROSPECTOR.md:2910-2913`
  - `services/prospector/src/catalog/series.ts:646-651`

**Problem.** 2338 says `first` 'is filled in by reconciliation's own third step', so reading the column would delete a series on the pass that measures its start. Today sawFile writes `first` as each file arrives, and reconciliation's step 3 only corrects it, so the stated reason contradicts 2910-2913. 2340-2341 ('That was invisible while this flagged rather than deleted') is history.

**Evidence.** series.ts:646-651 'The two agree now that a sighting writes the start... A catalog still carrying series from before that... would have them deleted wholesale'. reconcile step 3 does rewrite first/last (series.ts:678 `summary.corrected++`).

**Fix.** Delete 2338-2341 and leave a pointer to 'What a completed update pass is worth'. In that section, keep one present-tense statement: 'The delete asks the file table, not `first`: the file table is authoritative about whether a series holds anything, and the column is not trusted for a removal.' Keep the reason the file table is read, but drop the 'agree now... since they did' framing. Make the same wording change in the series.ts:646-651 docblock.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed, but its claim that reconcile 'never writes first' is wrong. I checked series.ts: step 3 corrects first/last (series.ts:678), as both F1 verifiers also found. The fix does not depend on that claim. Verifier 1 rightly rejected the reviewer's idea that edit-in-place migrations mean no legacy rows exist: migrations change schema and seeds, not data, so the safety rationale stays.

## DPR2-19: The `open` table leaves out the "never asked about → closed" case

- **Severity:** low
- **Category:** docs-completeness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:2549-2553`
  - `services/prospector/src/catalog/series.ts:247`
  - `services/prospector/src/catalog/series.ts:271-279`

**Problem.** The doc's table has three rows, but open() has a fourth branch: a series with a `last` and no tip is closed. The code's own docblock lists it.

**Evidence.** series.ts:276 `if (series.tip === null) return false;`; docblock row at series.ts:247.

**Fix.** Insert between 'nothing seen yet' and 'otherwise': '| **never asked about** | closed. A row with a `last` and no tip has been asked nothing, so there is no window to judge its silence in |'.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed. The case is transient, because floorTips gives a tip to any series with a start.

## DPR2-20: Venue measurements are duplicated in the service doc, and venue docs name prospector

- **Severity:** low
- **Category:** docs-claude-md
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:1507-1510`
  - `docs/services/PROSPECTOR.md:1573-1575`
  - `docs/services/PROSPECTOR.md:1751-1755`
  - `docs/venues/OKX.md:641-643`
  - `docs/venues/OKX.md:815-819`
  - `docs/venues/GATE.md:37-40`
  - `docs/venues/GATE.md:217`
  - `docs/venues/BITGET.md:33`
  - `docs/venues/BITGET.md:37-55`
  - `docs/venues/BITGET.md:61`
  - `docs/venues/BINANCE.md:34`
  - `docs/venues/BINANCE.md:315-316`
  - `docs/venues/BYBIT.md:155`
  - `docs/venues/BYBIT.md:278`

**Problem.** PROSPECTOR.md restates dated venue measurements whose home is the venue docs: the bucket ~1,700/s figures, the okx and bitget limits, and the 'okx's limit is known only from below' gap, which is a fact about okx. The inverse CLAUDE.md violation is wider: venue docs name or describe this service (BITGET.md:53 'Measured 2026-09-30 by prospector itself', BINANCE.md:34, BITGET.md:33 and :61, BYBIT.md:155 and :278, GATE.md:217, OKX.md:641-643), and BINANCE.md:315-316 describes this repo's retry behaviour.

**Evidence.** The cited lines. Adapter docblocks already point to the venue docs.

**Fix.** PROSPECTOR.md: keep the mechanism ('two venues behind one endpoint are two budgets; each adapter declares a cadence measured against its venue, see that venue's doc') and drop the figures at 1507-1510 and 1573-1575. Move the okx 'known only from below' fact into OKX.md's pacing table ('the threshold between 100/s clean and 200/s refused is unmeasured'), and remove the Known-gaps entry or reduce it to a pointer. In the venue docs, rewrite each prospector reference in venue terms (e.g. BITGET.md:53 'Measured 2026-09-30 from one client'). Delete BINANCE.md:315-316 or reduce it to the venue fact ('no throttling answer was observed').

**Tests.** None (docs only). Afterwards, `grep -rni prospector docs/venues` should return nothing.

**Verifier notes.** Verifier 1 confirmed and widened the list of venue-doc references beyond the reviewer's two.

## DPR2-21: "Reconcile" names two different mechanisms, and "slice" names both a table and the write queue

- **Severity:** low
- **Category:** docs-clarity
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:166`
  - `docs/services/PROSPECTOR.md:526`
  - `docs/services/PROSPECTOR.md:767-768`
  - `docs/services/PROSPECTOR.md:2140`
  - `docs/services/PROSPECTOR.md:2283`
  - `docs/services/PROSPECTOR.md:2343`
  - `docs/services/PROSPECTOR.md:2896`
  - `services/prospector/src/catalog/serial.ts:21`

**Problem.** 'Reconcile' is used both for the preamble's comparison against the listing (166, 526, 2283, 2343) and for the end-of-pass `reconcile()`. 'slice' names the serial write queue (2140, 767-768) and also the slice table described a few lines later.

**Evidence.** serial.ts:21 `export const slice = <T>(work: () => T): Promise<T>`; the slice table is in schema.ts.

**Fix.** Call the listing comparison 'the preamble' (or 'compares against the listing') at 166, 526, 2283 and 2343, and keep 'reconciliation' for `reconcile()` only, defined once where it is introduced (~2896). At 2140, write 'the serial write queue (`slice()` in `catalog/serial.ts`)', and at 767-768 write 'write batches'. Do not add these terms to docs/VOCABULARY.md, which may not hold service internals. Optional code change: rename serial.ts's `slice` (e.g. `serially`).

**Tests.** None for docs. If `slice` is renamed in code, run `npx tsc --noEmit -p services/prospector` and the test suite.

**Verifier notes.** Verifier 1 confirmed and corrected the reviewer: the doc has no 'opening vocabulary' section, and VOCABULARY.md may not hold service internals.

## DPR2-22: Carrying requests misstates the keep-alive setup and presents a guideline as a guarantee

- **Severity:** low
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:1602-1606`
  - `docs/services/PROSPECTOR.md:1814`
  - `services/prospector/src/deliver.ts:206-219`
  - `services/prospector/src/config.ts:35`

**Problem.** 'Idle connections are kept rather than destroyed — Node's default keeps 256 per host' implies the default does the keeping. The code replaces the default because it tears connections down. 'PROSPECTOR_CONCURRENCY stays below that figure' (~1,250) is presented as one of two safeguards, but nothing enforces it.

**Evidence.** deliver.ts:209-219 `new HttpsAgent({ keepAlive: true, maxFreeSockets: Infinity })`; config.ts:35 `parsePositiveInt(process.env.PROSPECTOR_CONCURRENCY, 200)`.

**Fix.** Replace the idle-connection sentence with: 'HTTP/1.1 HEADs go through agents that keep every idle connection (`maxFreeSockets: Infinity`). Node's default keeps only 256 per host, and a host with more lanes than that would close and reopen connections, each costing a TLS handshake.' At 1603, write '`PROSPECTOR_CONCURRENCY` must be set below that figure (nothing enforces it)', and add 'keep below ~1,250 over HTTP/1.1; not enforced' to the Configuration row at 1814.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed. Adding a clamp or warning in config.ts is the owner's call and is not part of this fix.

## DPR2-23: Parts: gate's behaviour is described incompletely

- **Severity:** low
- **Category:** docs-completeness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:2973-2974`
  - `services/prospector/src/adapters/gate.ts:66-78`
  - `services/prospector/src/adapters/gate.ts:204-220`

**Problem.** The doc says gate probes hour 00 and treats a missing first hour as a non-trading day. While `series.first` is NULL, though, gate asks for every part at once, and its parts also cover the snapshot trees' epoch stamps across a month.

**Evidence.** gate.ts:73 `if (series.first === null) return { parts: every };` gate.ts:75 `return { parts: every[0]!, next: THE_REST }`; partsOf returns epoch-second parts for snapshot trees.

**Fix.** Replace 2973-2974 with: 'gate names a period's parts from the period alone: a day's 24 hours, or a snapshot tree's epoch stamps across a month. For a series with no known start it asks about all of them at once, since its first day can begin mid-period. Otherwise it asks about the first part and, only if that is there, all the rest in one reply.' Keep the missing-first-hour claim only if GATE.md establishes it, and if so, put it there with at most a pointer here.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed.

## DPR2-24: The bybit/secondary `surveying()` rationale ignores existence-based confirmation

- **Severity:** low
- **Category:** docs-correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:2712-2726`
  - `docs/services/PROSPECTOR.md:2692-2695`
  - `services/prospector/src/probe.ts:623-630`
  - `services/prospector/src/adapters/bybit.secondary.ts:27-30`
  - `services/prospector/src/adapters/bybit.secondary.ts:83`

**Problem.** The doc argues that bybit's rule must ask which pass it is in, because on an update 'confirming it a hundred times spends a hundred requests'. The core already judges by the row's existence (assumed 2, confirmed 30), whatever pass is running. The rule's only effect is to raise walk-time 404 tolerance from 30 to 100. The caveat that inherited walk rows are 'judged as an update would' is misleading: they get the core's 30, and lose only bybit's extra tolerance.

**Evidence.** probe.ts:626-630 'The attempts this row's absence is worth, from the row rather than the pass'; bybit.secondary.ts:28 `status === 404 && surveying(bybitSecondary) === 'walk' && tries < INDEXED_TRIES ? 'keep' : null`.

**Fix.** Rewrite 2712-2726 as: 'A rule can ask which pass it is in, through `surveying(adapter)`. bybit/secondary uses it to keep a key its index named through up to 100 `404`s while a walk is running, more than the core's 30 for confirmed rows, because its CDN has bad minutes. Outside a walk it defers to the core.' Keep the paragraph on why the helper is ambient and per-venue. Replace the last sentence with: 'It does not follow a row: walked keys an update inherits from an undrained backlog get the core's 30 attempts, not bybit's 100.' Keep the CDN justification short and point to BYBIT.md if that doc covers it.

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed but rejected the reviewer's 'delete the caveat': the caveat should be corrected, because inherited rows do lose the 100.

## DPR2-25: The migration policy paragraph is contributor process duplicated in the migrations index docblock

- **Severity:** low
- **Category:** docs-claude-md
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/PROSPECTOR.md:2226-2231`
  - `services/prospector/src/database/migrations/index.ts:16-29`

**Problem.** 'No catalog is shared or deployed yet, so a change edits the migration it belongs to... until... from then on a migration that has shipped is frozen' is contributor policy with a future trigger, and migrations/index.ts:24-29 carries it almost word for word, so the subject has two homes. index.ts:16-19 also carries history ('that made the chain run on some databases and not others').

**Evidence.** The quoted text at both locations.

**Fix.** In PROSPECTOR.md:2226-2231, keep the present facts (one file per migration under `database/migrations/`, ordered by `index.ts`; each runs once in its own transaction with its `user_version` bump; the chain describes the catalog as it is) plus a one-line pointer to the index.ts docblock for the editing policy. Keep the policy, end condition included, only in index.ts:24-29. Rephrase index.ts:16-19 in the present tense ('every database runs every migration from zero, so the chain is the only path to a schema').

**Tests.** None (docs only). After editing, grep the doc for the removed phrases to confirm they are gone.

**Verifier notes.** Verifier 1 confirmed the duplication, but said calling it a plan is weaker than calling it policy; the index.ts docblock is its natural single home, and it does not need to move to docs/planning.

## Deferred — decisions needed

- **DPR2-13** (Structure: "## Venues" holds ~750 lines of the series model, and several subjects are explained two or three times in one file): Do you want PROSPECTOR.md split into an overview plus PROSPECTOR-SERIES.md (data model and rules) and PROSPECTOR-TRANSPORT.md (pacing and transport), or kept as one file with the duplicates removed? If split, should the split happen in the same pass as the content fixes (DPR2-01..12) or right after them, so the same text is not edited twice?

## Rejected

None. All 25 findings were confirmed by their verifiers. Parts of individual suggested fixes were rejected and corrected in place: DPR2-05/F5 rationale, DPR2-06/F11 replacement text, DPR2-10/F6 'cannot be reached', DPR2-12/F17 'tip moved only by reconciliation', DPR2-14/F14 'delete the gap', DPR2-18/F16 'no legacy rows', DPR2-24/F25 'delete the caveat'.
