# Review: prospector-walk

## Overall assessment

Prospector's walk machinery (survey/sync/update, pacing, transport, scanners, adapters) is carefully engineered, but it has three systemic weaknesses that both review lenses found independently.

1. Venue responses are trusted structurally. No listing reader checks that a 200 body really is a listing: no ListBucketResult/IsTruncated check, no index-shape check, no XML entity decoding, no URL encoding of prefix and marker, no forward-progress check on cursors, and no dot-segment check on index links. Withdrawal is the system's only negative statement, yet it rests on these unchecked pages (PRW-01, PRW-06, PRW-11). It also compares against the filtered catalogued rows rather than what was listed (PRW-05). Recommendation: one strict, shared listing reader. Pages are validated (a malformed page is a retryable fault), keys are decoded, queries are encoded, cursors must advance, and withdrawal takes the listed paths separately from the rows to write.

2. The three long-running loops have no common error and stop discipline. The sync loop dies silently on any throw outside tend() (PRW-03). Survey lanes are orphaned when a split fails (PRW-02). begin() waiters park indefinitely and later undo a pause or reset runs (PRW-04). Recommendation: a per-venue generation/abort token owned by begin(), checked by sweep, waitOut, refine and settle. Every loop catches, logs, backs off and continues, and every lane join uses allSettled.

3. The layers disagree about what a refusal means. pace tolerates 5 refusals in a row, but survey stops the pass on one and tend restarts with no wait (PRW-10). An exhausted 5xx is thrown as Refused and so skips sweep's page retry ladder (PRW-09). A 404 on a cached html directory fails its partition for ever (PRW-07). One exported classifier (`answered`/latched pace) should decide everywhere.

