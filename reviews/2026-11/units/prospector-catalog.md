# Review: prospector-catalog

## Overall assessment

The catalog's data paths are well built. Every external value is bound in SQL, so there is no injection: the only interpolations are fixed operators, '?' lists and the integer in PRAGMA user_version. Transactions are short and counters move inside the same transaction as their rows. The hot lookups use indexes, and line coverage is high (catalog 92-96%, database 92%, seed.ts 89%). All shipped htx/gate/binance retired shapes resolve through each adapter's inspectUrl to the seeded market/dataset/variant/pattern. There are still real defects. The most serious: reconcile throws FOREIGN KEY constraint failed for a series whose files have all been withdrawn, and that wedges the venue's pass for good (PRC-01). Others: settleFiles drops the revision of a withdrawn file that comes back with new bytes; file.seen_at drifts to the latest re-offer of a parked key; establishedAt counts updates as establishing the keyspace; a walk can give a new series a tip in an unclosed period; and in-memory registries go stale after addTransform and retirePattern. Cross-cutting design issue: several invariants hold only by convention between per-database in-memory state and the database. That state is the series registry, the transform registry, the patterns cache, the wip counters and buffers, and three separate prepared-statement caches, each in its own WeakMap. A single per-database state object owning all of them, with explicit invalidate and flush methods (and 'mutate DB and registry together' helpers), would remove that class of bug. The 14 hand-written BEGIN/ROLLBACK blocks should become one transaction helper. Documentation is the weakest area, and it matters for the user's planned fresh start. The migration-policy docs contradict each other. The seeds README has an example row the loader refuses, a wrong venue layout and a wrong quoting claim. The unsettled() docblock describes a different query. The htx migration states the wrong data/ end date. BINANCE.md and 006-binance.ts misstate the coin-margined bookTicker end date, and the seed is right (verified against the live archive). Several docblocks name columns, fields or functions that do not exist. Many passages narrate history or incidents, or explain a provider by its consumers, against CLAUDE.md. Failure handling is the weakest part of the tests: no rollback path, migration failure, seed refusal or CSV quoting case is covered, and two migration tests pass regardless of the behaviour they name. queries.ts (1,932 lines) should eventually be split, but that is deferred to an owner-agreed refactor.

## Summary

| id | severity | category | decision | title |
|---|---|---|---|---|
| PRC-01 | high | correctness | IMPLEMENT | reconcile deletes series that still have file/wip rows: FOREIGN KEY constraint failed wedges the venue's pass |
| PRC-02 | medium | correctness | IMPLEMENT | settleFiles overwrites a withdrawn file's previous version without appending it to revision |
| PRC-03 | medium | correctness | IMPLEMENT | file.seen_at records the last re-offer of a parked key, not first discovery |
| PRC-04 | medium | correctness | DEFER | putFiles withdraws catalogued paths the survey filtered out (excluded/refused/unplaced) as if the venue had withdrawn them |
| PRC-05 | medium | robustness | IMPLEMENT | Hand-written BEGIN/ROLLBACK blocks mask the original error (auto-rollback and post-commit failures) |
| PRC-06 | medium | correctness | IMPLEMENT | In-memory registries go stale: addTransform, retirePattern, loadSeries |
| PRC-07 | medium | docs | IMPLEMENT | Migration docblocks: contradictory change policy, wrong htx date, gate header misses 18 shapes, venue facts restated |
| PRC-08 | medium | docs | IMPLEMENT | Seeds README and seed.ts docblocks contradict the code and the shipped files |
| PRC-09 | low | docs | IMPLEMENT | Catalog/types docblocks describe queries, columns, fields and names that do not exist |
| PRC-10 | low | docs | IMPLEMENT | Docblocks narrate history and incidents, carry stale figures, or explain providers by their consumers |
| PRC-11 | low | robustness | IMPLEMENT | Seed CSV reader: CRLF/BOM, unterminated quotes, no stamp-width validation, weak duplicate guard |
| PRC-12 | medium | testing | IMPLEMENT | Seed loader refusals and CSV quoting are untested; the contract test re-implements the parser differently |
| PRC-13 | medium | testing | IMPLEMENT | Migration tests pass regardless of the behaviour they name; migration rollback untested; read-only test fails as root |
| PRC-14 | medium | testing | IMPLEMENT | Failure paths and several query functions have no tests |
| PRC-15 | low | docs | IMPLEMENT | Binance docs misstate the coin-margined bookTicker end date (the seed is right) |
| PRC-16 | low | correctness | IMPLEMENT | establishedAt counts completed update runs as establishing the keyspace while walk partitions are open |
| PRC-17 | low | correctness | IMPLEMENT | walkSeries gives a new series a tip in a period that has not closed |
| PRC-18 | low | efficiency | IMPLEMENT | reconcile deletes each empty series in its own autocommit transaction |
| PRC-19 | low | correctness | IMPLEMENT | refinePartition progress() compares cursors in UTF-16 order instead of byte order |
| PRC-20 | low | code-quality | IMPLEMENT | Production-dead and test-only API in the catalog barrel |
| PRC-21 | low | code-quality | IMPLEMENT | Existence type is wider than any table allows; dead null-handling of CatalogFile.seriesId |
| PRC-22 | low | robustness | IMPLEMENT | openCatalog leaks its handle when migrate throws and decides freshness by file existence |
| PRC-23 | medium | efficiency | DEFER | Three indexes on the largest tables have no production reader |
| PRC-24 | low | efficiency | DEFER | seriesFor/patternsOf scan and copy every venue's series on each call |
| PRC-25 | low | correctness | DEFER | Registry identities omit variant although one URL shape may publish into two slices |
| PRC-26 | low | code-quality | DEFER | queries.ts is a 1,932-line grab bag with duplicated SQL and three statement-cache schemes |

## Items

### PRC-01: reconcile deletes series that still have file/wip rows: FOREIGN KEY constraint failed wedges the venue's pass

- **Severity:** high
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/catalog/series.ts:581-584`
  - `services/prospector/src/catalog/series.ts:645-660`
  - `services/prospector/src/catalog/series.ts:1101-1117`
  - `services/prospector/src/database/schema.ts:100`
  - `services/prospector/src/database/schema.ts:130`
  - `services/prospector/src/database/schema.ts:542`
  - `services/prospector/src/sync.ts:403-415`

**Problem.** The `bounds` statement only considers files with existence <> 'absent'. When it finds none (real.first === null), reconcile calls remove(), which runs DELETE FROM series. file.series_id and wip.series_id both reference series(id), and PRAGMA foreign_keys = ON is set on every open. So a series whose files have all been withdrawn, or that only has parked wip rows, throws. reconcile runs in autocommit with no per-series guard, so the throw stops the loop: later series are not reconciled and flushTips never runs. In sync.ts the exception skips clearUpdate/closeWalk, the pass stays open, and every resumed pass fails on the same row. The remove() docblock (series.ts:1101) claims an invariant that nothing enforces.

**Evidence.** Reproduced independently by two verifiers. Case 1: series AAA and BBB with one confirmed file each, then withdrawFile(AAA's file), then reconcile, which throws `Error: FOREIGN KEY constraint failed`. AAA's tip was lifted only in memory, BBB was never reached, and nothing was flushed. Case 2: a series with no files and one parkKeys wip row throws the same error. Walks mark vanished files absent and never delete them (queries.ts:1628-1651, schema.ts:105-106), so this is reachable in normal operation, e.g. a delisted symbol's directory disappearing.

**Fix.** In reconcile, prepare next to `bounds`: `SELECT EXISTS (SELECT 1 FROM file WHERE series_id = ?1) OR EXISTS (SELECT 1 FROM wip WHERE series_id = ?1) AS held`. In the `real.first === null` branch, call remove() and count summary.removed only when held = 0. When held = 1, keep the row and `continue`. Do NOT null first/last: preamble.ts (the `walking`/`stranded` filters near lines 249 and 293) treats first === null as a series still to be discovered or backfilled, so nulling would change behaviour. The second verifier proposed nulling the bounds. I checked preamble and side with the first verifier; see the owner question. Fix the remove() docblock so it describes the check. Optional hardening: wrap each series' body in try/catch that logs {venue, seriesId, err} and continues, and run flushTips in a finally. Coordinate with PRC-17 (batching deletes per chunk).

**Tests to add.** tests/series.test.ts: (a) two series; withdraw the only file of the first, then reconcile. Expect no throw, the first series kept, the second's tip lifted, and flushTips persisting both. (b) A series with only a parked wip row (parkKeys) and no files survives reconcile. (c) A series with neither is still removed.

**Verifier notes.** Both verifiers confirmed at high and implement=yes. They disagree only on whether to null first/last for a held series. Resolved by reading preamble.ts: keep the bounds.

**Owner question.** Optional follow-up, not blocking: should a series whose files are all withdrawn carry a marker (e.g. bounds reflecting 'no live files') distinct from 'never discovered'? Today first === null means the latter, so the fix leaves the bounds alone.

### PRC-02: settleFiles overwrites a withdrawn file's previous version without appending it to revision

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/catalog/queries.ts:698-716`
  - `services/prospector/src/catalog/queries.ts:758`
  - `services/prospector/src/catalog/queries.ts:268-274`
  - `services/prospector/src/database/schema.ts:157-168`