Documentation (the user's explicit concern): many in-scope docblocks contradict the code (PRW-13), narrate incidents and history against CLAUDE.md (PRW-14), are detached from their declarations (PRW-23), or name their consumers inside a provider (s3.ts header). compose.yml documents a non-existent setting and a wrong concurrency rule (PRW-22). Dead okx bound-measuring code and its tests describe behaviour that no longer exists (PRW-15). These are comment-only or deletion-only changes and should be done in one pass over sync.ts, pace.ts, survey.ts, index.ts and okx, to avoid conflicting edits. Behavioural fixes that change a docblock's subject (PRW-07, PRW-09, PRW-10, PRW-12) must update that docblock in the same change.

Testing: sync.ts's pass lifecycle (syncVenue/onePass/passing/tend) is about 50% uncovered, and five sync tests assert only their own arithmetic. The survey split/failure paths, the transport worker, the lookup failure paths and every scanner `confirm` are untested (PRW-16 to PRW-18). Several of the new tests belong with the fixes that define their behaviour.

Lower-priority items: ticket-pool shrink (PRW-19), the empty-scope edge at concurrency 1 (PRW-20), ETag/size normalisation drift and html.confirm recording a missing Content-Length as 0 (PRW-21), log counters (PRW-25), and two small efficiency wins (PRW-26, PRW-27). Three items need owner decisions: capping Retry-After/interruptible waits, the redirect and body-size policy, and the repo-wide /live bind mount.

Repro scripts from both reviews are under reviews/2026-11/units/scratch/ (walk/, v-walk-f2/, v2-walk-f2/, f4.mjs, v2f1/, cov-prospector-walk coverage). Many line numbers in the eqt lens were off (pages.ts has 148 lines, etag.ts 19, context.ts 85). The locations below use the corrected numbers where the verifiers gave them.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| PRW-01 | high | correctness | IMPLEMENT | A 200 response that is not a listing is read as a complete final page, which closes the partition and withdraws every catalogued file in its range |
| PRW-02 | high | correctness | IMPLEMENT | A failed split rejects surveyVenue while its other lanes keep walking, so the retry walks the same partitions twice |
| PRW-03 | high | robustness | IMPLEMENT | Any throw outside tend() ends the venue's sync loop silently until the process restarts |
| PRW-04 | high | correctness | IMPLEMENT | begin() race: a pause sent during a refresh or forced update is undone, and a duplicate request stays parked, later lifts a pause and resets runs |
| PRW-05 | medium | correctness | IMPLEMENT | Walk withdrawal compares against catalogued rows, not listed keys, so excluded or unplaceable files the venue still serves are withdrawn |
| PRW-06 | medium | correctness | IMPLEMENT | S3 keys and markers are not XML-unescaped or URL-encoded, and nothing checks that a cursor advances, so special characters corrupt keys, misdirect listings, cause wrong withdrawals or loop forever |
| PRW-07 | medium | robustness | IMPLEMENT | HTML scanner: a directory that now 404s fails its partition on every pass, because the process-wide `known` cache keeps stale children |
| PRW-08 | medium | correctness | IMPLEMENT | Instrument fetchers accept in-body API errors and truncated pagination as complete listings, so preamble wrongly delists bybit and htx instruments |
| PRW-09 | medium | robustness | IMPLEMENT | A 5xx or 429 that uses up fetchPage's attempts is thrown as Refused, which skips sweep's 12-attempt page retry |
| PRW-10 | medium | correctness | IMPLEMENT | One refusal that looks like a block stops the whole pass, and tend restarts at once with no wait, contradicting pace's five-in-a-row rule |
| PRW-11 | medium | security | IMPLEMENT | HTML index links with dot segments ('./', 'x/../', '%2e%2e'), '?' or '#' are followed, so the walk can recurse forever, duplicate catalog keys, or leave its scope |
| PRW-12 | medium | robustness | IMPLEMENT | A transport worker that dies is respawned in a hot loop with no backoff, and the dev script always triggers it |
| PRW-13 | medium | docs | IMPLEMENT | Docblocks that contradict the code they describe (reconcile, pace keying, bybit's '30', cadence, 'fifteen minutes', the s3 consumer list, okx ranges) |
| PRW-14 | medium | docs | IMPLEMENT | Docblocks narrate history, incidents and plans, contrary to CLAUDE.md |
| PRW-15 | medium | code-quality | IMPLEMENT | Dead production code kept alive only by tests or by unused writes (the okx bound-measuring subsystem, OkxContext.ranges, sync sleep chunking, unused _test_ exports) |
| PRW-16 | medium | testing | IMPLEMENT | sync.ts's pass lifecycle (syncVenue/onePass/passing/tend/inPass/waiting) is untested, and four or five sync tests check only their own arithmetic |
| PRW-17 | medium | testing | IMPLEMENT | The survey's split and failure paths, and hostile listing inputs, have no tests |
| PRW-18 | medium | testing | IMPLEMENT | Transport worker path, lookup failure paths and every scanner `confirm` are untested |
| PRW-19 | low | correctness | IMPLEMENT | Tickets.give() ignores a lowered limit, so a shrink (reopenGradually) never takes effect while lanes are queued |
| PRW-20 | low | robustness | IMPLEMENT | With one lane (PROSPECTOR_CONCURRENCY=1), descend returns the key root as the only partition and beginJob throws 'A partition cannot be the empty scope' every 30 s |
| PRW-21 | low | correctness | IMPLEMENT | ETag and size are normalised differently on each path: probed.confirm bypasses etagOf, and html.confirm records a missing Content-Length as size 0 |
| PRW-22 | low | config | IMPLEMENT | compose.yml documents a non-existent connection-ceiling setting and a wrong concurrency rule, and a bad schedule exits 0 under restart: unless-stopped, contrary to its comment |
| PRW-23 | low | docs | IMPLEMENT | Docblocks detached from their declarations or stacked, so the wrong text documents a symbol |
| PRW-24 | low | code-quality | IMPLEMENT | Pacing.giveUpAfter doubles as the fault-log cadence, and Pacing.concurrency is documented as a queue bound |
| PRW-25 | low | code-quality | IMPLEMENT | Progress and heartbeat counters miscount split partitions, and a blocked pass reports skipped partitions as 'openWithoutAFailure' |
| PRW-26 | low | efficiency | IMPLEMENT | held() prepares a new SQLite statement for every part key during generation |
| PRW-27 | low | efficiency | IMPLEMENT | Pace.trim splices the send-time array on every request and since() scans linearly; rulesFor is recomputed on every page attempt |
| PRW-28 | low | robustness | DEFER | Retry-After is uncapped and a pause cannot interrupt it, and refine's wait for the victim partition is not bounded by SPLIT_MS |
| PRW-29 | low | security | DEFER | Listing GETs follow redirects to any host or scheme and read bodies of any size into memory |
| PRW-30 | low | config | DEFER | Every service's compose mounts the whole repository read-write at /live, including in prod |

## PRW-01: A 200 response that is not a listing is read as a complete final page, which closes the partition and withdraws every catalogued file in its range

- **Severity:** high
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/scanners/pages.ts:19-58 (s3Page)`
  - `services/prospector/src/scanners/pages.ts:94-118 (indexPage)`
  - `services/prospector/src/scanners/s3.ts:35-40`
  - `services/prospector/src/scanners/s3.ts:51-57 (confirm)`
  - `services/prospector/src/scanners/s3.ts:170-172`
  - `services/prospector/src/scanners/html.ts:50-64`
  - `services/prospector/src/scanners/html.ts:182`
  - `services/prospector/src/deliver.ts:78-88`
  - `services/prospector/src/http.ts:100`
  - `services/prospector/src/survey.ts:684-687 (spanOf)`
  - `services/prospector/src/survey.ts:933`
  - `services/prospector/src/survey.ts:1023`
  - `services/prospector/src/catalog/queries.ts:313-348`
  - `services/prospector/src/reports.ts:98,203-214`

**Problem.** s3Page never checks for a <ListBucketResult> root or an <IsTruncated> element. Any 200 body (an HTML maintenance or CDN page, an empty body, an XML <Error> served with 200, or a truncated page with no entries and no marker) parses as {listed:[], prefixes:[], next:null}. s3.page reports covers {after: cursor, through: null}. spanOf maps that to the scope's ceiling (EVERYTHING at the root), and putFiles withdraws every catalogued row in the span (existence='absent', a 'withdrawn' log entry with cause walk, and dropParked purges the backlog). closeRun then marks the partition walked. indexPage behaves the same way: a page with no double-quoted relative hrefs yields {children:[], keys:[]}, and vacated() withdraws the whole directory and every subtree. The empty children are also cached in `known`. s3.confirm returns 'absent' for any non-listing reply, and settleReport then calls withdrawFile. The repo itself records that KuCoin (s3.ts:170-172) and the bybit CDN (docs/venues/BYBIT.md) serve HTML on listing endpoints. Rows come back on a later good walk, but until then the catalog states false withdrawals and the partition reads as established.

**Evidence.** Reproduced by three verifiers against dist/src/scanners/pages.js. An HTML body, '', <Error><Code>SlowDown</Code></Error>, and <ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult> all give {"listed":[],"prefixes":[],"next":null}. A scratch vitest (scratch/f3) seeded 3 files and ran s3.page on an HTML body followed by putFiles, which logged 'Files withdrawn from the catalog' files:3 cause:walk. catalog.test.ts:325 'withdraws everything an empty page covered' asserts the withdrawal on purpose (a genuine empty listing must still withdraw).

**Fix.**

1. In pages.ts s3Page, require /<ListBucketResult[\s>]/ and <IsTruncated>(true|false)</IsTruncated>. Also treat `truncated && (declared ?? last) === null` as malformed.
2. In indexPage, require an index shape before accepting a page with zero entries. Accept the page if it has at least one in-directory link. Otherwise accept it only if it has a parent link (href="../") or an 'Index of' title/h1 matching bybit's server. Validate the marker against a real quote-saver page first, because a genuinely empty directory has only a parent link. Widen the href regex to single-quoted and unquoted values: /<a\s[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi.
3. Where the error is raised (verifier conflict, resolved): do NOT throw inside readPage. readPage runs in the transport worker, and a throw there comes back through http.ts send()'s catch into pace.faulted(), which counts it and logs it as 'Requests not reaching the venue' (checked: http.ts:241-246, pace.ts:549-556). Instead, have readPage return a `malformed: string` marker on the page union (a short reason plus the first ~200 chars). Then fetchPage (http.ts:100), when res.ok and the page is malformed, throws a new non-Refused `MalformedListing` error (url, content-type, snippet). fetchPage's own loop and sweep's PAGE_ATTEMPTS loop retry it. The cursor is kept, putFiles never sees a span, closeRun is not reached, and the partition fails open if retries run out.
4. s3.confirm: with (3), an unreadable reply throws, and reports.ts:203-208 already maps a throw to UNKNOWN. Optionally also return the echoed top-level <Prefix> and answer null unless it equals keyRoot + path.
5. Update the s3/survey/deliver/counts test fixtures that send bare <IsTruncated> fragments without <ListBucketResult>.
Optional: deliver.get records the content-type, and fetchPage refuses text/html for format 's3'. The structural check is the real guard.

**Tests to add.** readPage s3 marks malformed for: an HTML body, '', an XML <Error>, and IsTruncated true with no entries or marker. A genuine empty <ListBucketResult>…<IsTruncated>false</IsTruncated></ListBucketResult> still parses to an empty final page, and catalog.test.ts:325 still passes. html: '<html>Error</html>' is malformed; an empty index with '../' is an empty directory; single-quoted and unquoted hrefs are read. A survey-level test with the fake-venue harness: seed catalogued files, serve one 200 HTML page mid-walk and then the real listing. Assert no 'withdrawn' events, existence unchanged, backlog rows intact, and the run closed only after the real listing. reports: s3.confirm against a non-listing 200 does not call withdrawFile.

**Verifier notes.** Both lenses (cs F3, eqt F1), confirmed by all four verifiers at high. Consolidation decision: return-a-marker-and-throw-in-fetchPage, following eqt verifier 1, rather than throwing in readPage (cs verifiers, eqt verifier 2), because of the pace.faulted misreporting checked above.

## PRW-02: A failed split rejects surveyVenue while its other lanes keep walking, so the retry walks the same partitions twice

- **Severity:** high
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/survey.ts:298-300`
  - `services/prospector/src/survey.ts:333-361 (refine)`
  - `services/prospector/src/survey.ts:415-440 (topUp)`
  - `services/prospector/src/survey.ts:440-461 (lane)`
  - `services/prospector/src/survey.ts:527`
  - `services/prospector/src/sync.ts:553`
  - `services/prospector/src/sync.ts:610-617`
  - `services/prospector/src/catalog/queries.ts:1026-1036 (advanceRun)`

**Problem.** In topUp, only the lane that starts refine() catches its rejection (430-438). Lanes that find `refining` set do a bare `await refining; continue;` (422-426). refine() rethrows after giveBack() whenever scanner.level() fails (357-361): retries exhausted, a Refused, or a vanished html directory. The lane whose partition was just stopped always takes the waiter branch, so any level failure rejects it whenever there are 2 or more lanes. Promise.all at 527 then rejects, the heartbeat is cleared and end-of-pass bookkeeping is skipped, but the other lanes are never stopped. They keep sweeping, committing cursors, and taking the given-back partition. tend() catches, waits FLOOR_MS (30 s) and calls surveyVenue again. openPartitions hands the same open runs to a second set of lanes. Requests double against the venue, and advanceRun has no monotonicity guard, so cursors from two walkers overwrite each other. refine can also split a run an orphan is still walking. The starter lane also returns false permanently, so the pass loses a lane, and the failed scope is not added to `terminal`.

**Evidence.** Reproduced three times. scratch walk/refine.test.ts: surveyVenue rejected with 'level read failed' and 67 pages were walked after it returned. walk/t/refine-throw.test.ts: after the rejection stillOpen ['fat/','slow/'] and the next pass gave maxConcurrentSameScope 2. v2-walk-f2/orphan.test.ts: 27 page calls in the 600 ms after the rejection, and both partitions were closed by the orphans.

**Fix.**

1. Make refine() never reject. When the level read fails, call giveBack(), terminal.add(at.scope), and log {...fault(err), venue, scope} as 'Could not split a partition; continuing without splitting'. If the error is a Refused that latches the pace (see PRW-10), set summary.blocked. Then return, as the timeout path at 346-353 does.
2. Defence in depth in topUp: start the refinement once as `refining = refine().catch(log).finally(() => { refining = null; })`, and have both the starter and the waiters `await refining; continue;`. The queue check comes before the terminal check, so the given-back partition is taken.
3. Make the lane join fail-safe. Use `const results = await Promise.allSettled(lanes)`. On the first lane rejection, set a shared `aborting` flag that the stop callback passed to sweep returns as a reason, and set stopping=true on every runner in `running`. Rethrow the first rejection only after every lane and every runner.finished has settled. surveyVenue can then never return or throw while a lane is still sweeping.

**Tests to add.** survey test (rescope harness): 3 lanes, scopes ['a/','b/'], level() rejects after a short delay while two lanes are idle. Assert that surveyVenue resolves, that the given-back partition is walked to completion exactly once, that the failed scope is not split again in the same pass, and that no scanner.page call happens after surveyVenue settles (set a flag after the await). Second case: level() throws a blocking Refused with the pace latched, and summary.blocked is true. Third case: a lane throws for another reason, and surveyVenue rejects only after every runner has finished.

**Verifier notes.** Both lenses (cs F1, eqt F2), confirmed by all four verifiers at high.

## PRW-03: Any throw outside tend() ends the venue's sync loop silently until the process restarts

- **Severity:** high
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/sync.ts:78-91 (syncVenue)`
  - `services/prospector/src/sync.ts:243-247`
  - `services/prospector/src/sync.ts:306-314`
  - `services/prospector/src/sync.ts:405-415`
  - `services/prospector/src/index.ts:360-361`
  - `services/prospector/src/index.ts:429-436`
  - `services/prospector/src/metadata.ts:97-103`
  - `services/prospector/src/preamble.ts:56`

**Problem.** syncVenue runs `await onePass(...)` inside try/finally with no catch. preamble() (adapter.instruments → fetchJson, plus backfill probes), reconcile(), clearUpdate(), closeWalk() and updateStarted() all run outside tend's try/catch. fetchJson throws on the first non-429 error status. A rejection ends the for(;;). begin() passes the promise to `void Promise.allSettled(done).finally(...)`, which discards it without logging and removes the venue from `walking`. The venue stays enrolled and unpaused, but nothing surveys it until a restart (resume()) or a new request. For multi-host venues (bybit), one dead host loop leaves `walking` set by the other, so begin() returns early for non-interrupting requests and the dead host is never revived.

**Evidence.** Two independent repros. scratch walk/sync.test.ts and v-walk-f2/f2.test.ts (fetch stubbed to 503): syncVenue rejected after one call, {"outcome":"rejected: … 503 …","calls":1,"inPass":false}. index.ts has no watchdog, and resume() runs only at startup (index.ts:199).

**Fix.**

1. In syncVenue, catch around onePass. Log {...fault(err), venue: labelOf(adapter)} as 'Pass failed; retrying', then `await waiting(backoff, paused); if (paused()) return; continue;`. Use a bounded exponential backoff starting at FLOOR_MS (or 60 s), doubling, capped at about 15 min to 1 h, and reset after a pass that completes. A failed preamble is redone because updateStarted() is still null.
2. In begin() (index.ts:433), log each rejected result before the cleanup: `.then(rs => rs.forEach(r => r.status === 'rejected' && logger.error({...fault(r.reason), venue}, 'Survey loop ended')))`.
3. Optional and separable: fetchJson retries 5xx and network errors with its 429 backoff, and fails fast on other 4xx.

**Tests to add.** sync test: an adapter whose instruments() throws once and then succeeds, with fake timers. syncVenue does not reject, instruments is called a second time after the wait, and an error is logged. A pause during the retry wait makes syncVenue resolve. A unit test that fetchJson retries a 503 (if option 3 is taken).

**Verifier notes.** cs F2 only. Both verifiers confirmed it at high and reproduced it independently. The multi-host aggravation comes from the second verifier.

## PRW-04: begin() race: a pause sent during a refresh or forced update is undone, and a duplicate request stays parked, later lifts a pause and resets runs

- **Severity:** high
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/index.ts:261-269`
  - `services/prospector/src/index.ts:346-374`
  - `services/prospector/src/index.ts:381-401`
  - `services/prospector/src/index.ts:446-448 (until)`
  - `services/prospector/src/index.ts:460-479 (pause)`
  - `services/prospector/src/catalog/queries.ts:1150-1157`
  - `services/prospector/src/catalog/queries.ts:1416-1419 (resetRuns)`
  - `services/prospector/src/collector.ts:127-133`

**Problem.** For an interrupting request (refresh, or occasion 'partial'), begin() calls halt() and then polls `until(() => !walking.has(venue))` every 250 ms with no limit. Afterwards it runs halting.delete, enrol, resumeSurvey and, for a refresh, resetRuns, with no check of whether anything changed in between. (a) A pause sent during the wait writes paused_at and returns true, and then begin wakes, clears the pause and restarts the loop. (b) With two interrupting requests, the first waiter runs synchronously from the wake to walking.add (all DatabaseSync calls), so the second always sees the venue walking again and stays parked for the life of the new loop, which never ends on its own. Its request (already acknowledged by `void begin`) quietly does nothing. When an operator later pauses, the stale waiter wakes, lifts the pause and, for a refresh, runs `DELETE FROM run WHERE venue_id = ?`, throwing away days of walk progress.

**Evidence.** Simulation scratch/f4.mjs (begin/halt/pause/until copied, DB stubbed): 'pause recorded during refresh wait, paused_at set=true' -> 'begin#11 Pause lifted' -> walking=true paused_at=null. Duplicate case: 'begin#1 resetRuns dropped=100', then after a later pause 'begin#2 Pause lifted', 'begin#2 resetRuns dropped=500'.

**Fix.**

In index.ts keep `const generation = new Map<string, number>()`. As its first statement, begin() takes `const ticket = (generation.get(venue) ?? 0) + 1; generation.set(venue, ticket); const asked = new Date().toISOString();`. pause() also bumps the generation. Change until to `until(met, alive)`, which returns false as soon as alive() is false, and pass `() => generation.get(venue) === ticket`. After the wait, if it returned false or the generation moved, log 'Superseded by a later request; not starting' and return. As a belt-and-braces check, also return if enrolled(db, venue).pausedAt > asked. All of these checks come before halting.delete, enrol, resumeSurvey and resetRuns. Latest request wins: with two refreshes only the later runs, and with a refresh followed by a pause nothing restarts.

**Tests to add.** vitest against a temp catalog and a stub adapter whose pass blocks until released. (1) Two refreshes back to back, release the loop: resetRuns ran once and no begin is still pending. A later pause plus release: paused_at stays set, running(venue) is false, and run rows are intact. (2) A refresh, then pause() before the old loop stops, then release: the venue stays paused and runs are not reset. (3) The same as (2) with occasion 'partial'.

**Verifier notes.** Both lenses (cs F4 high, eqt F6 medium). Three of four verifiers rate it high, and the second verifier reproduced resetRuns discarding progress, so high is kept.

## PRW-05: Walk withdrawal compares against catalogued rows, not listed keys, so excluded or unplaceable files the venue still serves are withdrawn

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/survey.ts:884`
  - `services/prospector/src/survey.ts:933`
  - `services/prospector/src/survey.ts:1090-1176 (catalogued)`
  - `services/prospector/src/catalog/queries.ts:129`
  - `services/prospector/src/catalog/queries.ts:313-345`
  - `services/prospector/src/catalog/queries.ts:1718 (vacated)`
  - `services/prospector/src/scanners/html.ts (accepted() filter on children)`

**Problem.** sweep passes putFiles the output of catalogued(), which drops excluded keys, keys refused by adapter.accepts, excludedAnywhere matches, undated keys and keys whose series resolves to null. putFiles uses `offered = new Set(files.map(f => f.path))` for range withdrawal, vacated() and dropParked. So a previously catalogued file that the venue still lists is marked absent and logged as `withdrawn, cause: walk` whenever an exclusion, an accepts or inspectUrl regex, or walkSeries placement changes. The html scanner likewise filters children by accepted() before vacated uses them, so a refused subtree is withdrawn. This contradicts docs/services/PROSPECTOR.md:761 ('a catalogued file … that the page did not list'), and a file that becomes unplaceable should go to `unreadable` instead.

**Evidence.** survey.ts:933 `withdrawn += await putFiles(db, files, page.covers && spanOf(...))` with files = catalogued(...) (884). queries.ts:129 offered, 322 `if (offered.has(path)) continue;` → withdraw.

**Fix.**

Change the signature to `putFiles(db, files, span, listed: ReadonlySet<string>)`. survey.ts builds listed from `page.listed.map(e => relative(adapter, e.key))` before any filtering, and putFiles uses it as `offered` for range withdrawal, vacated() and dropParked. For the html directory span, carry the unfiltered children (before accepted()) in covers. Excluded rows are not touched by walk withdrawal (see the owner note).

**Tests to add.** A catalogued file whose inspectUrl now returns {of:'unknown'} stays present after a re-walk and appears in unreadable. A catalogued file then added to exclusions is not logged as withdrawn/walk. A refused html subtree is not vacated.

**Verifier notes.** cs F5, confirmed at medium. Minor owner choice, which does not block: should excluded rows leave the catalog through an explicit transition with cause 'excluded', or simply be left alone by walks? The default is to leave them alone.

## PRW-06: S3 keys and markers are not XML-unescaped or URL-encoded, and nothing checks that a cursor advances, so special characters corrupt keys, misdirect listings, cause wrong withdrawals or loop forever

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/scanners/pages.ts:39-44`
  - `services/prospector/src/scanners/pages.ts:69-73 (tag)`
  - `services/prospector/src/scanners/s3.ts:107-117 (level)`
  - `services/prospector/src/scanners/s3.ts:140-158 (initials)`
  - `services/prospector/src/scanners/s3.ts:160-175 (listingUrl)`
  - `services/prospector/src/scanners/html.ts:73-74`
  - `services/prospector/src/scanners/html.ts:193-194 (directoryUrl)`
  - `services/prospector/src/survey.ts:845-1021 (sweep loop)`

**Problem.** tag(), the CommonPrefixes capture and NextMarker never decode XML entities, so a key `a&b…` is catalogued as `a&amp;b…`. listingUrl interpolates prefix and marker raw (deliberately, to keep KuCoin's slashes unencoded): '&' splits the parameter, '#' starts a fragment, '+' becomes a space, and %XX is decoded. A marker cut at '&' sorts before the page just read, so the same page comes back. sweep's do/while and level's loop have no advance check (only initials has one), so the partition re-lists without end. initials() builds partitions from such characters, which then query the wrong keyspace while their span claims the right range. s3.confirm on such a key returns 'absent', which leads to withdrawFile. html builds URLs from decoded names without re-encoding them.

**Evidence.** readPage s3 with <Key>a/b&amp;c-2024-01-01.zip</Key> yields that literal key and next. _test_listingUrl('https://h','a/b+c#d&e',null,false) gives 'https://h/?prefix=a/b+c#d&e&max-keys=1000'. scratch walk/url.cjs: marker spot/A&B/x.zip reaches S3 as spot/A plus a stray parameter.

**Fix.**

1. In pages.ts, add `unxml` (amp, lt, gt, quot, apos, &#N;, &#xN;) and apply it in tag(), each CommonPrefixes capture and NextMarker, before flat(). etagOf already strips &quot; and is unaffected.
2. In listingUrl, encode only the characters that break a raw query, `s.replace(/[%&#+ ]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2,'0'))`, applied to prefix and marker. '/' and every other character stay as today, so KuCoin's behaviour is unchanged. Do not use encodeURIComponent with only %2F restored: it would newly encode ':', '=', ',', ';', '$', '@', and KuCoin's sensitivity to that cannot be checked offline. Comment why the set is minimal.
3. Advance guard inside the s3 scanner (not generic sweep): in s3.page, `if (cursor !== null && page.next !== null && page.next <= cursor) throw new Error('listing marker did not advance: …')`. This is a non-Refused error, so it is retried and then fails open. Apply the same check in level's loop.
4. In html.ts directoryUrl and confirm, encode each path segment with encodeURIComponent and join with '/'.

**Tests to add.** S3 keys containing &amp;, +, #, %20 and a non-ASCII character round-trip as the literal key. listingUrl keeps '/' raw and escapes '&#+% '. The existing KuCoin listingUrl output is unchanged for plain keys. s3.page throws when NextMarker equals the incoming cursor. level terminates on a repeated NextMarker. html directoryUrl encodes a segment containing '#'.

**Verifier notes.** Both lenses (cs F7, eqt F3), confirmed at medium. Both verifiers independently preferred the minimal encoder over encodeURIComponent. Low probability with today's alphanumeric symbols (Gate's non-ASCII is encoded by fetch), but the effect is unbounded.

## PRW-07: HTML scanner: a directory that now 404s fails its partition on every pass, because the process-wide `known` cache keeps stale children

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/scanners/html.ts:55`
  - `services/prospector/src/scanners/html.ts:96-99`
  - `services/prospector/src/scanners/html.ts:105`
  - `services/prospector/src/scanners/html.ts:146-147`
  - `services/prospector/src/scanners/html.ts:156-185`
  - `services/prospector/src/scanners/pages.ts:126-130 (isDirectory and comment)`
  - `services/prospector/src/http.ts:102`
  - `services/prospector/src/http.ts:190-191`
  - `services/prospector/src/survey.ts:961`
  - `services/prospector/src/sync.ts:486-499`

**Problem.** `known` is a module-level Map that is never cleared. next() answers children(dir) from it for any directory read earlier in the process, for example before a pause or a failed pass. If such a directory now answers 404, fetchPage throws Refused(404) at once and sweep rethrows. The partition fails, tend retries every 30 s, and next() returns the same stale child again, so the venue never reaches its drain or reconcile until a restart. A worse variant survives a restart: an extensionless file misread as a directory is requested as `FILE/`, 404s, and the parent keeps listing it. Two comments are false today: html.ts:96-99 ('nothing is answered from a cache this job did not fill') and sync.ts:489-493 ('a prefix that no longer exists answers with an empty listing'). pages.ts:126-127 also says a misread file 'costs one wasted request', when in fact it fails the partition.

**Evidence.** html.ts:105 `const known = new Map<string, string[]>();`, written only at :182 and cleared only in tests (html.test.ts:53). survey.ts:961 rethrows any Refused. A resume does not re-map (survey.ts:140 `open ?? partition(...)`).

**Fix.**

1. In html read(), catch Refused with status 404 for a prefix other than the scope root. Set `known.set(remembered(context, prefix), [])` and return {children:[], keys:[], gone:true}.
2. In html.page, when read(at) reports gone, return {listed: [], cursor: next sibling or null} with NO covers, so withdrawal waits for the parent's next real read and a transient CDN 404 never withdraws a subtree. Log a warning naming the directory.
3. Scope the cache to a job: export forget(context), which deletes the keys prefixed `${context.name}:`, and call it when a job starts or resumes (scopes(), or the first page of a scope with a null cursor).
4. Make the comments at html.ts:96-99, sync.ts:489-493 and pages.ts:126-127 state today's behaviour, in present tense.

**Tests to add.** html.test.ts: (a) a fake context whose page() throws new Refused(404, new Headers(), url) for one child directory: page() skips it, the cursor moves to the next sibling, and no covers is emitted for it. (b) A parent is read, the child removed, then page() resumes with a cursor: no throw. (c) After forget(), children are re-read.

**Verifier notes.** cs F8, confirmed at medium. The secondary claim (directories added under an already-visited parent are skipped on resume) is rejected: it matches the documented 'present at the start' guarantee (survey.ts:159-162).

## PRW-08: Instrument fetchers accept in-body API errors and truncated pagination as complete listings, so preamble wrongly delists bybit and htx instruments

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/adapters/bybit/instruments.ts:18-25`
  - `services/prospector/src/adapters/bybit/instruments.ts:61-68`
  - `services/prospector/src/adapters/bybit/instruments.ts:200-230`
  - `services/prospector/src/adapters/htx/instruments.ts:39-53`
  - `services/prospector/src/adapters/htx/instruments.ts:155-169`
  - `services/prospector/src/adapters/kucoin/instruments.ts:194-205`
  - `services/prospector/src/metadata.ts (fetchJson refused predicate)`
  - `services/prospector/src/preamble.ts:194-224`
  - `services/prospector/src/preamble.ts:418-431 (agrees)`

**Problem.** fetchJson rejects a 200 body only when given a `refused` predicate, and only okx passes one. bybit (retCode != 0), htx (status 'error') and kucoin (code != '200000') error bodies read as empty lists. preamble guards delisting only by *market* mentioned. bybit linear and inverse, and htx coin and linear swap, all map to 'perp', so if one endpoint errors while the other answers, every instrument from the failed endpoint becomes 'delisted'. agrees() is satisfied by the surviving endpoint. bybit options are worse: an underlying whose call errors is pushed with live:false, so 'option' is mentioned and that underlying is delisted outright. bybit's PAGES=12 cap truncates silently. kucoin is not affected for delisting (one market per endpoint), but should be consistent.

**Evidence.** bybit/instruments.ts `for (const one of body.result?.list ?? [])`, `const PAGES = 12;`. preamble.ts:194 `const spoke = new Set(listed.map(one => one.market.toLowerCase()));`, then :220 'active' : 'delisted'.

**Fix.**

(1) bybit: `fetchJson<Answer>(url, 'bybit', b => b.retCode !== 0)` (add retCode?: number to Answer). Throw if result.list is not an array. Throw 'bybit instruments: cursor not exhausted' if the PAGES loop ends with a cursor. (2) htx: spot v2 `b => b.code !== 200`, hbdm `b => b.status !== 'ok'`. Throw when data is not an array. (3) kucoin: `b => b.code !== '200000'`, and throw on non-array data. A throw propagates out of preamble exactly as a non-200 does today, and with PRW-03 the loop retries it. (4) Deferred hardening (needs series to record their source): an Instrument.source/category field, so preamble delists only within categories that answered in full.

**Tests to add.** bybit: stub fetch so the inverse call returns {retCode:10006,retMsg:'Too many visits',result:{}}. bybitInstruments rejects after retries (fake sleep), and preamble leaves inverse series 'active'. The PAGES cap reached with a cursor throws. htx: {status:'error',err_code:1032} on LINEAR_SWAP rejects. kucoin: a code '400100' body rejects.

**Verifier notes.** cs F13, confirmed at medium. The kucoin delisting part was refuted (separate endpoints per market); the option-underlying aggravation was added by the verifier.

## PRW-09: A 5xx or 429 that uses up fetchPage's attempts is thrown as Refused, which skips sweep's 12-attempt page retry

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/http.ts:100-125`
  - `services/prospector/src/http.ts:190-191 (answered)`
  - `services/prospector/src/survey.ts:862-873`
  - `services/prospector/src/survey.ts:961`

**Problem.** For a status that is not `answered` (5xx, or a 429 that is not a block), fetchPage stores `last = new Refused(...)` and throws it after 5 attempts (about 7.5 s). sweep rethrows any `instanceof Refused` immediately ('a refusal is an answer'), so S3 SlowDown or a short 5xx outage fails the partition after about 8 s. Transport errors meanwhile get 12 page attempts (about 7 minutes). No data is lost (the cursor is kept), but the partition is deferred to a later pass and the pass reports incomplete.

**Evidence.** http.ts:104 `last = new Refused(res.status, res.headers, url);` … :125 `throw last instanceof Error ? last : …`. survey.ts:961 `if (err instanceof Refused || attempt >= PAGE_ATTEMPTS) throw err;`.

**Fix.**

Export the classifier from http.ts (`export { answered }`, or `isAnswer`). In survey.ts:961: `if ((err instanceof Refused && answered(adapter, err.status, err.headers)) || attempt >= PAGE_ATTEMPTS) throw err;`. walkOne's blocked check is unchanged. Rewrite the sweep docblock (862-873): a final refusal (see `answered`) is never repeated, and an exhausted retryable status is retried like a transport error.

**Tests to add.** retry.test.ts: a scanner whose page throws new Refused(503, new Headers({'x-amz-error-code':'SlowDown'}), url) twice and then succeeds completes the partition with two waits and summary.failed 0. The existing 404 test still shows a single ask.

**Verifier notes.** Both lenses (cs F9 medium, eqt F18 low). Kept at medium: S3 SlowDown at these request rates is realistic.

## PRW-10: One refusal that looks like a block stops the whole pass, and tend restarts at once with no wait, contradicting pace's five-in-a-row rule

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/survey.ts:141-152`
  - `services/prospector/src/survey.ts:231-234`
  - `services/prospector/src/sync.ts:567-576`
  - `services/prospector/src/sync.ts:157-165`
  - `services/prospector/src/pace.ts:581-593`
  - `services/prospector/src/pace.ts:624-626`
  - `services/prospector/src/pace.ts:691`
  - `services/prospector/src/http.ts:58-59`
  - `services/prospector/src/http.ts:102`
  - `services/prospector/src/http.ts:269`
  - `services/prospector/src/tests/job.test.ts:347`

**Problem.** pace.block() ignores refusals until REFUSALS_BEFORE_BLOCK (5) arrive in a row, logging 'Venue refused a request; retrying', but nothing retries. fetchPage throws Refused on the first 403 without an amz code, and walkOne sets summary.blocked on that single refusal, so every lane stops. tend reads blockedFor() = 0 (the pace never latched), waiting(0) returns at once, and `continue` skips FLOOR_MS. A stray CDN 403 therefore tears down and rebuilds the whole pass. A persistently forbidden path loops pass after pass with no wait, because other lanes' successes reset the refusal count (pace.ts:691). Lanes do stop between pages with their cursors committed, so no work is lost.

**Evidence.** survey.ts:234 `if (err instanceof Refused && blocked(adapter, err.status, err.headers)) summary.blocked = true;`. sync.ts:568-575 `const held = paceFor(...).blockedFor(); … await waiting(held, paused); continue;`. pace.ts:586 `if (this.refusals < REFUSALS_BEFORE_BLOCK) { logger.warn(...); return; }`.

**Fix.**

survey.ts:234 and the mapping path at :142: set summary.blocked only when `err instanceof Refused && blocked(...) && paceFor(adapter, err.url).blockedFor() > 0`. Otherwise the partition counts as failed, as today. In sync.ts tend, compute `held` first and take the blocked branch only when held > 0. A blocked pass with held === 0 falls through to the ordinary not-finished path (FLOOR_MS). Make the pace.ts:590 log text true (for example 'Venue refused a request; not yet treated as a block').

**Tests to add.** Rewrite job.test 'stops asking the moment it is refused' so the pace is latched first (block() REFUSALS_BEFORE_BLOCK times) and assert one ask. Add a single unlatched CloudFront 403 case that leaves summary.blocked false and summary.failed 1. Add a sync test where a blocked pass with blockedFor() === 0 waits FLOOR_MS (sleep seam).

**Verifier notes.** cs F10, confirmed at medium. The verifier noted the finding overstates lost in-flight work.

## PRW-11: HTML index links with dot segments ('./', 'x/../', '%2e%2e'), '?' or '#' are followed, so the walk can recurse forever, duplicate catalog keys, or leave its scope

- **Severity:** medium
- **Category:** security
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/scanners/pages.ts:94-118 (indexPage)`
  - `services/prospector/src/scanners/pages.ts:126-130 (isDirectory)`
  - `services/prospector/src/scanners/descend.ts:45-80`
  - `services/prospector/src/scanners/html.ts:119-143`
  - `services/prospector/src/scanners/html.ts:193-194`

**Problem.** indexPage drops only names that start with '/', '?', '#' or '..', or that contain '://', and checks them after decoding. './', 'x/../../y/', 'a/%2e%2e/b/' and 'q?x=1' pass, and isDirectory treats 'q?x=1' as a directory. fetch normalises dot segments, so 'dir/./' serves the same index under an ever longer path. '.' sorts first, so html.next descends into it without end. descend's `seen` and `child !== prefix` are exact string checks. bybit secondary's BOOKS regex accepts the resulting paths, so duplicate rows are created. '..' segments read outside the partition and give downloaders parent paths. Standard autoindexes do not emit these links today, so the trigger is a malformed or hostile index.

**Evidence.** scratch dot.js: after 6 pages the cursor was 'linear/./././././', with keys duplicated under each ./ level. walk/pages.cjs: children ["spot/BTC/./","spot/BTC/x/../../../trading/","spot/BTC/a/../../b/","spot/BTC/q?x=1/"].

**Fix.**

In indexPage, after decode(), strip one trailing '/' and split on '/'. A directory index lists direct children only, so require exactly one segment. Drop it if it is '', '.' or '..', or contains '?', '#' or '\\'. Also require path.posix.normalize(prefix + name) to start with the prefix and to differ from it. (The same href-regex widening as PRW-01, for single-quoted and unquoted values, applies here.) No change is needed elsewhere once indexPage cannot emit such children.

**Tests to add.** pages/html tests: './', 'x/../', 'x/../../y/', 'a//b', '%2e%2e/', 'q?x=1' yield no children. href='single.zip' and unquoted hrefs are read. A walk over a self-linking index terminates after one page.

**Verifier notes.** Both lenses (cs F6 medium, eqt F4 low). Kept at medium because of the unbounded loop and duplicate rows, despite the speculative trigger. Implement it together with PRW-01's indexPage changes.

## PRW-12: A transport worker that dies is respawned in a hot loop with no backoff, and the dev script always triggers it

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/transport.ts:27-48 (carry)`
  - `services/prospector/src/transport.ts:74-76`
  - `services/prospector/src/transport.ts:97-118`
  - `services/prospector/src/index.ts:67`
  - `services/prospector/package.json:10`

**Problem.** lane() creates `new Worker(join(__dirname, 'transport.worker.js'))`, and the exit handler replaces it immediately. Under `pnpm dev` (`ts-node src/index.ts`), __dirname is src/ and only transport.worker.ts exists there, so every worker exits with code 1 and respawns about 30 times a second. Every request is rejected and burns retries, so dev mode never works. In production (dist) the worker exists, and a build that broke it would mostly break the main thread too, so the risk there is a respawn storm in place of a clean failure.

**Evidence.** scratch w.js and walk/w.cjs: 41 respawns in 2 s, 50 in 1,651 ms, and 65 in 2 s, all exit code 1.

**Fix.**

(1) Resolve the worker file once. If it does not exist (the ts-node case), log one warning in openTransport ('transport worker not built; carrying requests in-process') and create no lanes. carry() already falls back to deliver() when lanes is empty (transport.ts:28). The alternative is a .ts worker with execArgv ts-node/register. (2) Add exit backoff: a per-slot count of consecutive exits, reset on the worker's first message or after 60 s alive. Respawn after min(60 s, 1 s · 2^(n-1)). carry() skips empty slots (deliver() when none are live). After about 5 quick exits, log once at error and stop respawning that slot. Keep the transport.ts:99-103 docblock describing the resulting behaviour.

**Tests to add.** A _test_ seam for the worker path pointing at a missing file: fewer than 5 respawns in 2 s, and carry() still resolves through deliver() (mocked).

**Verifier notes.** Both lenses (cs F14 low, eqt F15 medium). Medium: the package's own dev script does not work at all.

## PRW-13: Docblocks that contradict the code they describe (reconcile, pace keying, bybit's '30', cadence, 'fifteen minutes', the s3 consumer list, okx ranges)

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/sync.ts:346-378`
  - `services/prospector/src/sync.ts:392-397`
  - `services/prospector/src/sync.ts:405`
  - `services/prospector/src/sync.ts:501-524 (tend)`
  - `services/prospector/src/sync.ts:726`
  - `services/prospector/src/sync.ts:764-768`
  - `services/prospector/src/pace.ts:30-32`
  - `services/prospector/src/pace.ts:94-105`
  - `services/prospector/src/pace.ts:299-314`
  - `services/prospector/src/types.ts:~893-896`
  - `services/prospector/src/scanners/s3.ts:8-10`
  - `services/prospector/src/context.ts:9`
  - `services/prospector/src/adapters/okx/instruments.ts:13-21`
  - `services/prospector/src/adapters/okx.ts:19-20`
  - `services/prospector/tests/pace.test.ts:116-123`

**Problem.** (1) sync.ts:356-357 says 'A walk never reconciles', but :405 reconciles every finished pass. (2) pace.ts:312-314 and pace.test.ts:116-123 say there is one budget per address, but paceFor keys on venue+host, and pace.test.ts:58-61 asserts that. (3) pace.ts:30-31, sync.ts:726 and types.ts say bybit 'earned its 30' and sets standDownMs, but bybit sets perSecond 2000/5000, and pace.test.ts:80-84 asserts no standDownMs. (4) tend's docblock points to index.ts for why the cadence 'is not this service's', while index.ts:159-164 and syncVenue say it is. (5) 'ordinary fifteen minutes' (sync.ts:767) and 'reset every fifteen minutes' (pace.ts:102): nothing has a 15-minute cycle (PROBE_EMPTY_MS is 30 s). (6) The s3.ts header lists 'binance, HTX and KuCoin', but gate and bybit-primary use it too, and a provider must not name its consumers (CLAUDE.md). (7) context.ts:9 'written out eight times' names six. (8) okx docs say ranges are 'brought level … measured' and mention a `span` table, but symbolRanges is a plain seriesFor read and no span table exists.

**Evidence.** Verified line by line by the verifier. Several reviewer line numbers were wrong (context.ts:9, not :304; bybit.primary.ts:29, not :189), but every claim holds.

**Fix.**

Comment-only edits that describe current behaviour. In sync.ts, replace the stacked blocks at 346-373 with one statement above `finished`: walks and updates both reconcile, and a walk closes only after its drain returns. Keep 374-378. pace.ts:299-314 and pace.test.ts:116-123: the bound is per limiter, keyed on venue plus host. Remove the bybit '30' wording at pace.ts:30-32, sync.ts:726 and types.ts, or state the real figures. tend: runs until one pass generates, pauses or is blocked, and the cadence between passes belongs to syncVenue. Drop the index.ts pointer. 'fifteen minutes' becomes 'waits PROBE_EMPTY_MS' and 'between passes'. s3.ts header: describe the S3 protocol only, with no venue names. context.ts:9: drop the count and the list. okx/instruments.ts:13-21 and okx.ts:19: 'the live series that have a start'; remove the span table sentence. Verify with tsc --noEmit.

**Tests to add.** None (comments only).

**Verifier notes.** eqt F8, confirmed. Do it in the same pass and the same files as PRW-14, PRW-15 and PRW-23 to avoid conflicting edits.

## PRW-14: Docblocks narrate history, incidents and plans, contrary to CLAUDE.md

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/survey.ts:59-66`
  - `services/prospector/src/survey.ts:123-127`
  - `services/prospector/src/survey.ts:306-329`
  - `services/prospector/src/survey.ts:339-342`
  - `services/prospector/src/survey.ts:469-471`
  - `services/prospector/src/survey.ts:1121`
  - `services/prospector/src/sync.ts:21-25`
  - `services/prospector/src/sync.ts:100-105`
  - `services/prospector/src/sync.ts:367-368`
  - `services/prospector/src/sync.ts:599-601`
  - `services/prospector/src/sync.ts:686-693`
  - `services/prospector/src/sync.ts:785-786`
  - `services/prospector/src/sync.ts:899`
  - `services/prospector/src/pace.ts:97-99`
  - `services/prospector/src/pace.ts:212-214`
  - `services/prospector/src/pace.ts:303-310`
  - `services/prospector/src/index.ts:259`
  - `services/prospector/src/index.ts:462-464`
  - `services/prospector/src/index.ts:489-493`
  - `services/prospector/src/scanners/descend.ts:18-21`
  - `services/prospector/src/scanners/none.ts:11-12`
  - `services/prospector/src/update.ts:93-96`
  - `services/prospector/src/update.ts:214`
  - `services/prospector/src/adapters/okx.ts:36-39`

**Problem.** CLAUDE.md requires tech docs to describe the current state only (no 'was X, now Y', no plans, not framed around the motivating problem). Many in-scope blocks are incident narratives ('Two gate book prefixes were left exactly this way…', 'for 46 minutes once', 'bybit left 137,066 rows', 'Binance said it with 8,312 rows', 'it has been wrong twice'), migration notes ('takes the old path', 'Nothing here waits for weeks any more', 'the guess this design removed', 'what let the old rules go: FANOUT … FRONTIER'), or plans ('TEMPORARY … see docs/planning/CATALOG.md'). survey.ts:306-318 and 321-329 are near-duplicate 'owed back' blocks.

**Evidence.** The quoted passages exist at the listed lines (verifier spot-checked; the descend.ts and none.ts locations were corrected).

**Fix.**

For each block, keep the invariant and its present-tense reason, and drop dates, counts, venue anecdotes and was/used-to/any-more phrasing. For example, survey.ts:306-318 becomes 'Every path out of here that does not replace the partition with children requeues it.' Merge the two 'owed back' blocks into one above giveBack. okx.ts:36-39: describe what 'drop' does today, with only a bare pointer ('kept deliberately; see docs/planning/CATALOG.md') and no 'TEMPORARY'. The plan itself already lives in docs/planning/CATALOG.md:66. Incident narratives belong in commit messages, not code.

**Tests to add.** None (comments only).

**Verifier notes.** eqt F10, confirmed. This directly serves the user's 'fresh start' on documentation request.

## PRW-15: Dead production code kept alive only by tests or by unused writes (the okx bound-measuring subsystem, OkxContext.ranges, sync sleep chunking, unused _test_ exports)

- **Severity:** medium
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/adapters/okx/instruments.ts:36-139`
  - `services/prospector/src/adapters/okx/instruments.ts:225-274`
  - `services/prospector/src/adapters/okx.ts:3`
  - `services/prospector/src/adapters/okx.ts:22`
  - `services/prospector/src/types.ts:339 (OkxContext.ranges)`
  - `services/prospector/src/sync.ts:~157-165 (sleep/MAX_DELAY_MS)`
  - `services/prospector/src/sync.ts:894-916 (_test_ exports)`
  - `services/prospector/src/pace.ts:829 (_test_tickets)`
  - `services/prospector/src/update.ts:415 (_test_grainOf)`
  - `services/prospector/tests/bootstrap.test.ts:4-7,62-215`

**Problem.** In okx/instruments.ts, laneGuard, Throttled, lists, latest, step, exists, findEnd, head and describe have no production caller. They are reachable only through _test_findEnd, _test_lists and _test_laneGuard, which bootstrap.test.ts tests, so the tests give false confidence about bounds discovery that no longer happens. Their docblocks ('a refusal stops every lane', 'measured against the venue') describe behaviour that does not exist. OkxContext.ranges is computed on every getContext call and never read. sync.ts `sleep`'s MAX_DELAY_MS chunking is unreachable (its only caller passes at most BEAT_MS). _test_probing re-exports survey's exported probing. _test_onePass, _test_tickets and _test_grainOf are unused, and update.ts imports grainOf only to re-export it.

**Evidence.** grep: findEnd, laneGuard and lists have no calls outside _test_ exports, and `.ranges` has only the write at okx.ts:22. knip lists _test_onePass, _test_tickets and _test_grainOf. okx.ts:3 imports only okxInstruments and symbolRanges.

**Fix.**

Delete from okx/instruments.ts: laneGuard, Throttled, lists, latest, step, exists, findEnd, head, describe and _test_findEnd/_test_lists/_test_laneGuard. Keep queries, states, _test_queries and okxInstruments. Remove the imports this orphans, as tsc/knip report (logger, etagOf, fetchHead, keyFor, date helpers). Delete the matching bootstrap.test.ts blocks and keep the queries tests. Rewrite the module header and the symbolRanges docblock (with PRW-13). Remove `ranges` from OkxContext, and have okx.getContext return a ProbedContext like bitget's, dropping symbolRanges if it has no other user (grep first). Replace sync's sleep/MAX_DELAY_MS with a plain setTimeout promise. Remove _test_tickets, _test_grainOf (and the grainOf import) and _test_probing (sync.test imports probing from survey). Keep _test_onePass for PRW-16. Leave scanners/none.ts and the 'none' filter in index.ts (see Rejected), and add none.ts to knip's ignore list with a comment pointing at venues.ts:20-23. Run tsc, vitest and knip.

**Tests to add.** Remove the dead tests. The suite plus tsc plus knip must stay green.

**Verifier notes.** Both lenses (cs F19, eqt F11). The okx part was confirmed by both. The none.ts deletion was refuted: it is the deliberate, documented way to register an unreachable venue.

## PRW-16: sync.ts's pass lifecycle (syncVenue/onePass/passing/tend/inPass/waiting) is untested, and four or five sync tests check only their own arithmetic

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/sync.ts:55-124`
  - `services/prospector/src/sync.ts:153-161`
  - `services/prospector/src/sync.ts:227-246`
  - `services/prospector/src/sync.ts:261-421`
  - `services/prospector/src/sync.ts:533-617`
  - `services/prospector/tests/sync.test.ts:243-263`
  - `services/prospector/tests/sync.test.ts:369-382`

**Problem.** sync.ts is at 48.6% statement coverage, and the uncovered code decides when a pass ends, when a walk closes, when update rows are cleared and whether reconcile runs. 'keeping a venue current' and 'when the next pass is due' compute `Math.max(0, began + _test_EVERY_HOURS*3_600_000 - Date.now())` inline and assert on that. 'updates daily' asserts only the constant. None of them exercises the enrolment(...).started read at sync.ts:115.

**Evidence.** Coverage scratch/cov-prospector-walk/coverage-final.json. No test imports syncVenue, _test_onePass or inPass.

**Fix.**

Delete the arithmetic tests at sync.test.ts:243-263 and 369-382. Keep the dueAfter 'answers the same thing on startup' test. Add a test file reusing the fake adapter and temp catalog from pause.test.ts and resume.test.ts, driving _test_onePass and syncVenue.

**Tests to add.** (a) A finished update reconciles, then clears its rows and logs 'Update finished'. (b) A finished walk on a probing adapter stays open until settle drains, then closes. (c) paused() mid-pass: no reconcile and no clear. (d) A blocked pass awaits blockedFor and does not reconcile. (e) tend retries after FLOOR_MS when surveyVenue throws (fake timers). (f) syncVenue with a closed run started 26 h ago starts without waiting; one started 1 h ago waits about 23 h. (g) A pause in the between-pass wait returns within BEAT_MS. (h) inPass is true during the preamble and false afterwards. Plus the PRW-03 retry test.

**Verifier notes.** eqt F12, confirmed.

## PRW-17: The survey's split and failure paths, and hostile listing inputs, have no tests

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/survey.ts:142-148`
  - `services/prospector/src/survey.ts:304`
  - `services/prospector/src/survey.ts:347-353`
  - `services/prospector/src/survey.ts:357-360`
  - `services/prospector/src/survey.ts:391-397`
  - `services/prospector/src/survey.ts:433-435`
  - `services/prospector/src/survey.ts:971`
  - `services/prospector/src/survey.ts:1057-1059`
  - `services/prospector/src/scanners/pages.ts:19-118`

**Problem.** These survey.ts lines are uncovered: the blocked mapping, a partition finished while stopping, a split timeout, a level read that throws (the PRW-02 path), divisible false, a refine failure, a stop during the retry wait, and the seededAt rules. rescope.test.ts covers only the happy and refused splits. Existing tests already cover href '../', &amp; in hrefs and IsTruncated with no NextMarker but with keys. These remain uncovered: './' and 'a/../b', &amp; in a <Key> or <NextMarker>, a truncated page with no entries, a non-XML 200 read as s3, and a non-advancing cursor.

**Evidence.** Coverage JSON: survey.ts uncovered 142,144,148,304,347-353,358,360,391-397,433,435,971,1057,1059.

**Fix.**

Add tests/survey-failures.test.ts reusing the rescope fake scanner. Land the malformed-page, dot-segment, entity and repeated-cursor tests together with PRW-01, PRW-06 and PRW-11, which define that behaviour.

**Tests to add.** A level that rejects leaves the partition requeued and walked exactly once, and surveyVenue resolves. A level that never resolves is abandoned after SPLIT_MS (fake timers) and the partition resumes whole. Children that all sort below the cursor requeue the parent. paused() during a page retry wait returns with no further request. A blocked mapping returns {blocked:true}. rulesFor passes seededAt only before the first completed pass of a listable:false venue.

**Verifier notes.** eqt F13, confirmed. The verifier corrected the claim that pages tests cover nothing hostile.

## PRW-18: Transport worker path, lookup failure paths and every scanner `confirm` are untested

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/transport.ts:30-48`
  - `services/prospector/src/transport.ts:75-120`
  - `services/prospector/src/transport.ts:135-145`
  - `services/prospector/src/transport.worker.ts`
  - `services/prospector/src/lookup.ts:55-64`
  - `services/prospector/src/lookup.ts:91-94`
  - `services/prospector/src/scanners/probed.ts:24-36`
  - `services/prospector/src/scanners/s3.ts:51-56`
  - `services/prospector/src/scanners/html.ts:73-80`

**Problem.** transport.ts is at 29.5% coverage and transport.worker.ts at 0%. Every production request goes through carry and the worker. lookup's stale-on-failure refresh and `all: true` are uncovered. probed.confirm (the only check for okx and bitget files from reports), s3.confirm and html.confirm are uncovered.

**Evidence.** Coverage: transport.ts uncovered 30-48, 75-120, 135-145. lookup.ts uncovered 55-64, 92-94. probed.ts at 12.5%. Under vitest, __dirname is src/, so a worker test needs dist or an injectable worker path.

**Fix.**

Add an optional worker-path parameter or seam to openTransport (shared with PRW-12), or test against dist after a build. For lookup, use vi.resetModules plus a fresh import (module state KNOWN/ASKING/installed) and stub dns.lookup.

**Tests to add.** Transport: replies resolve the matching ids; a worker exit rejects all waiting requests and a replacement serves the next carry; a fault crosses back with its cause code. Lookup: a first failure is passed to the callback; after KEEP_MS a failing refresh serves the cached address and asks again only after RETRY_MS; {all:true} returns the preferred-family array. Confirm: s3 picks the exact key out of A.zip and A.zip.CHECKSUM, and an empty valid listing gives 'absent'; html and probed return {status, headers} for a 404 and the normalised etag and size on 200 (see PRW-21).

**Verifier notes.** eqt F14, confirmed. 'One real lookup for concurrent callers' already exists and is not needed.

## PRW-19: Tickets.give() ignores a lowered limit, so a shrink (reopenGradually) never takes effect while lanes are queued

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/pace.ts:173-178`
  - `services/prospector/src/pace.ts:180-194`
  - `services/prospector/src/pace.ts:219-247`
  - `services/prospector/src/index.ts:147`
  - `services/prospector/src/http.ts (send: pass() before slot())`

**Problem.** give() always hands a returned ticket to the next waiter without comparing #taken to #limit, so after resize() down, outstanding stays at the old ceiling for as long as anyone is queued. That contradicts the 'shrink is reached by attrition' docblocks. Impact is modest: lanes held by the network gate wait in pass() before taking a ticket, so at reopen the queue is usually near empty. The bug bites only after very short closures or a degraded-to-open transition.

**Evidence.** walk/tickets.cjs: after capacity(300) with 300 out and 500 waiting, reopenGradually() gives limit 100, outstanding 300, and still 300 after 300 answers. pace.test.ts:572-581 asserts only the limit.

**Fix.**

In Tickets.give(): `if (this.#taken > this.#limit || this.#waiting.length === 0) { this.#taken--; return; } this.#waiting.shift()!();`. Update the class and reopenGradually docblocks: a shrink is reached as tickets come back, and lanes held by the gate hold no tickets.

**Tests to add.** pace.test.ts: with the limit at 300, 300 taken and 50 waiters, resize(100), then 250 gives leave outstanding at 100 with no waiter woken, and further gives transfer one-for-one. A ramp test where answered() grows the pool from there.

**Verifier notes.** Both lenses (cs F16 low, eqt F5 medium). The eqt verifier downgraded it to low, explaining why the gate makes the reopen scenario rare.

## PRW-20: With one lane (PROSPECTOR_CONCURRENCY=1), descend returns the key root as the only partition and beginJob throws 'A partition cannot be the empty scope' every 30 s

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/scanners/descend.ts:35`
  - `services/prospector/src/scanners/descend.ts:47`
  - `services/prospector/src/scanners/descend.ts:78`
  - `services/prospector/src/survey.ts:791-796`
  - `services/prospector/src/paths.ts:42-43`
  - `services/prospector/src/catalog/queries.ts:982-983`
  - `services/prospector/src/pace.ts:62-63 (lanesFor)`
  - `services/prospector/src/config.ts:72-81`

**Problem.** descend splits only while scopes.length < concurrency, so with one lane it returns [keyRoot]. relative() maps every venue's key root to '', so all s3 and html venues (not only those with an empty root) hit beginJob's empty-scope error. tend logs a generic 'Venue survey failed' and retries for ever. The same applies when the root holds a catalogable file or has no accepted children.

**Evidence.** descend.ts:47 `while (scopes.length < limits.concurrency)`. queries.ts:982 throws on ''. parsePositiveInt accepts 1.

**Fix.**

In descend.ts, always expand the key root once, whatever the lane count (for example, loop while `scopes.length < concurrency || !seen.has(keyRoot)`, and exempt the root's first split from the room check at :78). If the root has no accepted children and no files, return [] (nothing to walk). If the root holds a catalogable file, throw an explicit error naming the venue. Do not reject concurrency < 2 in config.

**Tests to add.** descend/s3 test: _test_descend with {concurrency:1} on a root with two child prefixes returns both and never ''. job.test: surveyVenue with config.concurrency 1 and the real s3 scanner opens a job without throwing.

**Verifier notes.** cs F15, confirmed. The verifier widened it to every venue.

## PRW-21: ETag and size are normalised differently on each path: probed.confirm bypasses etagOf, and html.confirm records a missing Content-Length as size 0

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/scanners/probed.ts:29-36`
  - `services/prospector/src/scanners/html.ts:76-82`
  - `services/prospector/src/etag.ts:1-19`
  - `services/prospector/src/probe.ts:654-667`
  - `services/prospector/src/backfill.ts:133-143`
  - `services/prospector/src/reports.ts:206`

**Problem.** probed.confirm hand-rolls `replace(/^"|"$/g,'').toLowerCase()`, where every other path, including probe.ts which wrote the stored value, uses etagOf (&quot; and -gzip handling). reports compares the two, so a spurious change is possible (plausible, not observed for okx or bitget). probed parses size with Number(size), which gives NaN for a non-numeric header. html.confirm does `Number(headers.get('content-length'))`, so a missing header becomes 0: the bug probe.ts:654-657 explicitly guards against.

**Evidence.** probed.ts:33-34. html.ts:78 Number(null) === 0. etagOf('W/"abc"') gives 'w/"abc'.

**Fix.**

Add one shared `metadataOf(headers)` helper (or `sizeOf(raw): number | null` plus etagOf) next to etagOf. Size is null unless the header is non-empty and a safe non-negative integer. etag is etagOf(headers.get('etag')), and modified is last-modified. Use it in probed.confirm, html.confirm and probe.ts settlement (and backfill if it fits). Optionally map an empty etagOf result to null. Do not strip `W/` in this change (see Rejected).

**Tests to add.** probed.confirm with etag '"ABC-gzip"' gives 'abc'. content-length '' or 'x' gives size null. html.confirm with no content-length gives size null, not 0.

**Verifier notes.** Both lenses (cs F17, eqt F19). Verifiers corrected the direction: html.confirm, not probed, has the absent-length bug. The suggestion to copy html's size parsing was rejected as harmful.

## PRW-22: compose.yml documents a non-existent connection-ceiling setting and a wrong concurrency rule, and a bad schedule exits 0 under restart: unless-stopped, contrary to its comment

- **Severity:** low
- **Category:** config
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/docker/compose.yml:42-45`
  - `services/prospector/docker/compose.yml:48-51`
  - `services/prospector/docker/compose.yml:79`
  - `services/prospector/src/index.ts:91-103`
  - `services/prospector/src/config.ts:30-36`
  - `services/prospector/src/survey.ts:92`

**Problem.** compose.yml:48-51 is a comment about an HTTP/1.1 connection ceiling with no variable under it, and config.ts reads no such setting. compose.yml:44-45 says a venue alone 'is limited only by its own figure', but lanesFor and the ticket pool cap it at min(adapter, PROSPECTOR_CONCURRENCY). index.ts:91-95 says a bad walk schedule exits cleanly 'so that nothing restarts it', but `restart: unless-stopped` restarts it anyway (with back-off), and exit 0 reports success.

**Evidence.** compose.yml:79 `restart: unless-stopped`. index.ts:103 `process.exit(0)`. binance concurrency 500 against the default 200.

**Fix.**

Delete compose.yml:48-51. Rewrite 44-45 as '…a venue surveying alone is limited by the lower of its own figure and this one.' Exit non-zero on a bad schedule (process.exit(78), EX_CONFIG), and rewrite index.ts:91-95 to say what happens: the service refuses to start, and under the shipped compose policy Docker restarts it with back-off, each start logging the same refusal until the file is fixed. Keep restart: unless-stopped (see deferred PRW-30 / owner note).

**Tests to add.** None (config and comments). Optionally, a test that a bad schedule calls process.exit with 78.

**Verifier notes.** Both lenses (cs F18, eqt F7). Whether a bad schedule should keep the container down (restart: on-failure) changes daemon-restart behaviour too, so it is flagged to the owner rather than applied.

## PRW-23: Docblocks detached from their declarations or stacked, so the wrong text documents a symbol

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/survey.ts:34-49`
  - `services/prospector/src/survey.ts:465-477`
  - `services/prospector/src/survey.ts:751-756`
  - `services/prospector/src/sync.ts:128-140`
  - `services/prospector/src/sync.ts:157`
  - `services/prospector/src/pace.ts:628-645`
  - `services/prospector/src/pace.ts:815-824`
  - `services/prospector/src/index.ts:532-557`
  - `services/prospector/src/adapters/okx/instruments.ts:250-253`

**Problem.** TypeScript attaches only the docblock immediately before a declaration. surveyVenue, HEARTBEAT_MS, waiting, rates() and surveyable have no doc, because their text is stacked on a neighbour (probing, live, timingsAt, inPass, state(), walkable). pace.ts:815-823 describes fault causes but sits above `sleep`, and faults.ts:17-21 already covers it. okx/instruments.ts:250-253 documents nothing.

**Evidence.** Confirmed in the source for every case.

**Fix.**

Move survey 34-49 above surveyVenue, 465-477 above `alive` (or merge it into the live doc), and 751 above HEARTBEAT_MS. Move sync 128-140 above waiting, pace 628-634 above rates(), and index 532-538 above surveyable. Delete pace 815-823 and okx/instruments 250-253 (the latter goes with PRW-15 anyway). Do this with PRW-13 and PRW-14.

**Tests to add.** None (tsc only).

**Verifier notes.** eqt F9, confirmed.

## PRW-24: Pacing.giveUpAfter doubles as the fault-log cadence, and Pacing.concurrency is documented as a queue bound

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/pace.ts:48`
  - `services/prospector/src/pace.ts:411`
  - `services/prospector/src/pace.ts:491-494`
  - `services/prospector/src/pace.ts:552`
  - `services/prospector/src/types.ts:871`
  - `services/prospector/src/types.ts:877-881`
  - `services/prospector/src/probe.ts:523`

**Problem.** Pace.faulted logs every giveUpAfter-th consecutive transport fault, reusing a field documented and used (probe.ts:523) as the number of refusals tolerated before a pass gives up. No adapter overrides it today, so the coupling is latent. types.ts:871 says concurrency is 'How many requests may be waiting at once. A bound on the queue', but pace enforces it as requests in flight.

**Evidence.** pace.ts:552 `if (this.faults % this.pacing.giveUpAfter !== 0) return;`. pace.ts:411 `inFlight >= allowed`.

**Fix.**

Add `const FAULTS_PER_WARNING = 50` in pace.ts with a one-line doc, and use it at :552. Rewrite types.ts:871: 'How many requests may be in flight to this venue at once, reached after a short ramp from cold (see Pace.allowed). A bound on concurrency, not on the rate.'

**Tests to add.** None needed.

**Verifier notes.** eqt F20, confirmed.

## PRW-25: Progress and heartbeat counters miscount split partitions, and a blocked pass reports skipped partitions as 'openWithoutAFailure'

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/survey.ts:207`
  - `services/prospector/src/survey.ts:252-256`
  - `services/prospector/src/survey.ts:503-505`
  - `services/prospector/src/survey.ts:543-601`

**Problem.** walkOne increments `settled` after any sweep return, including a stop for splitting and a partition that is given back and walked again, so the progress ratio overcounts. The heartbeat's `scopes` duplicates `running`. When summary.blocked is set, the queued partitions skipped through walkOne's early return are not counted as failed, so the 'Survey incomplete' warning lists them all under openWithoutAFailure, which reads as lost keyspace. This affects logs only.

**Evidence.** survey.ts:252 `settled++` after any StopReason. survey.ts:505 `scopes: [...running.keys()].length` next to `running: running.size`.

**Fix.**

sweep returns {requests, found, closed}, with closed true only where it closes the run. walkOne increments settled only when closed or failed. Drop the `scopes` heartbeat field. Compute `unexplained` only when !summary.blocked, or log the blocked case as leftForNextPass: <count>.

**Tests to add.** A survey test where the scanner blocks on the first partition with others queued: the incomplete warning has no openWithoutAFailure entries. A split partition is not double-counted.

**Verifier notes.** eqt F21, confirmed. The verifier noted that '40/38' cannot happen, since the denominator includes settled.

## PRW-26: held() prepares a new SQLite statement for every part key during generation

- **Severity:** low
- **Category:** efficiency
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/update.ts:389`
  - `services/prospector/src/update.ts:408-411`
  - `services/prospector/src/adapters/gate.ts:73-77`
  - `services/prospector/src/adapters/gate.ts:204-220`
  - `services/prospector/src/catalog/queries.ts:1736 (statement cache)`

**Problem.** keysAt calls held() for every part token, and held runs db.prepare each time. gate options_ticker produces 44,640 parts per month, all checked synchronously on the main thread when the series has no first or the first part is held.

**Evidence.** Measured with node:sqlite in memory: 280-291 ms with prepare per call against 28-39 ms with one prepared statement.

**Fix.**

Export the per-database `statement` cache from catalog/queries.ts, or add an exported isHeld(db, venueId, path) there that uses it. Delete update.ts's held. Do not adopt a bulk prefix query without checking that a period's keys share a contiguous prefix.

**Tests to add.** Existing update tests stay green.

**Verifier notes.** eqt F16, confirmed.

## PRW-27: Pace.trim splices the send-time array on every request and since() scans linearly; rulesFor is recomputed on every page attempt

- **Severity:** low
- **Category:** efficiency
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/pace.ts:439-463`
  - `services/prospector/src/pace.ts:701-709`
  - `services/prospector/src/pace.ts:735-740`
  - `services/prospector/src/survey.ts:876-879`

**Problem.** `sent` holds up to perSecond×10 timestamps (bitget 2,500/s, kucoin and bybit secondary 5,000/s). trim splices the stale prefix and since() walks back linearly on every slot(). That costs about 1-1.75% of the main thread at 2,500/s. rulesFor runs on every page attempt in sweep, which is negligible but trivially hoistable.

**Evidence.** walk/trim.cjs: 175 ms per 10 s at 2,500/s. The verifier's simulation gave about 95 ms.

**Fix.**

Keep `sent` time-ordered with a `head` index. trim advances head and compacts only when head passes half the length. since(from) does a binary search in [head, length). Keep `oldest = sent[length - within]`. Do NOT use the reviewer's fixed ring that answers only the perSecond-th send: it loses `within`, which `peak` and the sleep computation need. Optionally compute rulesFor once before sweep's attempt loop (update kind).

**Tests to add.** pace unit test with a fake clock: rates().lastSecond, peak and the sleep target match the current implementation for N sends.

**Verifier notes.** eqt F17, confirmed. The verifier corrected the suggested ring design.

## PRW-28: Retry-After is uncapped and a pause cannot interrupt it, and refine's wait for the victim partition is not bounded by SPLIT_MS

- **Severity:** low
- **Category:** robustness
- **Decision:** DEFER
- **Locations:**
  - `services/prospector/src/http.ts:108-113`
  - `services/prospector/src/http.ts:283-307 (waitOut)`
  - `services/prospector/src/http.ts:320-335 (retryAfterMs)`
  - `services/prospector/src/survey.ts:298-300`
  - `services/prospector/src/survey.ts:336-345`
  - `services/prospector/src/index.ts:373`

**Problem.** retryAfterMs honours any value, and waitOut sleeps the whole period inside fetchPage or fetchHead with no pause or halt check. A pause, refresh or forced update takes effect only after the wait (the POST itself does not block, since begin is not awaited). refine's `await runner.finished` is outside withinSplit, so a split waits on the victim's current page, retries and Retry-After included. The parked lanes are idle anyway, so the cost is a delayed split. The uncapped behaviour is deliberate (http.ts:320-323: 'Honoured as sent, never capped … how a 429 becomes a ban').

**Evidence.** http.ts:330 no cap. http.ts:298-306 has no stop check.

**Fix.**

If the owner agrees: either cap at pacing.ceilingMs and latch the pace (block-style stand-down) instead of sleeping in-request, or keep the values uncapped. Independently and with lower risk: an optional `stopped` callback threaded through ListingContext.page → fetchPage → waitOut that ends the wait with a Stopped error, which sweep turns into a clean return. Wrap refine's await runner.finished in a bounded race (SPLIT_MS), and on timeout add the scope to terminal. Best done together with the per-venue abort token recommended in the assessment.

**Tests to add.** A pause during a fetchPage Retry-After wait returns within one BEAT. refine with a victim whose page never resolves returns after the bound.

**Verifier notes.** cs F11. The first verifier rated it low and recommended deferring it (it contradicts an explicit design decision, and the trigger has not been observed). There was no second verifier.

## PRW-29: Listing GETs follow redirects to any host or scheme and read bodies of any size into memory

- **Severity:** low
- **Category:** security
- **Decision:** DEFER
- **Locations:**
  - `services/prospector/src/deliver.ts:71`
  - `services/prospector/src/deliver.ts:103-134 (readAll)`
  - `services/prospector/src/scanners/pages.ts:126-130`

**Problem.** get() uses fetch's default redirect: 'follow', so a venue or CDN redirect can point listing requests at internal addresses or downgrade to http, while the HEAD paths do not follow redirects. readAll has no size cap. Impact is small: a fetched body is only parsed into catalog keys, a compromised venue can already feed arbitrary listings, a misread file is requested as FILE/ (and 404s), and overflow throws RangeError, which is caught as a request error rather than crashing the worker. deliver.ts is outside the unit's listed scope but is the scanners' trust boundary.

**Evidence.** deliver.ts:71 `fetch(url, { signal: control.signal })`. deliver.ts:124 appends with no length check.

**Fix.**

If taken up: a MAX_BODY_BYTES check (for example 256 MB) in readAll counting step.value.byteLength, which aborts with a typed BodyTooLarge error. Before changing the redirect policy, log hosts where res.redirected is true for a week. Then use redirect: 'manual' and treat 3xx as a non-retryable answer, or allow only same-origin https redirects.

**Tests to add.** A local server streaming an endless body makes readAll reject with BodyTooLarge. A cross-origin 302 is not followed.

**Verifier notes.** cs F12. Confirmed at low and deferred by the verifier.

## PRW-30: Every service's compose mounts the whole repository read-write at /live, including in prod

- **Severity:** low
- **Category:** config
- **Decision:** DEFER
- **Locations:**
  - `services/prospector/docker/compose.yml:60`
  - `docker/dev.node.Dockerfile (WORKDIR /live, npm_config_store_dir=/live/.pnpm-store)`

**Problem.** `../../../:/live` bind-mounts the repo root, including any .env files and other services' sources, read-write into a container that parses untrusted network responses. Dev mode needs it to be writable (pnpm store, installs). In prod the image works from /app and the mount is unused, so the exposure is real but limited. The same pattern is in catalog, catalog-ui, hauler, hoarder, pipe, router and stocker.

**Evidence.** compose.yml:60. The dev Dockerfile writes to /live.

**Fix.**

If the owner agrees, move the /live mount out of every service's compose.yml into a dev-only override (for example compose.dev.yml), so prod containers get no host bind. Do NOT add :ro to the existing mount, because that breaks APP_ENV=dev.

**Tests to add.** Bring up each service in dev and prod modes after the change.

**Verifier notes.** From cs F18 (mount half). The verifier rejected the :ro fix and identified this as a repo-wide convention.

## Deferred: decisions needed

- **PRW-28** (Retry-After is uncapped and a pause cannot interrupt it, and refine's wait for the victim partition is not bounded by SPLIT_MS): Should Retry-After stay 'honoured as sent, never capped', or get a sanity ceiling (for example pacing.ceilingMs) above which the pace latches instead of sleeping in-request? And is threading a stop signal through fetchPage/fetchHead/waitOut (a ListingContext interface change) acceptable now, or should it wait for a broader per-venue abort token?
- **PRW-29** (Listing GETs follow redirects to any host or scheme and read bodies of any size into memory): Do any venues rely on listing redirects today? Is it acceptable to log res.redirected hosts for a week and then switch listings to redirect:'manual' (or same-origin https only)? What body ceiling is acceptable per format?
- **PRW-30** (Every service's compose mounts the whole repository read-write at /live, including in prod): Should the repo-wide /live bind mount move into a dev-only compose override for all services (a cross-service change outside prospector), and should a bad walk schedule keep the container down (restart: on-failure) rather than restart-loop under unless-stopped?
- **PRW-05** (minor, non-blocking): should excluded rows leave the catalog through an explicit 'excluded' transition, or be left alone by walks (the default)?

## Rejected

- **html `known` cache skips directories added under an already-visited parent on resume (secondary claim of cs F8)**: This matches the documented 'present at the start' guarantee (survey.ts:159-162). It is not a defect.
- **Strip a leading W/ from weak ETags in etagOf (cs F17 / eqt F19)**: Speculative, with no venue evidence. Every path handles weak tags consistently today, and stripping them would register a one-time change for every stored weak etag. Revisit only after checking the catalog for stored 'w/' etags.
- **Parse probed.confirm size 'identical to html.ts' (eqt F19 suggestion)**: Harmful: html.ts turns an absent Content-Length into 0. PRW-21 fixes html instead.
- **Reject PROSPECTOR_CONCURRENCY < 2 in config (cs F15 alternative)**: It makes a legitimate setting unusable and hides the defect. PRW-20 fixes descend instead.
- **Add :ro to the /live mount (cs F18 suggestion)**: It breaks dev mode, which writes the pnpm store and installs under /live. Superseded by deferred PRW-30.
- **Delete scanners/none.ts and the 'none' filter in surveyable (eqt F11 part)**: It is deliberate: venues.ts:20-23 documents it as the way to register a venue before it is reachable. Keep it and add it to knip's ignore list.
- **Encode prefix/marker with encodeURIComponent restoring only %2F (cs F7 / eqt F3 suggestion)**: It would newly encode ':', '=', ',', ';', '$', '@', which cannot be checked against KuCoin's known encoding sensitivity. PRW-06 uses a minimal encoder instead.
- **Throw UnreadablePage from inside readPage (cs F3 suggested placement)**: readPage runs in the transport worker. A throw there is counted and logged by pace.faulted as an unreachable host. PRW-01 returns a malformed marker and throws in fetchPage instead.