**Problem.** When a probe settles a key whose file row is 'absent', the `arrive` upsert overwrites size, etag and modified, and clears downloaded_at when the bytes differ. It never writes the replaced version to `revision`. putFiles appends the old version for the same event (`if (changed) revise.run(...)`). The schema documents revision as every version after the first, appended rather than overwritten.

**Evidence.** Reproduced: putFiles(size 1, etag 'old'), markDownloaded, withdrawFile, putFiles with null size/etag (which parks the key), then settleFiles(size 2, etag 'new'). The file row ends as {size 2, 'new', confirmed, downloaded_at null} and revision is []. The same return through putFiles gives revision [{size 1, etag 'old'}]. Nothing reads revision today, so the loss is an audit-trail loss (medium, not high).

**Fix.** In settleFiles, prepare once before the loop: `INSERT INTO revision (venue_id, path, seen_at, size, etag, modified, downloaded_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (venue_id, path, seen_at) DO NOTHING` (hoist this SQL to a shared constant with putFiles). After `const gone = lost.get(...)` and before `arrive.run`, add `if (gone && replaced(merged, gone)) revise.run(file.venueId, file.path, was.seenAt, gone.size, gone.etag, gone.modified, gone.downloadedAt)`. Use was.seenAt: Settlement has no seenAt. Consider using replaced()/sameTag instead of the raw `size IS ... AND etag IS ...` CASE, so ETag letter case cannot spuriously clear downloaded_at. Extend the settleFiles docblock: a row returning from absent with different bytes is a revision.

**Tests to add.** Regression for the repro above: assert one revision row {size 1, etag 'old', downloaded_at set}. A same-bytes return asserts no revision row.

**Verifier notes.** Verifier 1 confirmed but lowered high to medium (no reader of revision). The second verifier was not run, because the first verdict was below high. The reviewer's suggested `file.seenAt` does not exist; use was.seenAt.

### PRC-03: file.seen_at records the last re-offer of a parked key, not first discovery

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/catalog/wip.ts:362-383`
  - `services/prospector/src/catalog/wip.ts:396-398`
  - `services/prospector/src/catalog/wip.ts:413-414`
  - `services/prospector/src/catalog/queries.ts:757-763`
  - `services/prospector/src/database/schema.ts:109`
  - `services/prospector/src/database/schema.ts:136`

**Problem.** file.seen_at is documented as 'first discovery; never moves'. A bare walked key parked in wip gets created_at = seenAt, but when it is offered again the `refresh` UPDATE sets created_at to the new sighting. `held` reads created_at AS seenAt and settleFiles writes it into file.seen_at. Nothing else reads wip.created_at, so the refresh has no purpose other than this bug. The wip docblock and schema.ts:136 ('refreshed if offered again') contradict schema.ts:109.

**Evidence.** Repro pc-seenat.js, re-run by the verifier: park bare at T1, park again at T5, settle gives seen_at 'T5'. The existing wip.test.ts:147 covers only a single offer. Only walked keys are affected: the update path uses PARKING with DO NOTHING.

**Fix.** Remove `created_at = ?` from the refresh UPDATE (wip.ts:375-383) and the matching row.seenAt argument from refresh.run (wip.ts:413-414). Rewrite the wip.ts:371-372 docblock sentence (created_at is left alone because it is the first sighting and becomes file.seen_at). Change the schema.ts:136 comment to `-- enqueued; first sighting, never refreshed`. Editing the 001-core comment needs no live-DB step.

**Tests to add.** tests/wip.test.ts 'arriving': putFiles bare (seenAt T1), putFiles bare (T5), settleFiles, expect seen_at 'T1'. Also: a second offer carrying size+etag (settle-in-put path) still yields 'T1'.

**Verifier notes.** Confirmed medium, implement.

### PRC-04: putFiles withdraws catalogued paths the survey filtered out (excluded/refused/unplaced) as if the venue had withdrawn them

- **Severity:** medium
- **Category:** correctness
- **Decision:** DEFER
- **Locations:**
  - `services/prospector/src/catalog/queries.ts:129`
  - `services/prospector/src/catalog/queries.ts:316-323`
  - `services/prospector/src/catalog/queries.ts:1716`
  - `services/prospector/src/survey.ts:933`
  - `services/prospector/src/survey.ts:1090-1180`

**Problem.** putFiles derives `offered` only from the files it is given. The survey drops entries that fail isExcluded, adapter.accepts or excludedAnywhere, that have no date, or that resolve to no series, and then passes the page span. Any catalogued row in the span missing from `offered` is marked absent, logged to withdrawals.log with cause 'walk', removed from partition counts, and its wip rows are dropped, even though the venue still lists it.

**Evidence.** Code trace confirmed by the verifier (queries.ts:129 `const offered = new Set(files.map(f => f.path))`; the withdrawal loops in the range branch and in vacated()). It triggers after an exclusion is added, an accepts rule is tightened (e.g. binance 1w/3d/1mo), or an adapter stops placing a shape.

**Fix.** Add optional `listed?: ReadonlySet<string>` to putFiles (default `offered`), built in survey.ts from `listed.map(e => relative(adapter, e.key))` before filtering. Use it only for withdrawal judging (range branch and vacated()). Keep `offered` in dropParked, so parked rows for now-filtered paths are still dropped. If policy-refused files should leave the catalog, use a separate cause (e.g. 'excluded') rather than a venue withdrawal.

**Tests to add.** Catalogue a path, then walk a page listing it where accepts() refuses it: existence unchanged, no withdrawal note. A path genuinely absent from the page is still withdrawn.

**Verifier notes.** Confirmed medium; deferred because it changes putFiles' contract and needs a policy decision.

**Owner question.** What should happen to an already-catalogued file that the reader now declines (excluded, refused by accepts, or no longer placed)? Leave it untouched, or remove it under a distinct non-venue cause such as 'excluded'?

### PRC-05: Hand-written BEGIN/ROLLBACK blocks mask the original error (auto-rollback and post-commit failures)

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/database/open.ts:79-93`
  - `services/prospector/src/catalog/queries.ts:208`
  - `services/prospector/src/catalog/queries.ts:355`
  - `services/prospector/src/catalog/queries.ts:423`
  - `services/prospector/src/catalog/queries.ts:472-505`
  - `services/prospector/src/catalog/queries.ts:535`
  - `services/prospector/src/catalog/queries.ts:728`
  - `services/prospector/src/catalog/queries.ts:804-831`
  - `services/prospector/src/catalog/queries.ts:990`
  - `services/prospector/src/catalog/queries.ts:1878`
  - `services/prospector/src/catalog/series.ts:304`
  - `services/prospector/src/catalog/series.ts:723-736`
  - `services/prospector/src/catalog/wip.ts:219`
  - `services/prospector/src/catalog/wip.ts:249`
  - `services/prospector/src/catalog/wip.ts:282`
  - `services/prospector/src/catalog/wip.ts:499`
  - `services/prospector/src/catalog/wip.ts:623`

**Problem.** Every write path repeats `BEGIN; try {...; COMMIT} catch { ROLLBACK; throw }`, 14 copies in catalog/ plus open.ts. (1) SQLite rolls back by itself on SQLITE_FULL, IOERR, NOMEM and RAISE(ROLLBACK). The explicit ROLLBACK then throws 'cannot rollback - no transaction is active', which replaces the real cause; migrate() would report 'Migration N failed: cannot rollback...'. (2) withdrawFile and settleFiles COMMIT and then, inside the same try, run noteWithdrawals, wip.counted and sawFile. sawFile can call flushTips synchronously (FLUSH_AT=1000) with its own transaction. If that throws, the catch issues ROLLBACK with no transaction open, masks the error, reports a committed batch as failed, and skips the remaining post-commit steps. The copies also differ slightly from each other (joining, notes clearing).

**Evidence.** Reproduced: a RAISE(ROLLBACK) trigger inside the pattern surfaces 'cannot rollback - no transaction is active' with db.isTransaction false. The post-commit shape was read at queries.ts:472-505 and ~804-830. @types/node ^25.9 types isTransaction, so the `(db as {isTransaction?})` casts are unnecessary.

**Fix.** Add catalog/tx.ts: `inTransaction<T>(db, work, { join = false } = {}): T`. If join and db.isTransaction, run work(). Otherwise run BEGIN, then work(), then COMMIT. On error, `if (db.isTransaction)` ROLLBACK inside its own try, attach any rollback failure as `cause`, and rethrow the original. Replace all blocks, keeping caller cleanup (e.g. putFiles' `notes.length = 0`) in a try around the call. Use join:true for flushTips and wip.write instead of the casts. In withdrawFile and settleFiles, move all post-commit work (noteWithdrawals, wip.counted, the sawFile loop) after the transaction call, so it fails as itself. Use the helper (or at least the isTransaction guard) in open.ts migrate.

**Tests to add.** Helper: a table with a RAISE(ROLLBACK,'boom') trigger; inTransaction rejects with 'boom'. A migration whose sql fires the trigger reports 'Migration N (...) failed: boom'. settleFiles with flushTips spied to throw: the thrown error is the original and the file rows are committed.

**Verifier notes.** Merges lens1 F8 (post-commit, low) and lens2 F3 (auto-rollback, medium); both were confirmed with implement=yes.

### PRC-06: In-memory registries go stale: addTransform, retirePattern, loadSeries

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/catalog/transform.ts:47`
  - `services/prospector/src/catalog/transform.ts:117-142`
  - `services/prospector/src/catalog/series.ts:824-826`
  - `services/prospector/src/catalog/series.ts:1314-1316`
  - `services/prospector/src/catalog/series.ts:333-338`
  - `services/prospector/src/catalog/series.ts:754-768`
  - `services/prospector/src/catalog/series.ts:1210-1217`

**Problem.** (a) Series attach the array transformsOf returned, but addTransform replaces the map entry with a new array, so existing series keep generating keys from the old (or undefined) list until a reload. That contradicts its doc ('the next key generated rather than the next process'). (b) retirePattern updates loaded series rows but not held.patterns, so patternIdOf keeps returning retiredAt null and a series recorded on the shape afterwards is live. (c) loadSeries on a live registry discards had.moved without flushing, losing unflushed bounds. All latent today: addTransform's only caller runs before the instrument's series exist, retirePattern has only test callers, and loadSeries' src caller only runs on an empty registry. Tests mask (b) by calling loadSeries afterwards.

**Evidence.** Repro pc-transform.js: keyFor stays 'depth/ABCUSDT/...' after addTransform and becomes 'depth/XYZ_D2/...' only after loadSeries. Code read at series.ts:333-338 (no held.patterns update) and 754-764.

**Fix.** (a) Export a series.ts helper `reattachTransforms(db, venueId, market, symbol)` that sets `row.transforms = transformsOf(...)` (or deletes the field) on every registry series of that instrument, and call it at the end of addTransform. Mutating in place does not cover the 'no array before' case. Avoid a transform.ts to series.ts import cycle through a catalog/index.ts wrapper or a callback. (b) In retirePattern, also set retiredAt = at on every registry(db).patterns entry whose id === patternId. (c) In loadSeries, call flushTips(db) when `had` exists and had.moved.size > 0 before replacing the registry. Longer term, see the assessment: one per-database state object.

**Tests to add.** New tests/transform.test.ts: recordSeries, then addTransform, then keyFor uses the transform without a reload; a named dataset beats '' in either write order; from_/to_ are inclusive; a monthly stamp matches a daily-width row. series.test: retirePattern, then recordSeries a new symbol on the shape without loadSeries, expect retiredAt === at. A moved tip survives loadSeries.

**Verifier notes.** Merges lens1 F9 and lens2 F2 and the stale-cache half of lens2 F13. All confirmed; verifiers rate it low because latent. Kept at medium because the exported contracts are wrong and the failure is silent. Not in scope but noticed: preamble skips instruments with active series, so a directory move for a known instrument never reaches addTransform.

### PRC-07: Migration docblocks: contradictory change policy, wrong htx date, gate header misses 18 shapes, venue facts restated

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/types.ts:1118-1124`
  - `services/prospector/src/database/migrations/index.ts:13-29`
  - `services/prospector/src/database/migrations/001-core.ts:5-13`
  - `services/prospector/src/database/migrations/002-htx.ts:16-21`
  - `services/prospector/src/database/migrations/005-gate.ts:1-34`
  - `services/prospector/src/database/migrations/006-binance.ts:9-25`

**Problem.** (1) types.ts' Migration docblock says '**Frozen once it has shipped**'; migrations/index.ts says a change edits the migration it belongs to. These are opposite rules. (2) index.ts carries a plan ('until the project has a second developer...') and history (the fresh-catalog jump rationale). 001-core, 002-htx ('This replaced a pass that ran on every startup') and 006-binance ('458 series ... fifteen probes a night') narrate history too. (3) 002-htx says htx 'wrote the last of data/ on that day' (2026-02-01). All 90 htx/pattern.csv rows retire at 20260804, and HTX.md says data/ ran to 2026-08-04, overlapping historical_data/ from 2026-02-01. (4) 005-gate describes only 'the three shapes gate used for exactly one hour'; gate/pattern.csv rows 4-21 are 18 month-literal spot candlesticks_{1m,5m,30s}/2024MM shapes it never mentions. 005 and 006 restate venue facts that belong in docs/venues/*.md.

**Evidence.** Both lenses' verifiers checked the files. The line numbers in lens2 were wrong (the files are 27-53 lines long); corrected locations above.

**Fix.** State the policy once in migrations/index.ts: 'edit the migration a change belongs to; the live catalog is brought to match by running the same statements by hand, user_version included.' Replace types.ts:1120-1123 with a pointer to database/migrations/index.ts. Move the 'until a second developer / production deployment' plan to docs/planning/. Delete the history sentences (index.ts:16-19, 001-core.ts:10-11 keeping that CATALOG_SCHEMA is IF NOT EXISTS, 002-htx.ts:19-21, 006-binance.ts:24-25). 002-htx: '`historical_data/` began on 2026-02-01; `data/` was last written on 2026-08-04, the date these shapes are retired at', or point to docs/venues/HTX.md. Cut 005-gate and 006-binance to what each migration does (retires the shapes in its seed at the dates recorded there; see docs/venues/GATE.md / BINANCE.md). 005 must cover both groups (the three 202212 order-book shapes holding 2022-11-30 23:00 and the 18 2024-07..12 candlestick month directories), or stay generic. Check that GATE.md documents the candlestick retirement before removing the detail.

**Tests to add.** None (docs).

**Verifier notes.** Merges lens1 F12(a-c) and lens2 F10; confirmed medium.

### PRC-08: Seeds README and seed.ts docblocks contradict the code and the shipped files

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/database/migrations/seeds/README.md:6-28`
  - `services/prospector/src/database/migrations/seeds/README.md:61-66`
  - `services/prospector/src/database/migrations/seeds/README.md:91`
  - `services/prospector/src/database/migrations/seeds/README.md:100-118`
  - `services/prospector/src/database/migrations/seeds/README.md:153`
  - `services/prospector/src/database/migrations/seeds/README.md:176-181`
  - `services/prospector/src/database/migrations/seeds/seed.ts:10-31`
  - `services/prospector/src/database/migrations/seeds/seed.ts:125-150`
  - `services/prospector/src/database/migrations/seeds/seed.ts:256-264`

**Problem.** (1) The series.csv example `1,$AIUSDT,,,,20180502` has 6 fields against a 5-name header; seed.ts throws 'has 6 fields, not 5'. (2) 'Series `state`. It defaults to `active`': series has no state column (instrument does). (3) The layout and opening cover only okx and bitget; binance, gate and htx ship pattern.csv retirement seeds (migrations 002/005/006). The README and seed.ts headers say seeds are for 'venues nothing can discover', yet three of five are walked. (4) Quoting is said to cover 'okx's ... and nothing else' (README and seed.ts:260-261); bitget quotes "snapshot,500" and gate "incremental,full". (5) seed.ts:17 'a directory, not a migration' contradicts README:27 'a directory and a one-line migration'; the README is right (MIGRATIONS has one per seeded venue). (6) 'Nothing ever raises a first' is false: reconcile sets first to what the files hold. (7) The floor/tip docblock (seed.ts:125-139) sits above the bundle check, not the prevPeriod call it explains, and it and README:113-115 narrate history. (8) seed.ts:31 says 'the venues migration'; it is `core`.

**Evidence.** head -1 okx/series.csv gives 'pattern_id,symbol,url_symbol,last,floor'. ls seeds/ gives binance bitget gate htx okx. seed.ts:248-250 is the field-count throw.

**Fix.** Rewrite README around the two kinds of seed: series seeds (okx, bitget: pattern.csv and series.csv, plus transform.csv for bitget) and retirement-only seeds (htx, gate, binance: pattern.csv with retired_at). List all five directories; drop the venue enumeration at :153. Fix the example to `1,$AIUSDT,,,20180502`. Replace the series-state bullet ('instruments are created `active`; not a column here'). Describe quoting generically (a field with a comma or quote is quoted; a doubled quote is literal) in the README and the seed.ts `fields` docblock. Replace 'Nothing ever raises a first' with: sawFile only lowers first; reconcile resets it to what the file table holds. seed.ts:17: 'Adding a venue is a directory and a one-line migration calling seed(db, "<venue>")'; reword the header to cover retirement-only seeds. Move the floor docblock above series.run and cut it to the rule (the file states a floor; the table stores tip = prevPeriod(floor, grain)), and drop the README history sentence. seed.ts:31 message: 'the core migration must run first'.

**Tests to add.** Optional: a seed.test case parsing every seeds/*/*.csv through the shared reader (see PRC-11).

**Verifier notes.** Merges lens1 F12(d) and lens2 F8; confirmed medium.

### PRC-09: Catalog/types docblocks describe queries, columns, fields and names that do not exist

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/catalog/queries.ts:12-13`
  - `services/prospector/src/catalog/queries.ts:605-630`
  - `services/prospector/src/catalog/queries.ts:1095-1104`
  - `services/prospector/src/catalog/queries.ts:1206`
  - `services/prospector/src/catalog/queries.ts:1228`
  - `services/prospector/src/catalog/wip.ts:133-172`
  - `services/prospector/src/catalog/series.ts:206-214`
  - `services/prospector/src/catalog/series.ts:718-723`
  - `services/prospector/src/catalog/series.ts:1319-1341`
  - `services/prospector/src/types.ts:502`
  - `services/prospector/src/types.ts:1328`
  - `services/prospector/src/types.ts:1339`
  - `services/prospector/src/types.ts:1995-2025`
  - `services/prospector/src/types.ts:2126-2129`
  - `services/prospector/src/types.ts:2172-2176`
  - `services/prospector/src/database/schema.ts:225-226`

**Problem.** (a) The unsettled() docblock claims date order, a (date, path) keyset and an absent filter; it delegates to wip.next: ORDER BY seq, numeric `after`, no existence filter. (b) The queries.ts header says 'Nothing else in either service writes SQL'; series.ts, wip.ts, transform.ts, partitions.ts, seed.ts and others do. (c) queries.ts:1206/1228 cite `completedEver` (a consumer's VenueStatus field) instead of the function everCompleted. (d) series.ts:212 cites `pattern.state`; the column is retired_at. (e) The Pattern interface (state: active|retired) and the prospector Venue interface are unused. (f) series.ts `Row extends Omit<Publishing,'found'> {found:number}` and the read() docblock describe a field and conversion that do not exist. (g) urlSymbol says NULL for 'every series of every venue here today'; bitget seeds 1,181 url_symbol values. (h) flushTips justifies joining a transaction with 'the seed migration is'; seed.ts never calls it. (i) 'the `venues` migration' (queries.ts:1104, seed.ts:31, types.ts:502) is `core`. (j) RunKind and the schema run.kind comment document a 'probe' kind nothing creates. (k) Orphaned docblocks: the Publishing doc above Transform, and the park doc above the PARKING constants.

**Evidence.** Verified item by item by both lenses' verifiers. catalog.test 'offers unsettled files in the order they were parked' asserts arrival order. kindOf (sync.ts:483) creates only walk/update.

**Fix.** unsettled(): 'Keys still owed an answer, in the order they were parked; `after` is the last `seq` returned (keyset documented on wip.next).' Drop or narrow the queries.ts 'Nothing else' sentence. completedEver becomes everCompleted. pattern.state becomes pattern.retired_at. Delete Pattern and Venue after a repo-wide grep. `type Row = Publishing` and drop the found paragraph. urlSymbol: 'NULL where the archive spells the instrument as the venue does; set where it does not (e.g. okx futures chains, bitget)'. flushTips: 'a caller may already be inside a transaction; the batch then joins it'. 'venues migration' becomes 'core migration' (also venues.ts:40, adapters/declare.ts:7 if in reach). Remove 'probe' from RunKind and the schema comment (keep Withdrawal.cause 'probe'); run tsc. Move the orphaned docblocks onto their declarations.

**Tests to add.** tsc after removing the types.

**Verifier notes.** Merges lens1 F12(e-h), lens2 F7 and lens2 F11. On (c), the verifier noted that completedEver exists as a consumer field, so renaming the comment is still right (a provider should cite its own function).

### PRC-10: Docblocks narrate history and incidents, carry stale figures, or explain providers by their consumers

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/catalog/serial.ts:10`
  - `services/prospector/src/catalog/series.ts:113-114`
  - `services/prospector/src/catalog/series.ts:535-536`
  - `services/prospector/src/catalog/series.ts:802`
  - `services/prospector/src/catalog/series.ts:1334-1336`
  - `services/prospector/src/catalog/wip.ts:14-17`
  - `services/prospector/src/catalog/wip.ts:304-310`
  - `services/prospector/src/catalog/wip.ts:365`
  - `services/prospector/src/catalog/wip.ts:646-653`
  - `services/prospector/src/catalog/queries.ts:778-782`
  - `services/prospector/src/catalog/queries.ts:1385-1395`
  - `services/prospector/src/catalog/queries.ts:1457`
  - `services/prospector/src/catalog/queries.ts:1810-1815`
  - `services/prospector/src/catalog/transform.ts:121-123`
  - `services/prospector/src/database/migrations/seeds/seed.ts:202-210`
  - `services/prospector/src/types.ts:1146`
  - `services/prospector/tests/seed.test.ts:31-34`
  - `services/prospector/vitest.config.ts:4-6`

**Problem.** CLAUDE.md forbids history ('was X, now Y') and motivating-incident framing, and requires providers to be explained on their own terms. Examples: 'Measured on the running service before this existed' (serial.ts), 'Before this module there were seven places writing to wip', 'What the upsert used to do on conflict', 'A walk used to state its own tips separately', 'this read used to lead with p.venue_id', '1,937,264 of them, 0.59%, before this was measured', 'the same false completeness claim that once closed binance', 'Nothing is deferred here now'. Consumer framing: seriesSeededAt (updatePage), addTransform (preamble), dropAbove (bitget floors), everCompleted ('the condition force-update turns on'). Stale figures: seed.test.ts '114,295 series', vitest.config.ts 'thirty-four thousand', types.ts:1146 'twelve thousand rows'; the seeded catalog has 43,965.

**Evidence.** grep for used to / no longer / before this / now that; select count(*) from series on a fresh seeded catalog gives 43965. Some lens2 line numbers were off (serial.ts text is at :10).

**Fix.** For each passage, keep the current rule and its present-tense reason, and delete the history. Keep rationales that still justify the design: e.g. series.ts:1334 becomes 'ordering by anything the index does not serve (e.g. p.venue_id first) forces a temp B-tree over every joined row, about 20x slower'; serial.ts keeps 'slices from every writer share one queue so the loop turns over between writers'. Rewrite provider docs: seriesSeededAt 'the date the venue's series seed was built, or null'; addTransform 'records a transform and makes it visible to the next key generated'; dropAbove 'deletes a series' backlog rows dated after date'; everCompleted 'whether the venue has ever finished a pass of the kind it is surveyed by'. Replace literal counts with 'tens of thousands', or compute them (seed.test has a seeded() helper). Do this in the same pass as PRC-07/08/09.

**Tests to add.** None.

**Verifier notes.** Merges lens1 F13 and lens2 F12; confirmed low, implement. Verifier: the seriesSeededAt 'Nothing else reads it' claim is not strictly wrong (survey.ts:1057 is plumbing); the real problem is consumer framing.

### PRC-11: Seed CSV reader: CRLF/BOM, unterminated quotes, no stamp-width validation, weak duplicate guard

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/database/migrations/seeds/seed.ts:71`
  - `services/prospector/src/database/migrations/seeds/seed.ts:110-123`
  - `services/prospector/src/database/migrations/seeds/seed.ts:150`
  - `services/prospector/src/database/migrations/seeds/seed.ts:165`
  - `services/prospector/src/database/migrations/seeds/seed.ts:241-253`
  - `services/prospector/src/database/migrations/seeds/seed.ts:265-295`
  - `services/prospector/tests/seed.contract.test.ts:26-60`

**Problem.** rows() does text.trim().split('\n') and header.split(','), with no CR or BOM handling. Under CRLF the last header becomes e.g. 'floor\r', so row.floor is undefined: every okx tip is planted NULL, okx `holds` defaults to 'instrument', and htx retired_at carries a CR. All of this is silent. A BOM corrupts the first header and gives a misleading 'does not define' error. Unterminated quotes and text after a closing quote are accepted. Values are never validated: an 8-digit floor on a monthly pattern gives shift('20260709',-1) and produces '208412'. The duplicate guard drops a same-symbol repeat even when last, floor or url_symbol differ. The repo has no .gitattributes.

**Evidence.** All shipped CSVs are LF with no duplicates, and okx/bitget floor and last widths match their grains, so this is hardening. Code path verified by both verifiers.

**Fix.** In the shared parser (see PRC-12's parseCsv): strip a leading '\uFEFF', split on /\r?\n/ (or normalise /\r\n?/g), trim header names, and keep ignoring unknown columns as the README requires. Throw `${label} line N: unterminated quote`, on any character other than ',' after a closing quote, and on an empty interior line. Validate: series floor and last must be digits of exactly WIDTH[shape.grain] characters; pattern.retired_at and transform date_from/date_to must match /^\d{6}(\d{2}){0,3}$/. Throw with venue/table/line. Duplicate guard: keep keying on `patternId + (url_symbol || symbol)` (deliberately stricter than series_key; do not change it), skip only exact repeats, and throw otherwise. Add `*.csv text eol=lf` to a root .gitattributes.

**Tests to add.** CRLF fixture plants the same rows as LF; BOM fixture parses; unterminated quote throws; wrong-width floor throws; a same-key row with a different floor throws; seed.contract asserts floor/last widths of every series.csv against grainOf(pattern).

**Verifier notes.** Merges lens1 F6 and lens2 F16; both confirmed low. Verifier rejected the suggestion to key the duplicate guard like series_key.

### PRC-12: Seed loader refusals and CSV quoting are untested; the contract test re-implements the parser differently

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/database/migrations/seeds/seed.ts:56-59`
  - `services/prospector/src/database/migrations/seeds/seed.ts:94-97`
  - `services/prospector/src/database/migrations/seeds/seed.ts:114-121`
  - `services/prospector/src/database/migrations/seeds/seed.ts:141-144`
  - `services/prospector/src/database/migrations/seeds/seed.ts:229-295`
  - `services/prospector/tests/seed.contract.test.ts:42-58`
  - `services/prospector/tests/seed.test.ts:265-271`

**Problem.** Every refusal path in seed() is uncovered (lines 31, 57, 95, 115-120, 142, 249, 278), and none can be tested because rows() reads only from __dirname. seed.contract.test.ts has its own `fields` that toggles on every quote, so `"a""b"` parses as `ab` there and `a"b` in seed.ts, despite its 'same quoting rule' claim. seed.test 'answers nothing for a venue with no seed at all' uses binance, which ships pattern.csv.

**Evidence.** Coverage JSON lists the uncovered statements. No shipped CSV contains '""', so the divergence is latent.

**Fix.** Export `parseCsv(text, label): Record<string,string>[]` from seed.ts and change the signature to `seed(db, venue, dir = __dirname)`. seed.contract.test imports parseCsv and deletes its copy. Rename the binance case to 'answers nothing for a venue whose seed holds no series'.

**Tests to add.** New tests/seed.loader.test.ts with mkdtemp fixture dirs: grain contradicting slots; a series pattern_id missing from pattern.csv; two symbols on one (pattern, spelling); '@' under a {SYMBOL} pattern; an instrument under a market-wide pattern; an exact repeat skipped; a missing transform.csv giving no rows; a field-count mismatch naming its line. parseCsv units: quoted comma, doubled quote, empty last field, plus the PRC-11 cases.

**Verifier notes.** Confirmed medium, implement.

### PRC-13: Migration tests pass regardless of the behaviour they name; migration rollback untested; read-only test fails as root

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/tests/catalog.test.ts:87-97`
  - `services/prospector/tests/catalog.test.ts:877-888`
  - `services/prospector/tests/catalog.test.ts:894-904`
  - `services/prospector/src/database/open.ts:57-93`
  - `services/prospector/src/database/open.ts:123`

**Problem.** 'applies nothing on a second open' calls migrate(again, false) after openCatalog already migrated, so it always returns 0. 'does not retry a declined seed on the next open' reopens with seedData:false, which can never seed, so the real claim (a later default open does not retry; a regression would throw 'No venue row for htx') is untested. The ROLLBACK branch (open.ts:87-91) is uncovered. 'refuses a catalog it cannot write' relies on chmod 0444, which root ignores.

**Evidence.** Coverage shows open.ts 88, 90 and 123 uncovered; the suite fails at catalog.test.ts:92 under root.

**Fix.** `migrate(db, seedData = true, chain: readonly Migration[] = MIGRATIONS)`, using chain.length in place of SCHEMA_VERSION inside it (the ahead-of-build check uses chain.length).

**Tests to add.** (1) A 2-step chain whose step 2 creates t2 and then throws in run: rejects /Migration 2 .* failed/, version stays 1, no t2. (2) openCatalog(path,{seedData:false}).close(), then openCatalog(path) default: no throw, version head, 0 series, no venue rows. (3) Second open: sqlite_master and venue counts unchanged, or a chain of vi.fn() runs that are not called. (4) `new DatabaseSync(file, { readOnly: true })` passed to assertWritable throws /read-only mount/ (portable for root).

**Verifier notes.** Confirmed medium, implement.

### PRC-14: Failure paths and several query functions have no tests

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/catalog/queries.ts:352-359`
  - `services/prospector/src/catalog/queries.ts:825-831`
  - `services/prospector/src/catalog/queries.ts:926-937`
  - `services/prospector/src/catalog/queries.ts:1309-1322`
  - `services/prospector/src/catalog/queries.ts:1416-1420`
  - `services/prospector/src/catalog/queries.ts:1678`
  - `services/prospector/src/catalog/wip.ts:470`
  - `services/prospector/src/catalog/wip.ts:510`
  - `services/prospector/src/catalog/wip.ts:586-593`
  - `services/prospector/src/catalog/series.ts:124-138`
  - `services/prospector/src/catalog/series.ts:1158-1162`
  - `services/prospector/src/lenses.ts:34-63`

**Problem.** No ROLLBACK branch in the unit executes (putFiles, markDownloaded, withdrawFile, correctFile, settleFiles, refinePartition, retireSeries, flushTips, wip.park/drop/missed/write). Promised behaviours go unexercised: parkSoon's FLUSH_ROWS trigger, 'a failed flush rejects every caller sharing it', flushParked joining a transaction, touch's FLUSH_AT flush, reconcile's yield, dropParked's `direct` filter, producedSoFar, resetRuns, seriesCounts, seriesOf, standingOf's 'not started'/'walking', and lenses.ts re-entrancy and error retry.

**Evidence.** Coverage-final.json uncovered statements as listed in the lens-2 review; confirmed by the verifier.

**Fix.** Test-only; do it in priority order after PRC-05 lands, since the rollback tests should exercise the new helper.

**Tests to add.** Priority: (a) putFiles rollback: a multi-slice page whose later file has a non-existent seriesId; earlier slices committed, partition counters equal the file aggregates, no withdrawals.log line for the failed slice, wip count equals the table. (b) parkSoon: FLUSH_ROWS flushes without timers; a failing flush rejects every waiter. (c) keepLensesCurrent: lensesChanged mid-round gives exactly one extra pass; a catchUp throw logs once and the next round runs. (d) settleFiles failing mid-batch leaves wip and counters unchanged. (e) producedSoFar, resetRuns, standingOf branches, dropParked direct=true, 1,001 sawFile calls flush.

**Verifier notes.** Confirmed medium; large but test-only.

### PRC-15: Binance docs misstate the coin-margined bookTicker end date (the seed is right)

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/venues/BINANCE.md:166-168`
  - `services/prospector/src/database/migrations/006-binance.ts:9-17`
  - `services/prospector/src/database/migrations/seeds/binance/pattern.csv:3-4`

**Problem.** 006-binance.ts and BINANCE.md say coin-margined quotes (bookTicker) end 2024-10-02 and that the shapes are seeded at those dates. The seed retires cm daily bookTicker at 20241014 and um monthly bookTicker at 202404. Both reviewers assumed the seed was wrong.

**Evidence.** Lens-1 verifier listed the live archive (data.binance.vision): cm daily bookTicker BTCUSD_PERP and ETHUSD_PERP end at 2024-10-14, and um monthly bookTicker BTCUSDT contains 2024-04 even though um daily ends 2024-03-30. So the seed is correct and the docs are wrong. The lens-2 verifier could not reach the bucket and deferred. The direct listing is decisive, so this is resolved in favour of the seed.

**Fix.** Leave pattern.csv unchanged; changing it to 20241002/202403 would stop generation before files that exist. In BINANCE.md, change the cm quotes end to 2024-10-14 (cm quotes and liquidations both end then), and note that the um monthly bookTicker tree holds 2024-04 although the daily tree ends 2024-03-30. Under CLAUDE.md, BINANCE.md must state these as venue facts only, naming no service. In 006-binance.ts, replace the restated dates with a pointer to BINANCE.md (as in PRC-07).

**Tests to add.** Optional: a seed test that each pattern row's retired_at width matches its grain.

**Verifier notes.** Merges lens1 F11 and lens2 F9. The verifiers disagreed (implement on the doc side vs defer); resolved by verifier 1's direct bucket listing. Implementer may re-list the bucket to double-check if network allows.

### PRC-16: establishedAt counts completed update runs as establishing the keyspace while walk partitions are open

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/catalog/queries.ts:1457-1470`
  - `services/prospector/src/survey.ts:110`
  - `services/prospector/src/collector.ts:326-330`
  - `services/prospector/src/sync.ts:550`

**Problem.** The outer query takes MAX(r.started) over completed runs at any ancestor scope with no kind filter, and the NOT EXISTS guard only checks open partitions of r.kind. A completed update's root row therefore claims the whole tree while a walk is still open, contradicting survey.ts:110 and the guard's own doc. On walked venues the daily update moves 'established' forward every day.

**Evidence.** Reproduced: beginJob(walk,['a/']) gives null; then beginJob(update,['1']) and clearUpdate give the update's start while the walk is open. Consumers are only /status and a log line, hence low.

**Fix.** `const kind = ranAny(db, venueId, 'walk') ? 'walk' : 'update'` (as everCompleted does); add `AND r.kind = ?` to the outer WHERE, bound after venueId; keep the guard's o.kind = r.kind.

**Tests to add.** (a) An open walk plus a completed update gives null. (b) A completed walk then a later update gives the walk's started. (c) An update-only venue gives the update's started.

**Verifier notes.** Confirmed; lowered medium to low.

### PRC-17: walkSeries gives a new series a tip in a period that has not closed

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/catalog/series.ts:406-430`
  - `services/prospector/src/catalog/series.ts:616-618`

**Problem.** A walk-created series' tip is `at > floor ? at : floor`, with no cap at lastClosed(grain, since). reconcile explicitly refuses tips in unclosed periods but only lifts, so it cannot undo this. Updates then skip re-asking that period until the next walk.

**Evidence.** Reproduced: since 2026-11-24T10:00Z, a new hourly series at '2026112410' gets tip '2026112410'; lastClosed is '2026112409'. Generated-key venues never reach walkSeries, so impact is low.

**Fix.** In walkSeries/walkEdge compute `closed = lastClosed(grain, since)` alongside floor and set `tip: at > floor ? (at < closed ? at : closed) : floor`. The existing monthly test (expects 202607 for 2026-08-01) still passes.

**Tests to add.** A new daily series from a file dated the walk's own day gets tip = lastClosed('daily', since); a new hourly series from the current hour gets the previous hour.

**Verifier notes.** Confirmed; lowered to low.

### PRC-18: reconcile deletes each empty series in its own autocommit transaction

- **Severity:** low
- **Category:** efficiency
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/catalog/series.ts:590-656`
  - `services/prospector/src/catalog/series.ts:1105-1117`

**Problem.** Each remove() runs DELETE outside any transaction, so each is a separate WAL commit with FK checks. Empty listed series are recreated and deleted on each pass (bitget ships 23k).

**Evidence.** Benchmark: 20,000 deletes took 1,439 ms autocommit and 192 ms in one transaction (synchronous=NORMAL, so CPU and WAL-frame cost).

**Fix.** Implement together with PRC-01 and PRC-05. Wrap each YIELD_EVERY chunk in inTransaction and commit before `await setImmediate`, plus once after the loop. Split remove() into dropRow(db,id) and forget(held,row), and apply the registry removals only after commit, so a failed chunk leaves memory matching disk. Keep flushTips outside the chunk transaction (or joining it).

**Tests to add.** reconcile on a venue with N empty series removes all; a forced mid-chunk failure leaves DB rows and seriesFor() unchanged.

**Verifier notes.** Confirmed; lowered medium to low.

### PRC-19: refinePartition progress() compares cursors in UTF-16 order instead of byte order

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/catalog/queries.ts:1907-1922`
  - `services/prospector/src/catalog/queries.ts:1545-1563`
  - `services/prospector/src/survey.ts:664-665`
  - `services/prospector/src/paths.ts:55`

**Problem.** progress() uses JS `>=` comparisons while the file defines byteOrder because SQLite/S3 order by bytes and UTF-16 disagrees past the BMP. With a supplementary-plane child beside an E000-FFFF sibling, a child can be judged wholly read and never recreated, silently losing keyspace. survey.ts divisible() has the same comparison.

**Evidence.** Code trace by the verifier; improbable inputs, one-line fix.

**Fix.** `if (byteOrder(cursor, ceiling(scope)) >= 0) continue; out.push([scope, byteOrder(cursor, scope) >= 0 ? cursor : null]);`. Change survey.ts divisible() to `children.some(c => byteOrder(cursor, ceiling(c)) < 0)`. Move byteOrder to paths.ts next to ceiling so both modules share it.

**Tests to add.** refinePartition with children ['x/\u{1F600}/','x/\uFF35/'] and a cursor inside 'x/\uFF35/...': the emoji child is recreated fresh; a child below the cursor in byte order is dropped.

**Verifier notes.** Confirmed low (reviewer confidence medium).

### PRC-20: Production-dead and test-only API in the catalog barrel

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/catalog/index.ts:1-71`
  - `services/prospector/src/database/index.ts:2-3`
  - `services/prospector/src/catalog/queries.ts:23-39`
  - `services/prospector/src/catalog/queries.ts:1160-1162`
  - `services/prospector/src/catalog/queries.ts:1503-1510`
  - `services/prospector/src/catalog/transform.ts:56-62`
  - `services/prospector/src/catalog/series.ts:292-322`
  - `services/prospector/src/catalog/series.ts:1367`

**Problem.** unenrol, unreadable, loadTransforms and _test_identity have no users. retireSeries, retirePattern and putVenue are test-only. The barrel re-exports dropAbove, sawFile, transformsOf, MIGRATIONS, CATALOG_SCHEMA, AT_CREATION and ON_OPEN with no importer (knip).

**Evidence.** knip --workspace services/prospector and grep, confirmed by the verifier.

**Fix.** Delete _test_identity and loadTransforms, and remove the unused re-exports after a repo-wide grep including tests and other services. Keep putVenue (a fixture used by six test files) and mark it as a fixture in its docblock. Keep retireSeries/retirePattern with the PRC-06 fix. Delete unenrol and unreadable only after the owner answers. Adding knip to CI is optional and separate.

**Tests to add.** tsc and the full prospector suite.

**Verifier notes.** lens2 F13 minus the stale-cache part (moved to PRC-06). Confirmed; lowered medium to low.

**Owner question.** Are unenrol and unreadable (the reader of the survey's unreadable-paths worklist) wanted by the upcoming missing functionality, e.g. an endpoint? If not, delete them.

### PRC-21: Existence type is wider than any table allows; dead null-handling of CatalogFile.seriesId

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/types.ts:1116`
  - `services/prospector/src/types.ts:1363`
  - `services/prospector/src/catalog/cache/partitions.ts:174-178`
  - `services/prospector/src/catalog/queries.ts:107-110`
  - `services/prospector/src/catalog/queries.ts:279-282`
  - `services/prospector/src/catalog/queries.ts:1614-1618`

**Problem.** Existence includes 'unknown', which is never assigned. file holds confirmed/absent and wip confirmed/assumed. partitions.count treats any non-confirmed state as withdrawn, so a ready 'assumed' CatalogFile would be counted as a withdrawal without a type error (unreachable today). CatalogFile.seriesId is `number` and series_id is NOT NULL, yet putFiles keeps COALESCE(excluded.series_id, file.series_id), `file.seriesId ?? was!.seriesId` and `file.seriesId === null`.

**Evidence.** grep "'unknown'" finds only Located.of; verifier confirmed survey.ts:1200 'assumed' never reaches putFiles.

**Fix.** Delete 'unknown'. Optionally split into FileExistence ('confirmed'|'absent') and WipExistence ('confirmed'|'assumed'). Make putFiles refuse (throw) a ready file that is not confirmed/absent. Use excluded.series_id and drop the COALESCE comment, the `?? was!.seriesId` and the `=== null` branch plus its docblock sentence. Run tsc and the tests.

**Tests to add.** tsc; optionally putFiles throws on an 'assumed' ready file.

**Verifier notes.** Confirmed low.

### PRC-22: openCatalog leaks its handle when migrate throws and decides freshness by file existence

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/prospector/src/database/open.ts:22-42`

**Problem.** If migrate() throws, the DatabaseSync handle is never closed (this matters for tests and embedders). `fresh = !existsSync(path)` treats a pre-existing zero-byte file (e.g. created by an operator or a volume mount) as existing, so auto_vacuum=INCREMENTAL is never set.

**Evidence.** Verifier reproduced: a zero-byte file opened without AT_CREATION reports auto_vacuum 0. The 'aborted earlier open' scenario is near-impossible (the file grows once the pragma runs).

**Fix.** After `new DatabaseSync(path)`, set `fresh = PRAGMA page_count === 0` (keep mkdirSync idempotent). Wrap the AT_CREATION/ON_OPEN pragmas and migrate in try/catch that calls db.close() and rethrows.

**Tests to add.** writeFileSync(path,''), then openCatalog(seedData:false): auto_vacuum is 2. user_version = head+1: openCatalog throws 'only knows' and DatabaseSync.prototype.close was called once.

**Verifier notes.** From lens2 F22, whose single verdict was 'uncertain' overall. The verifier split it: this open.ts part was CONFIRMED; the withdrawals-log and lenses-globals parts were refuted (see Rejected).

### PRC-23: Three indexes on the largest tables have no production reader

- **Severity:** medium
- **Category:** efficiency
- **Decision:** DEFER
- **Locations:**
  - `services/prospector/src/database/schema.ts:114-118`
  - `services/prospector/src/database/schema.ts:173-174`
  - `services/prospector/tests/catalog.test.ts:128-155`

**Problem.** file_when (venue_id, date), file_partition (partition_id) and revision_when (seen_at) are maintained on every write to file/revision (hundreds of millions of rows). No query in any service filters by them, and nothing deletes from partition, so file_partition is not needed for FK checks. Only raw-SQL tests touch them; the 'index seek' test never inspects a plan.

**Evidence.** grep across services/*/src and shared/*/src, confirmed by the verifier.

**Fix.** After owner confirmation: remove the three CREATE INDEX statements from the core migration, then on the live catalog run `DROP INDEX IF EXISTS file_when; DROP INDEX IF EXISTS file_partition; DROP INDEX IF EXISTS revision_when; PRAGMA incremental_vacuum;`. Replace catalog.test.ts:143-155 with a test of a real code path, and make the 128-141 test assert EXPLAIN QUERY PLAN uses the PK.

**Tests to add.** EXPLAIN-based test for the prefix range.

**Verifier notes.** Confirmed medium; deferred because it requires a live-DB change and knowledge of ad-hoc use.

**Owner question.** Do you use file_when, file_partition or revision_when for ad-hoc sqlite3 queries or operations (e.g. 'what changed since' through revision_when)? If not, may they be dropped from the schema and from the live catalog?

### PRC-24: seriesFor/patternsOf scan and copy every venue's series on each call

- **Severity:** low
- **Category:** efficiency
- **Decision:** DEFER
- **Locations:**
  - `services/prospector/src/catalog/series.ts:147-171`
  - `services/prospector/src/catalog/series.ts:215-227`
  - `services/prospector/src/preamble.ts:161`
  - `services/prospector/src/preamble.ts:342`

**Problem.** The registry has no per-venue index: seriesFor spreads all of byKey into an array, and patternsOf iterates all of it. The preamble calls patternsOf once per newly met instrument.

**Evidence.** About 0.9-1.1 ms/call on 44k series. The verifier notes retireSeries has no src callers, and many new instruments occur only on unseeded onboarding (about 1 s, once).

**Fix.** Cheapest: memoise patternsOf per market within one preamble call. Fuller: a byVenue index kept in sync in recordSeries/loadSeries/remove, best done as part of the per-database state object refactor. Do not build patternsOf from held.patterns (semantics differ).

**Tests to add.** seriesFor(venue A) never returns venue B rows after mixed inserts and removals.

**Verifier notes.** Confirmed; lowered to low, deferred.

**Owner question.** Is preamble latency on large unseeded venue onboarding a concern? If yes, choose between local memoisation now or a byVenue index within the registry/state refactor.

### PRC-25: Registry identities omit variant although one URL shape may publish into two slices

- **Severity:** low
- **Category:** correctness
- **Decision:** DEFER
- **Locations:**
  - `services/prospector/src/catalog/series.ts:1071-1086`
  - `services/prospector/src/catalog/series.ts:1197-1235`
  - `services/prospector/src/database/schema.ts:363-364`
  - `services/prospector/src/database/schema.ts:393`

**Problem.** pattern is UNIQUE(venue_id, slice_id, pattern), and slices differ by variant, but patternKey and identity omit variant. A shape reported under two variants would be filed under the first variant's slice. No shipped seed collides.

**Evidence.** The collision query on the seeded catalog returns []. 27 pattern strings differ only by market.

**Fix.** Preferred: enforce the invariant. Store variant in held.patterns (readPatterns selects c.variant) and throw on a patternIdOf hit with a mismatched variant. In seed.ts, refuse two pattern.csv rows with the same (market, dataset, bundle, pattern) and different variants. Alternative: add variant to patternKey, identity and the loadSeries key build.

**Tests to add.** Two Found with the same pattern and different variants are refused (or yield two series in two slices).

**Verifier notes.** Confirmed low; deferred as a model decision.

**Owner question.** Is a URL shape's identity independent of variant (enforce one variant per shape and refuse otherwise), or may one shape serve two variants (widen the registry keys)?

### PRC-26: queries.ts is a 1,932-line grab bag with duplicated SQL and three statement-cache schemes

- **Severity:** low
- **Category:** code-quality
- **Decision:** DEFER
- **Locations:**
  - `services/prospector/src/catalog/queries.ts:1-1932`
  - `services/prospector/src/catalog/queries.ts:91-117`
  - `services/prospector/src/catalog/queries.ts:533-561`
  - `services/prospector/src/catalog/queries.ts:1736-1748`
  - `services/prospector/src/catalog/wip.ts:214-243`
  - `services/prospector/src/catalog/wip.ts:618-664`
  - `services/prospector/src/catalog/series.ts:966-1006`
  - `services/prospector/src/catalog/serial.ts`

**Problem.** One module mixes file writes, run/job bookkeeping, survey enrolment, venues, unreadable paths and byte-order helpers. The revision INSERT appears twice, the ROW-by-path SELECT is prepared four times, wip.park and wip.write duplicate the PARKING loop, and statement caching is done three ways (queries statement(), series statements(), partitions PREPARED). Minor: a redundant scope filter in phaseOf, enrolment() called twice in standingOf, and serial.ts `slice` overloading a table name.

**Evidence.** wc -l and grep, confirmed by the verifier; no correctness or measured performance impact.

**Fix.** Now (safe, optional): hoist REVISE_SQL and ROW_BY_PATH to constants (do this as part of PRC-02). Defer: split into catalog/files.ts, runs.ts, enrolment.ts and venues.ts behind the index.ts barrel; route all prepares through one per-db cache (part of the per-database state object); implement wip.park via write; rename serial.ts slice.

**Tests to add.** Existing suite.

**Verifier notes.** Confirmed low; deferred.

**Owner question.** Do you want the catalog restructured before the new functionality lands: queries.ts split by subject plus a single per-database state object owning registries, counters and statement caches? If yes, agree the module boundaries first.

## Deferred: decisions needed

- **PRC-01** (IMPLEMENT): Optional follow-up, not blocking: should a series whose files are all withdrawn carry a marker (e.g. bounds reflecting 'no live files') distinct from 'never discovered'? Today first === null means the latter, so the fix leaves the bounds alone.
- **PRC-04** (DEFER): What should happen to an already-catalogued file that the reader now declines (excluded, refused by accepts, or no longer placed)? Leave it untouched, or remove it under a distinct non-venue cause such as 'excluded'?
- **PRC-20** (IMPLEMENT): Are unenrol and unreadable (the reader of the survey's unreadable-paths worklist) wanted by the upcoming missing functionality, e.g. an endpoint? If not, delete them.
- **PRC-23** (DEFER): Do you use file_when, file_partition or revision_when for ad-hoc sqlite3 queries or operations (e.g. 'what changed since' through revision_when)? If not, may they be dropped from the schema and from the live catalog?
- **PRC-24** (DEFER): Is preamble latency on large unseeded venue onboarding a concern? If yes, choose between local memoisation now or a byVenue index within the registry/state refactor.
- **PRC-25** (DEFER): Is a URL shape's identity independent of variant (enforce one variant per shape and refuse otherwise), or may one shape serve two variants (widen the registry keys)?
- **PRC-26** (DEFER): Do you want the catalog restructured before the new functionality lands: queries.ts split by subject plus a single per-database state object owning registries, counters and statement caches? If yes, agree the module boundaries first.

## Rejected

- **migrate reads user_version outside the migration transaction (TOCTOU between two openers)**: Mechanics are correct, but only one prospector process ever opens the catalog for writing (services/catalog opens it readOnly), and the window exists only at first creation. Not worth changing; if ever wanted, use BEGIN IMMEDIATE and re-read the version inside.
- **Partition version changes when only an ETag's letter case changes**: Refuted. The add/subtract of numberOf(etag) has to follow the stored string, or the additive version sum is corrupted. The one-time bump moves legacy upper-case rows toward the value a fresh catalog computes. The suggested fix would be harmful without a full recompute. Optional owner operation: lower-case legacy etags and recompute versions in one transaction, then drop sameTag's legacy branch.
- **noteWithdrawals attributes a multi-venue batch to the first venue**: Refuted in practice: every caller passes one venue with one fixed cause per event kind.
- **lenses.ts keeps loop state in module globals**: No defect: keepLensesCurrent is called exactly once by design, so cross-instance interference cannot occur.
