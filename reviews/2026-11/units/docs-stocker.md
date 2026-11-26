# Review consolidation: docs-stocker

## Overall assessment

All 28 findings from the docs lens were confirmed by the first verifier. No second verifier ran, because no finding was rated high or critical. The core design described in docs/services/STOCKER.md matches services/stocker/src: sweep decisions, revision and versions, the ledger markers, spill traits, unit inference, TRY_CAST, and the batch, piece and gather mechanics. The errors are in operational statements: where the engine spills (DSTK-02), concurrency (DSTK-11), the 'Caught up' reporting after skips for lack of room (DSTK-01), 'only writer' (DSTK-17), 'one file per instrument' (DSTK-03), 'ORDER BY ts' (DSTK-04), margin being constant per file (DSTK-18), and filters and bounds that do not exist (DSTK-10). STOCKER-PARTITIONS has wrong mapping claims and is missing binance aggregated trades. Its coverage claims are false: 31 of 104 series entries have no manifest fixture. The canonical schemas have no complete home. Several CLAUDE.md rules are broken: venue facts are documented in depth in two places and venue docs name Stocker; history and plans appear in tech docs; the README duplicates STOCKER.md; VOCABULARY contradicts STOCKER.md; and planning pointers are stale. Recommended restructure, which fits the user's request for a fresh start: (1) STOCKER.md describes the vault on its own terms: scope, path convention, a single canonical-tables section, time, spill, revision and versions, the ledger and vault-root contract, sweep outcomes, and a short Providers section. Cut the performance internals that build.ts, pack.ts, prepare.ts, zip.ts, project.ts and csv.ts docblocks already explain down to a sentence each with a pointer, and remove the history and incident framing. Target roughly 350-400 lines, down from 771. (2) STOCKER-PARTITIONS becomes a mapping reference only. Each venue and dataset gives format, era, source column to canonical field, unit and the series option that handles each quirk, and is marked verified (with its fixture) or unverified. The evidence moves to docs/venues/*.md. (3) The service README covers operations only: mounts, uid, the vault-root files, config, extension points and dev commands. (4) docs/planning/STOCKER.md is the one list of open stocker work. It takes in the caveats currently scattered through the tech docs: unverified entries, okx 2021-10 doubled trades, okx monthly funding, the settlement table, bybit MT4 truncated months, binance EOH hour, the bybit option leg, and the reporting gap for skips for lack of room. Margining plans live only in planning/CATALOG.md. Also in scope: VOCABULARY, DATA_PIPELINE, ROADMAP, planning/CATALOG, GATE.md and BITGET.md. Code docblocks are covered by CLAUDE.md and should be fixed in the same edit: tables.ts:24-29 margin wording, build.ts:625-626 spill, build.ts:429-431 'nothing else is being built'. Two small code changes keep the docs simple: move DuckDB's temp_directory under .stocker-tmp (DSTK-02), and count skips for lack of room separately (DSTK-01). An optional fixture-coverage test (DSTK-05) would stop the coverage claims drifting again.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| DSTK-01 | medium | docs+code | IMPLEMENT | A partition skipped for lack of extraction room is reported as 'not on disk' and the sweep still says 'Caught up' |
| DSTK-02 | medium | docs+code | IMPLEMENT | The engine spill is in <vault>/.duckdb-tmp, not .stocker-tmp, and nothing ever clears it; three docs say otherwise |
| DSTK-03 | medium | docs | IMPLEMENT | 'The vault holds one file per instrument' contradicts the @ bundle layout (STOCKER.md, DATA_PIPELINE.md) |
| DSTK-04 | medium | docs | IMPLEMENT | 'Every file is written ORDER BY ts' and 'ts is the sort key of every file' are wrong for @ bundles and book tables |
| DSTK-05 | medium | docs | IMPLEMENT | Coverage claims ('every entry written from a decoded file', 'mapping.test.ts drives every series') are false: 31 of 104 series entries have no fixture |
| DSTK-06 | medium | docs | IMPLEMENT | ROADMAP and planning/CATALOG point at planning/STOCKER for work that has landed; planning/STOCKER names a nonexistent `symbol=` level and leaves out real open items |
| DSTK-07 | medium | docs | IMPLEMENT | Canonical schemas have no complete home; the column lists omit margin, four tables are missing, and the unproduced `settlement` table is listed |
| DSTK-08 | medium | docs | IMPLEMENT | README duplicates STOCKER.md yet lacks the vault-root storage contract it is said to hold; missing operational details |
| DSTK-09 | medium | docs | IMPLEMENT | Venue format facts and the evidence for them are written in full in both STOCKER-PARTITIONS and docs/venues; GATE.md and BITGET.md name Stocker |
| DSTK-10 | medium | docs | IMPLEMENT | STOCKER.md describes table and symbol filters that do not exist |
| DSTK-11 | medium | docs | IMPLEMENT | The concurrency model is out of date: partitions share one connection pool and run side by side |
| DSTK-12 | medium | docs | IMPLEMENT | 'The monthly per-instrument rendering [of okx funding] is not mapped' is false: the same entry reads it and rank() prefers it |
| DSTK-13 | medium | docs | IMPLEMENT | okx swap trades for 2021-10, published with every trade twice, are stocked as published and no stocker doc says so |
| DSTK-14 | medium | docs | IMPLEMENT | Binance aggregated trades are stocked but missing from STOCKER-PARTITIONS |
| DSTK-15 | low | docs | IMPLEMENT | Layouts and example queries omit the depth= and aggregated= levels; the copied query finds no files |
| DSTK-16 | low | docs | IMPLEMENT | VOCABULARY's Revision and Chain definitions contradict STOCKER.md |
| DSTK-17 | low | docs | IMPLEMENT | 'Stocker is the vault's only writer' contradicts backedup.csv and the cold tooling docs |
| DSTK-18 | low | docs | IMPLEMENT | Margin is called 'a constant per file' (it is per instrument), and the list of tables carrying it omits orderBookSnapshot |
| DSTK-19 | low | docs | IMPLEMENT | Container claims ('covers Bybit and Gate entirely', 'Only .zip and .tar.gz are extracted', the README decode list) are inaccurate |
| DSTK-20 | low | docs | IMPLEMENT | Tech docs contain history, plans and future tense, and frame sections around the incidents that motivated them |
| DSTK-21 | low | docs | IMPLEMENT | STOCKER-PARTITIONS has a duplicated liquidations paragraph, contradicts itself on okx spill, merges eras in the htx rows, and mislabels a section |
| DSTK-22 | low | docs | IMPLEMENT | The revision inputs are listed incompletely; the ledger-check description is imprecise; repair timing is incomplete |
| DSTK-23 | low | docs | IMPLEMENT | 'The series declares 1m' is wrong for okx and bitget klines: the interval is the catalog's variant |
| DSTK-24 | low | docs | IMPLEMENT | README says containers register in containers/index.ts; the registry is containers/registry.ts and keys.ts must change too |
| DSTK-25 | low | docs | IMPLEMENT | STOCKER.md uses 'slice', 'partition' and 'dataset' with vault meanings that VOCABULARY does not define |
| DSTK-26 | low | docs | IMPLEMENT | The architecture table is missing the modules that do most of the work |
| DSTK-27 | low | docs | IMPLEMENT | STOCKER.md does not say how stocker uses its providers (the catalog request, headers, retries, the archives layout) |
| DSTK-28 | low | docs | IMPLEMENT | Small internal inconsistencies and a misplaced paragraph in STOCKER.md |

## DSTK-01 — A partition skipped for lack of extraction room is reported as 'not on disk' and the sweep still says 'Caught up'

- **Severity:** medium  
- **Category:** docs+code  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F3

**Locations:**

- `docs/services/STOCKER.md:421-428`
- `docs/services/STOCKER.md:747-760`
- `services/stocker/src/scan.ts:473`
- `services/stocker/src/scan.ts:501`
- `services/stocker/src/scan.ts:536-548`
- `services/stocker/src/scan.ts:838-843`
- `services/stocker/src/scan.ts:182-217`
- `services/stocker/src/types.ts:443-470`

**Problem.** STOCKER.md says a lack of space never reads as 'caught up', and that a partition that does not fit is skipped with a warning. In the code, when fits() fails in decide, the loop continues, then falls through to summary.missing++. It logs 'Its archives are not on disk as the catalog has them — skipped', which is false here. On the completes path (scan.ts:473) it ends up as 'Spill pending' and partial++ instead. A NoRoom thrown inside stock() is counted nowhere. report() then prints 'Caught up'. Only LowSpace (the volume floor) sets stopped.

**Evidence.** scan.ts:501 `if (! await fits(...)) continue;` → scan.ts:536 `summary.missing++` and :548 'not on disk' log; scan.ts:839 NoRoom branch skips `summary.failed++`.

**Fix.** Code (bounded, matches the doc's intent): add `noRoom: number` to Summary (types.ts) and initialise it at scan.ts:65-67. In decide, set a flag when fits() returns false at :473 or :501. After the rendering loop and before the partial and missing branches, if no rendering was chosen and the flag is set, increment summary.noRoom and return null. In stock(), increment summary.noRoom in the NoRoom branch (:839). In report(), warn 'N partitions skipped for want of room to extract, rescanning in M minutes' after the stopped check, and never print 'Caught up' when noRoom > 0. Docs: add an outcome-table row 'skipped for want of room to extract — a warning naming the count, never "caught up"' and label the existing row as the volume floor (STOCKER_MIN_FREE_GB).

**Tests.** report.test.ts: noRoom > 0 produces the warning and no 'Caught up'. sweep.test.ts: a shortOf shortfall gives noRoom === 1 and missing === 0, with no 'not on disk' log line. Update existing Summary literals in tests for the new field.

**Verifier notes.** The verifier confirmed this. The per-partition NO_ROOM warning that STOCKER.md:425-426 describes does exist; the summary is what is wrong.

## DSTK-02 — The engine spill is in <vault>/.duckdb-tmp, not .stocker-tmp, and nothing ever clears it; three docs say otherwise

- **Severity:** medium  
- **Category:** docs+code  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F1

**Locations:**

- `docs/services/STOCKER.md:495-499`
- `services/stocker/README.md:66-68`
- `services/stocker/src/db.ts:27`
- `services/stocker/src/db.ts:36`
- `services/stocker/src/build.ts:625-647`
- `services/stocker/src/containers/index.ts:17`
- `services/stocker/src/index.ts:54-59`

**Problem.** STOCKER.md, the README and the sweepScratch docblock say the extraction, the staging and the engine's spill all live in .stocker-tmp, which is cleared at startup. db.ts sets temp_directory to <vault>/.duckdb-tmp, which sits beside .stocker-tmp, and nothing ever removes it. The README also leaves out that finished pieces under stage/ survive the clear.

**Evidence.** db.ts:27 `const spill = join(config.vaultDir, '.duckdb-tmp');` (checked again during consolidation). SCRATCH = '.stocker-tmp' (containers/index.ts:17). `.duckdb-tmp` appears nowhere else in the repo.

**Fix.** Code: in db.ts:27 use `join(config.vaultDir, SCRATCH, 'spill')`, importing SCRATCH from './containers', and keep the mkdir. This is safe because index.ts:54 runs sweepScratch() before open() at :59, and sweepScratch clears everything in .stocker-tmp except stage/. STOCKER.md:495-499 and the build.ts docblock are then true as written. Rewrite README:66-68: 'Everything transient (archive extraction, partitions being built, the query engine's spill) lives in <vault>/.stocker-tmp. It is cleared at startup, except for pieces of a partition already built, which the next build takes up.' Put the one-off removal of an existing <vault>/.duckdb-tmp in the commit message, not in the docs.

**Tests.** Show that open() creates the spill under .stocker-tmp/spill, and that sweepScratch removes a file planted in .stocker-tmp/spill while keeping a finished piece under stage/.

**Verifier notes.** The verifier checked the startup order, so the code change is safe. Hard-kill leftovers count against STOCKER_MIN_FREE_GB, so medium holds.

## DSTK-03 — 'The vault holds one file per instrument' contradicts the @ bundle layout (STOCKER.md, DATA_PIPELINE.md)

- **Severity:** medium  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F5

**Locations:**

- `docs/services/STOCKER.md:371-374`
- `docs/services/STOCKER.md:63-65`
- `docs/DATA_PIPELINE.md:103-108`
- `services/stocker/src/vault.ts:25-35`

**Problem.** A month under 1 GB of archives is one file under `@` holding every instrument; by STOCKER.md's own count that is 13,209 of 15,084 months. DATA_PIPELINE also says a month is 'built whole, never appended to', but a side file is added beside a month when a neighbour arrives later. DATA_PIPELINE:103-104 also calls ts 'the sort key of every partition', which is the same error as DSTK-04.

**Evidence.** vault.ts:30-32: 'A small one is a single file holding every instrument, under `@`. A large one is a file per instrument'.

**Fix.** STOCKER.md:371-374: 'Each vault file names its instruments in its symbol column. Where a file of the archives holds several instruments (a market-wide bundle, a futures chain), the series names the column that says which (instrument), and the rows are split by it: the file is read once into a temporary table, then written out by instrument.' DATA_PIPELINE.md:106-108: 'The partition (a month of a dataset) is the unit of work: stocked whole from its archives and stocked again whenever anything it was built from changes. How it is laid out in files is in services/STOCKER.md#path-convention.' DATA_PIPELINE.md:103-104: replace 'the sort key of every partition' with 'the time order of each instrument's rows'.

**Tests.** None (docs).

**Verifier notes.** Confirmed. The verifier found the extra DATA_PIPELINE sort-key error.

## DSTK-04 — 'Every file is written ORDER BY ts' and 'ts is the sort key of every file' are wrong for @ bundles and book tables

- **Severity:** medium  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F6

**Locations:**

- `docs/services/STOCKER.md:631-632`
- `docs/services/STOCKER.md:672-676`
- `docs/services/STOCKER.md:80`
- `services/stocker/src/build.ts:419-424`
- `services/stocker/src/build.ts:740`
- `services/stocker/src/build.ts:912-913`

**Problem.** A whole month is ordered by symbol first. Tables with a `sequence` column are ordered by `ts, sequence`. The doc contradicts its own line 80 and the code.

**Evidence.** build.ts:912-913 orderOf returns 'ts, sequence' when a sequence column exists; build.ts:740 `ORDER BY symbol, ${orderOf(key)}`.

**Fix.** STOCKER.md:631-632: 'One canonical unit: int64 microseconds since epoch, UTC, in a column named ts. An instrument's rows are in ts order (ts, sequence for tables that carry the venue's sequence), and a file holding a whole month is ordered by symbol first.' STOCKER.md:672: 'Every file is written in that order, and the sort stays.' Keep the ~9% measurement as a present-tense rationale, because the code does not record it (see DSTK-20).

**Tests.** None (docs).

**Verifier notes.** Confirmed.

## DSTK-05 — Coverage claims ('every entry written from a decoded file', 'mapping.test.ts drives every series') are false: 31 of 104 series entries have no fixture

- **Severity:** medium  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F12

**Locations:**

- `docs/services/STOCKER.md:567-569`
- `docs/services/STOCKER.md:735-743`
- `docs/services/STOCKER-PARTITIONS.md:83-86`
- `services/stocker/src/schema/series.ts:7-11`
- `services/stocker/tests/fixtures/manifest.json`

**Problem.** STOCKER-PARTITIONS itself marks bybit premiumIndex and indexPrice with Sym '?', and says htx's pre-2026-02 perp mark and index entries were 'mapped from the published header names, not yet seen in a file'. mapping.test.ts iterates the manifest's fixtures, not SERIES. Many of the 31 uncovered entries are books, which books.test.ts covers, or siblings built by the same map(). But bybit perp inverse trades, bybit perp premiumIndex, bybit spot indexPrice and htx perp mark and index before 2026-02 are not exercised by any test.

**Evidence.** Script reviews/2026-11/units/scratch/cover-stocker.cjs prints 'series 104 covered 73'. The verifier re-ran it and got the same result.

**Fix.** STOCKER.md:567-569: 'mapping.test.ts drives each series that has a fixture against a real file from the venue (books in books.test.ts) and asserts the projected values.' Coverage (~735-737): drop 'Every entry was written from a decoded file …', and say that entries are written from decoded files except those STOCKER-PARTITIONS marks unverified. In STOCKER-PARTITIONS, replace the '?' cells and 'not yet seen in a file' with one consistent marker, 'unverified — no file decoded'. Add one docs/planning/STOCKER.md item listing those entries.

**Tests.** Optional: a schema or mapping test that fails when a SERIES entry has no fixture (manifest or books.test.ts) and is not on an explicit allow-list. The allow-list then is the unverified list.

**Verifier notes.** Confirmed. The 'unverified' marker is a statement about today, so it stays in the tech doc. Only the work to verify the entries goes to planning (this reconciles with DSTK-20).

## DSTK-06 — ROADMAP and planning/CATALOG point at planning/STOCKER for work that has landed; planning/STOCKER names a nonexistent `symbol=` level and leaves out real open items

- **Severity:** medium  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F22

**Locations:**

- `docs/ROADMAP.md:135-136`
- `docs/planning/CATALOG.md:11-12`
- `docs/planning/CATALOG.md:26`
- `docs/planning/CATALOG.md:58`
- `docs/planning/STOCKER.md:13-17`
- `docs/planning/STOCKER.md:26-28`
- `docs/services/STOCKER-PARTITIONS.md:39`
- `docs/services/STOCKER-PARTITIONS.md:256-257`

**Problem.** (1) ROADMAP says order books have no series mapping, but series.ts maps books for binance, bybit, htx, gate, okx, kucoin and bitget, and planning/STOCKER never mentions books. (2) planning/CATALOG says moving stocker onto the catalog is still to do, but catalog.ts and disk.ts already use the catalog API and hauler's layout. (3) planning/STOCKER:13 refers to a `symbol=` level; there is none, the symbol folders are bare. (4) The margining plan sits in two planning docs with different wording. (5) The bybit option `amount` question appears in both planning and STOCKER-PARTITIONS.

**Evidence.** series.ts has orderBook, orderBookSnapshot and orderBookBands entries (lines ~360, 476, 636, 703-734, 828, 851, 902). catalog.ts:22-29 calls /venues/:venue/partitions. disk.ts:9-21 gives the FL/symbol/YYYYMM layout.

**Fix.** ROADMAP.md:135-136: '**Archives are done**; what is left of them is in [planning/STOCKER.md](planning/STOCKER.md).' Do NOT claim every catalog dataset is mapped. planning/CATALOG.md: delete 11-12, and in step 4 (:58) drop 'then stocker ([STOCKER.md](STOCKER.md))'. Keep the cold-scripts clause only after checking whether the cold-push code already reads hauler's layout. planning/STOCKER.md:13: 'The vault's `symbol` column holds the venue's own string'. Margining: the plan lives in planning/CATALOG.md#instruments-as-an-entity, and planning/STOCKER.md:16-17 becomes one pointer line. Bybit `amount`: the open question stays in planning, and STOCKER-PARTITIONS:39 says only '`amount`, as published'. Make planning/STOCKER.md the single open-work list: unverified series (DSTK-05), okx 2021-10 doubled trades (DSTK-13), okx monthly funding verification (DSTK-12), the unproduced `settlement` table if kept (DSTK-07), bybit MT4 truncated months, binance EOH hour, the margin stopgap (DSTK-18), and the room-skip reporting gap if DSTK-01 code is not done.

**Tests.** None (docs). Check with grep that no doc still points at planning/STOCKER for book mappings or for catalog migration.

**Verifier notes.** Confirmed. The verifier rejected the reviewer's proposed ROADMAP wording ('mapped for every venue and dataset'), which is unverified and probably false.

## DSTK-07 — Canonical schemas have no complete home; the column lists omit margin, four tables are missing, and the unproduced `settlement` table is listed

- **Severity:** medium  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F8

**Locations:**

- `services/stocker/README.md:30-31`
- `docs/services/STOCKER.md:571-573`
- `docs/services/STOCKER.md:621-625`
- `docs/services/STOCKER-PARTITIONS.md:3-4`
- `docs/services/STOCKER-PARTITIONS.md:29`
- `docs/services/STOCKER-PARTITIONS.md:57-58`
- `docs/services/STOCKER-PARTITIONS.md:77`
- `docs/services/STOCKER-PARTITIONS.md:93`
- `docs/services/STOCKER-PARTITIONS.md:102`
- `docs/services/STOCKER-PARTITIONS.md:154`
- `services/stocker/src/schema/tables.ts:32-245`
- `services/stocker/src/types.ts:6`

**Problem.** The README and STOCKER-PARTITIONS both say STOCKER.md holds the canonical schemas, but it lists only table names, plus columns for the book kinds. The STOCKER-PARTITIONS 'Canonical:' lines omit `margin`. There are no lists for borrowing, openInterest or liquidations. `settlement` is defined in tables.ts, but no series produces it (series.ts produces 16 distinct tables).

**Evidence.** tables.ts trades ends with MARGIN; STOCKER-PARTITIONS:29 omits it. A grep of series.ts finds no `table: 'settlement'`.

**Fix.** Add one 'Canonical tables' section to STOCKER.md listing, for each table a series writes, the columns in tables.ts order, prefixed by `symbol` (written first by build.ts:368), with `margin` last where present, and the path levels each carries. Drop `settlement` from STOCKER.md:573. In STOCKER-PARTITIONS, replace each 'Canonical:' line with a link to the section, keeping only semantics that are not column lists (taker `side`, funding `kind=`). Point README:30-31 at the new anchor. Whether to delete `settlement` from tables.ts and types.ts is in Deferred; if it is kept, note it in planning.

**Tests.** Optional schema.test.ts check: every key of TABLES is produced by at least one SERIES entry (or is allow-listed).

**Verifier notes.** Confirmed. The verifier corrected the reviewer: `symbol` IS documented ('The symbol is a column of every file', STOCKER.md:78-110), so only margin and the missing tables are real gaps. The verifier also noted that orderBookSnapshot is missing from the margin list; that is handled in DSTK-18.

## DSTK-08 — README duplicates STOCKER.md yet lacks the vault-root storage contract it is said to hold; missing operational details

- **Severity:** medium  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F28

**Locations:**

- `services/stocker/README.md:1-68`
- `docs/services/STOCKER.md:770-771`
- `services/stocker/docker/compose.yml`
- `services/stocker/src/ledger.ts:11-13`

**Problem.** STOCKER.md:770-771 says the storage contract is in the README, but the README covers only the mounts, the uid and .stocker-tmp. It never names ledger.csv, backedup.csv or ERROR.log. README:1-54 repeats STOCKER.md's intro, scope, layout and SQL example, and the layout copy has already drifted (DSTK-15). It also leaves out LOG_LEVEL, TZ and the /health endpoint on port 3000.

**Evidence.** README:48-54 is identical to STOCKER.md:105-111. ledger.ts:11-13 lists the three root files. The compose healthcheck curls localhost:3000/health.

**Fix.** Cut the README to: one paragraph saying what stocker is, with links to STOCKER.md and STOCKER-PARTITIONS.md; Storage (the two mounts, uid 1000, and a table of vault-root entries); Configuration (the existing table, plus LOG_LEVEL, TZ and /health on :3000); Extending (with DSTK-24); Development. Vault-root table: ledger.csv (stocker writes it, append-only, never edit it); backedup.csv (written by whoever keeps a copy elsewhere, read by stocker); ERROR.log (written by stocker on a loss, removed only by a person as an acknowledgement); .stocker-tmp (extraction, staging and, after DSTK-02, the engine spill; cleared at startup except for finished pieces). Remove 'What it does' and 'Layout'. Change STOCKER.md:770-771 to match where the contract actually lives.

**Tests.** None (docs).

**Verifier notes.** Confirmed. LOG_LEVEL and TZ are generic to service-kit services, so listing them is optional.

## DSTK-09 — Venue format facts and the evidence for them are written in full in both STOCKER-PARTITIONS and docs/venues; GATE.md and BITGET.md name Stocker

- **Severity:** medium  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F19

**Locations:**

- `docs/services/STOCKER-PARTITIONS.md:227-232`
- `docs/services/STOCKER-PARTITIONS.md:262-271`
- `docs/services/STOCKER-PARTITIONS.md:382-385`
- `docs/venues/BINANCE.md:155-158`
- `docs/venues/BYBIT.md:87-90`
- `docs/venues/GATE.md:388-391`
- `docs/venues/GATE.md:446-454`
- `docs/venues/BITGET.md:80`

**Problem.** This breaks 'Each subject has one home' and 'Venues are providers'. Three pieces of evidence appear in full in both docs: gate's reversed open/close settled by bar alignment, binance liquidations written twice (the same 1,720/860 counts), and bybit MT4 being UTC+3 (the 03:00 bar example). GATE.md and BITGET.md also say what Stocker does ('Stocker refuses any file wider…', 'treats zero length as empty', 'infers the unit', 'handles it with spill: back'), and GATE.md:388-391 includes incident history ('65 silently wrong partitions').

**Evidence.** The quotes match at each location. BINANCE.md and BYBIT.md do not name stocker; their only problem is the duplication.

**Fix.** 1) Venue docs: delete the Stocker sentences at GATE.md:388-391, :447 (becomes 'They are 0 bytes, not valid gzips'), :451 and BITGET.md:80, keeping each venue fact. Check that STOCKER-PARTITIONS states the handling (the gate width refusal, the bitget back spill), and add it there if it does not. 2) STOCKER-PARTITIONS: for gate klines, binance liquidations and bybit MT4, keep the column mapping, unit, zone and series option (`utcOffsetHours: 3`, back spill, exact repeats dropped, column order), and replace the measured evidence with 'why: [VENUE.md](../venues/VENUE.md#…)'. Apply the same rule to the other 'settled from rows' / 'verified on N rows' paragraphs. 3) Afterwards grep docs/venues for 'Stocker|stocker|vault|series' and confirm nothing names the service.

**Tests.** None (docs). Run the grep in step 3 as a check.

**Verifier notes.** Confirmed. CLAUDE.md fixes which doc is the home, so this is mechanical. Effort is L, but the edits are bounded.

## DSTK-10 — STOCKER.md describes table and symbol filters that do not exist

- **Severity:** medium  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F13

**Locations:**

- `docs/services/STOCKER.md:430-433`
- `docs/services/STOCKER.md:191`
- `services/stocker/src/config.ts:19-31`

**Problem.** Only STOCKER_VENUES and STOCKER_LENS scope a sweep (STOCKER.md:766-768 says so itself). 'Venue and table filters … Symbols stay substring tokens' describes configuration that no longer exists. 'whatever the bounds say' is vague: the lens can bound months, so the sentence is not false, but it should name the lens.

**Evidence.** config.ts reads no table, symbol or date variable, and there are no other process.env reads.

**Fix.** STOCKER.md:430-433: 'STOCKER_VENUES is matched case-insensitively against the venues the series map declares, and an unknown venue fails startup — the vocabulary is closed, so a typo would otherwise be an eternally clean run of nothing.' Remove the symbol sentence. STOCKER.md:191: '**The running month is never stocked**, even where the lens lets it through: its files are still arriving.'

**Tests.** None (docs).

**Verifier notes.** Confirmed. The verifier softened the 'bounds' part: name the lens rather than removing the sentence.

## DSTK-11 — The concurrency model is out of date: partitions share one connection pool and run side by side

- **Severity:** medium  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F2

**Locations:**

- `docs/services/STOCKER.md:376-380`
- `services/stocker/README.md:80`
- `services/stocker/docker/compose.yml:39`
- `services/stocker/src/scan.ts:128-160`
- `services/stocker/src/scan.ts:287`
- `services/stocker/src/scan.ts:720-731`
- `services/stocker/src/build.ts:429-431`

**Problem.** The docs say 'Partitions go one after another' and 'Instruments built at once'. In the code, a partition under 64 MB of archives takes one connection from a shared pool, so up to STOCKER_CONCURRENCY light partitions build at the same time. A heavier partition takes every connection. Only put-in-place is serialised (oneAtATime). The build.ts:429-431 comment ('Nothing else is being built while a partition is joined') is stale for the same reason. Its engine-wide preserve_insertion_order costs memory but not correctness, because every write has an ORDER BY.

**Evidence.** scan.ts:150 `freed(job.partition.bytes >= ALONE_BYTES ? conns.length : 1)`; ALONE_BYTES = 64 MiB (scan.ts:287); scan.ts:731 oneAtATime.

**Fix.** STOCKER.md:378-380: 'STOCKER_CONCURRENCY DuckDB connections form one pool, shared by partitions. A partition whose archives weigh under 64 MB takes one connection and builds its tasks on it, so that many light partitions are built side by side. A heavier one waits for every connection and builds its tasks side by side. Putting a partition in place (its ledger lines, the removals and renames, the join of its pieces) is done for one partition at a time.' README:80: 'DuckDB connections: as many light partitions built side by side, or one heavy partition's instruments; each holds a month-sized sort.' Reword compose.yml:39 to the same meaning. Correct the build.ts:429-431 comment.

**Tests.** None (docs/comments).

**Verifier notes.** Confirmed. The verifier added the stale build.ts comment.

## DSTK-12 — 'The monthly per-instrument rendering [of okx funding] is not mapped' is false: the same entry reads it and rank() prefers it

- **Severity:** medium  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F11

**Locations:**

- `docs/services/STOCKER-PARTITIONS.md:112`
- `docs/services/STOCKER-PARTITIONS.md:454-455`
- `services/stocker/src/schema/series.ts:833-837`
- `services/stocker/src/schema/series.ts:924-929`
- `services/stocker/src/scan.ts:1079-1080`
- `services/prospector/src/database/migrations/seeds/okx/pattern.csv:31`
- `services/prospector/src/database/migrations/seeds/okx/pattern.csv:38`

**Problem.** seriesOf matches only on venue, market, dataset and variant, so the one okx funding,realised entry reads both the daily allswap bundle and the monthly {SYMBOL}-SWAP-fundingrates files. rank() prefers bundle 'instrument'. The only fixture is okx.all-fundingrates.csv, so the mapping has never been checked against a monthly file.

**Evidence.** series.ts:924-929 has no bundle condition. scan.ts:1079-1080 ranks instrument at 0 and market at 10. The prospector seed registers both renderings.

**Fix.** Now: replace the sentence with 'The monthly per-instrument rendering is read by the same entry and is preferred over the daily bundle where both are on disk; its columns have not been checked against a file.' Change the funding table's okx Bundle cell to 'market; instrument (monthly) preferred where present'. Add a docs/planning/STOCKER.md item: verify a monthly okx fundingrates file and add a fixture. Any code change waits on that check (see Deferred).

**Tests.** When a sample is available: tests/fixtures/okx.swap-fundingrates-monthly.csv in manifest.json (key okx/perp/funding,realised/B/BTC-USDT-SWAP/<YYYYMM>/...).

**Verifier notes.** Confirmed. The reviewer's confidence was medium; the verifier found the prospector seed rows that settle it.

## DSTK-13 — okx swap trades for 2021-10, published with every trade twice, are stocked as published and no stocker doc says so

- **Severity:** medium  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F23

**Locations:**

- `docs/venues/OKX.md:279-296`
- `services/stocker/src/schema/series.ts:789-797`
- `docs/services/STOCKER-PARTITIONS.md:50`
- `docs/services/STOCKER-PARTITIONS.md:438-447`

**Problem.** OKX.md documents that every swap trade of 2021-10 appears twice, once as BUY and once as SELL. The okx trades series has no repeatsRows and no month bound, and DISTINCT could not remove the duplicates anyway because the sides differ. The vault therefore holds doubled trades with opposite sides for that month, and nothing in the stocker docs says so.

**Evidence.** OKX.md:279-283 describes the duplicates. series.ts:789-797 has no exclusion. Neither STOCKER doc mentions 2021-10.

**Fix.** In STOCKER-PARTITIONS' okx **trades** paragraph add: 'Perpetual trades for 2021-10 are published with every trade twice, once a side ([OKX.md](../venues/OKX.md#swap-trades-for-2021-10-list-every-trade-twice)), and are stocked as published: that month's perp trades hold each trade twice.' Add a docs/planning/STOCKER.md entry with the options (see Deferred).

**Tests.** None now. If the data handling changes, add a fixture-backed test for the chosen rule and bump the series `version` so existing 2021-10 partitions restock.

**Verifier notes.** Confirmed. The documentation part is bounded. The data handling is the owner's decision.

## DSTK-14 — Binance aggregated trades are stocked but missing from STOCKER-PARTITIONS

- **Severity:** medium  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F9

**Locations:**

- `docs/services/STOCKER-PARTITIONS.md:32-53`
- `docs/services/STOCKER-PARTITIONS.md:190-201`
- `services/stocker/src/schema/series.ts:60-73`
- `services/stocker/src/schema/series.ts:309-328`
- `services/stocker/tests/fixtures/manifest.json:15-23`

**Problem.** The doc claims to cover 'Every input format stocker reads', but it has no row or details for binance trades,aggregated (spot, perp linear and perp inverse). That format has 7 columns on futures and 8 on spot, drops first_id and last_id, fills no leg on COIN-M, and is written under aggregated=true.

**Evidence.** series.ts has three `variant: 'aggregated'` entries. Fixtures binance.{spot,um,cm}-aggTrades.csv exist. `grep -i aggreg` finds nothing in STOCKER-PARTITIONS.

**Fix.** Add trades-table rows. Spot: 'binance | spot | aggregated | zip · csv | no | no | int ms | from `is_buyer_maker` | base (`size = baseSize = qty`) | 8 columns'. Perp linear: '… | perp | aggregated, linear | zip · csv | no (positional; a header drops as an unparseable ts) | no | int ms | from `is_buyer_maker` | base | 7 columns'. Perp inverse: '… | contracts, no leg'. Under ### binance: '**trades, aggregated** — `agg_id, price, qty, first_id, last_id, time, is_buyer_maker[, is_best_match]` → `tradeId = agg_id, price, size = qty, baseSize = qty (not on COIN-M), ts = time, side, buyerMaker`; first_id, last_id and is_best_match are dropped; written under `aggregated=true`.' Do not copy 'µs from 2025-01' from the plain-trades row unless a 2025 spot aggTrades file confirms it (the fixture is from 2018).

**Tests.** None (docs).

**Verifier notes.** Confirmed. The verifier warned against copying the µs-era claim without evidence.

## DSTK-15 — Layouts and example queries omit the depth= and aggregated= levels; the copied query finds no files

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F15

**Locations:**

- `services/stocker/README.md:34-54`
- `docs/services/STOCKER.md:107-108`
- `docs/services/STOCKER.md:118-122`
- `docs/DATA_PIPELINE.md:104-105`
- `services/stocker/src/vault.ts:13-14`
- `services/stocker/src/vault.ts:280-288`
- `services/stocker/src/schema/series.ts:987-989`
- `services/stocker/src/schema/tables.ts:252-254`

**Problem.** The README layout leaves out `[/depth=…][/aggregated=…]`. DATA_PIPELINE says 'venue, market, table, and interval or kind'. The example queries in the README AND in STOCKER.md:107-108 read `dataset=trades/@/…`, but trades always carry `aggregated=` (okx trades get `aggregated=false`), so a copied query matches nothing. STOCKER.md:118-122 also covers only interval and kind.

**Evidence.** levelsOf emits interval, kind, depth and aggregated. extrasOf always gives trades `aggregated`.

**Fix.** 1) README: remove the Layout block (DSTK-08), or copy vault.ts:13-14 exactly. 2) STOCKER.md:107-108: the examples read `…/dataset=trades/aggregated=false/@/*.parquet` and `…/dataset=trades/aggregated=false/BTC-USDT/*.parquet`. 3) STOCKER.md:118-122: list every level. klines, markPrice, indexPrice and premiumIndex carry `interval=` (not for ticks); funding carries `kind=`; book tables carry `kind=` then `depth=` under `dataset=orderBook`; trades always carry `aggregated=` (false or true). 4) DATA_PIPELINE.md:104: 'Hive partitioning by venue, market and dataset (the canonical table, or `orderBook` for the book tables), then whichever of interval, kind, depth and aggregated the table carries — see services/STOCKER.md#path-convention.'

**Tests.** Check by grepping the docs for `dataset=trades/@` and `dataset=trades/<symbol>`, and confirm against levelsOf.

**Verifier notes.** Confirmed. The verifier found that the STOCKER.md example query is wrong too. The reviewer had cited it as correct.

## DSTK-16 — VOCABULARY's Revision and Chain definitions contradict STOCKER.md

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F17

**Locations:**

- `docs/VOCABULARY.md:28-29`
- `docs/VOCABULARY.md:97-98`
- `docs/services/STOCKER.md:203-211`
- `docs/services/STOCKER.md:371-374`
- `services/stocker/src/versions.ts:7-11`
- `services/stocker/src/versions.ts:191-208`

**Problem.** VOCABULARY says a revision changes with 'anything about how it is stocked'. versions.ts and STOCKER.md say that how a partition is built may change freely; only a change to the output moves a revision. VOCABULARY says without qualification that a chain is 'treated as one instrument', but the vault splits chains by contract.

**Evidence.** versions.ts:191-194 '**A partition's revision moves when its archives do, or when one of these does — and for no other reason.**'

**Fix.** VOCABULARY.md:97-98: 'Revision. What identifies one stocking of a partition in the vault. It changes when the partition's version does, or when what is written of it does (its columns, types, rows or their order), and not when only how it is built changes.' VOCABULARY.md:28-29: 'Chain. A family of dated contracts published together under the family's name, every expiry in one file. Its members differ in expiry alone, so the archives treat a chain as one instrument.' Do not mention stocker's splitting in VOCABULARY.

**Tests.** None (docs).

**Verifier notes.** Confirmed. Severity lowered to low, because anyone bumping a version edits versions.ts, whose docblock states the correct rule.

## DSTK-17 — 'Stocker is the vault's only writer' contradicts backedup.csv and the cold tooling docs

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F4

**Locations:**

- `docs/services/STOCKER.md:3`
- `docs/services/STOCKER.md:278-280`
- `docs/services/STOCKER.md:290-291`
- `services/stocker/README.md:3`
- `docs/tooling/COLD-VAULT.md:90-135`
- `services/stocker/src/ledger.ts:12`

**Problem.** Other tooling writes backedup.csv at the vault root, and it evicts files from the vault and pulls them back in. STOCKER.md:290-291 itself says stocker never writes backedup.csv.

**Evidence.** COLD-VAULT.md:92 'The one thing cold writes into the vault.' ledger.ts:12.

**Fix.** STOCKER.md:3: 'Stocker owns the vault: it alone stocks it, writing its Parquet files and its ledger. A copy kept elsewhere may take files out and put them back, and records itself in backedup.csv beside the ledger (see The ledger).' Do not name cold (dependency direction). STOCKER.md:278-280: 'Nothing but stocker writes the ledger or stocks a partition, so a partition still saying updating then is one nobody is updating.' Make README:3 match.

**Tests.** None (docs).

**Verifier notes.** Confirmed. Severity lowered from medium to low because it is a wording contradiction with little operational consequence.

## DSTK-18 — Margin is called 'a constant per file' (it is per instrument), and the list of tables carrying it omits orderBookSnapshot

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F7

**Locations:**

- `docs/services/STOCKER.md:621-627`
- `services/stocker/src/schema/tables.ts:24-29`
- `services/stocker/src/schema/tables.ts:129-135`
- `services/stocker/src/build.ts:728-733`

**Problem.** writeWhole joins a margin value per symbol, so an @ file holds a margin per instrument. orderBookSnapshot carries MARGIN but is missing from the list. 'A stopgap until instrument metadata says it' is a plan, which belongs in planning.

**Evidence.** tables.ts:134 has MARGIN in orderBookSnapshot; build.ts:728-733 has `JOIN (VALUES (symbol, margin)…)`.

**Fix.** STOCKER.md:622-627: list trades, klines, quotes, orderBook, orderBookSnapshot, orderBookBands, openInterest and liquidations. 'It is a constant per instrument, filled as each instrument's rows are written, from one rule per venue over the venue's own symbol (schema/margin.ts). A file holding a whole month carries each instrument's own value.' Move the 'stopgap' clause to docs/planning. tables.ts:26-28: 'A constant per instrument, not per row'.

**Tests.** None (docs/docblock).

**Verifier notes.** Confirmed as low. The failure scenario (linear and inverse in one bundle) is plausible but has not been shown. This also absorbs the orderBookSnapshot omission the DSTK-07 verifier found.

## DSTK-19 — Container claims ('covers Bybit and Gate entirely', 'Only .zip and .tar.gz are extracted', the README decode list) are inaccurate

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F14

**Locations:**

- `docs/services/STOCKER.md:437-439`
- `docs/services/STOCKER.md:479-486`
- `services/stocker/README.md:17-18`
- `services/stocker/src/containers/gzip.ts:16-31`
- `services/stocker/src/containers/plain.ts:42-47`
- `services/stocker/src/containers/extract.ts:44-63`
- `services/stocker/src/keys.ts:127-132`

**Problem.** Bybit option trades, option markPrice and books are zip files. Gate's index ticks are plain text. Small gzip files (≤32 KB) and small plain files (≤64 KB) are inflated or read into gathered files. The README's decode list leaves out plain files and non-CSV .gz.

**Evidence.** gzip.ts SMALL_BYTES = 32 KB; keys.ts maps any other ending to 'plain'.

**Fix.** STOCKER.md:437-439: 'DuckDB reads gzip and plain files natively, so a `.gz` or a bare file is handed to it as it lies — the difference between copying a 23 GB order-book month to scratch and not — except where small files are gathered (below). `.zip` and `.tar.gz` are extracted.' Drop 'which covers Bybit and Gate entirely'. In the gathering paragraph (~479), add that small gzip and plain files are inflated or read into the gathered file as well. README:17-18: 'Decodes `.zip` (CSV, JSON lines or an Excel sheet inside), `.tar.gz`, `.gz` and plain files; gzip and plain files are read by the query engine as they are.'

**Tests.** None (docs).

**Verifier notes.** Confirmed. The verifier says to point at the gathering paragraph rather than repeat the thresholds.

## DSTK-20 — Tech docs contain history, plans and future tense, and frame sections around the incidents that motivated them

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F21

**Locations:**

- `docs/services/STOCKER.md:8-15`
- `docs/services/STOCKER.md:528-532`
- `docs/services/STOCKER.md:560-563`
- `docs/services/STOCKER.md:626-627`
- `docs/services/STOCKER.md:663-665`
- `docs/services/STOCKER.md:672-676`
- `docs/services/STOCKER-PARTITIONS.md:16-17`
- `docs/services/STOCKER-PARTITIONS.md:86`
- `docs/services/STOCKER-PARTITIONS.md:442-447`
- `services/stocker/README.md:7-9`

**Problem.** This breaks 'Only what is true today' and 'A doc is about its own subject'. Examples: 'only archives is under development today', 'Further sources may join', 'REST and WS formats join as rows of their own', 'a stopgap until…', 'it was the parse here', 'looked like the big win; measured on 2026-08-02', '4,678 of them failed on one sweep', and okx's 'Enhanced Liquidity Program until 2026-07'.

**Evidence.** The quoted text is at each location.

**Fix.** STOCKER.md:8-15 and README:7-9: 'Stocker is not an archives service: it reads every source's raw files and stocks them the same way; its series today read the archives.' Drop 'further sources may join'. PARTITIONS:16-17: drop the REST/WS sentence. STOCKER.md:626-627: drop the stopgap clause (the plan lives in planning). PARTITIONS:86: becomes the 'unverified — no file decoded' marker (DSTK-05); do not move it to planning. STOCKER.md:663-665: 'Never DECIMAL(38,9) either: exact, but 5.5 s against 0.23 s for the split on a day of bybit perpetual trades, with identical results.' STOCKER.md:672-676: 'The sort stays even where inputs arrive ordered: removing it saves about 9% of build time; it sets the memory ceiling, which the spill directory covers.' Keep this number, since the code does not record it. STOCKER.md:560-563: drop the '4,678 … failed' clause (it is in project.ts:42). STOCKER.md:528-532: keep the KuCoin case as a present-tense example and drop the narration. PARTITIONS:443-444: drop the Enhanced Liquidity Program clause, and move it to OKX.md if it is wanted at all.

**Tests.** None (docs). Check by grepping the stocker docs for 'yet', 'will', 'until 20', 'was ', 'today', 'measured on'.

**Verifier notes.** Confirmed. The verifier corrected the reviewer: the ORDER BY ~9% measurement is not in the code docblocks, so it stays in the doc, rephrased; and 'not yet seen' is a statement about today that gets rewritten, not moved.

## DSTK-21 — STOCKER-PARTITIONS has a duplicated liquidations paragraph, contradicts itself on okx spill, merges eras in the htx rows, and mislabels a section

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F20

**Locations:**

- `docs/services/STOCKER-PARTITIONS.md:14-15`
- `docs/services/STOCKER-PARTITIONS.md:86-87`
- `docs/services/STOCKER-PARTITIONS.md:223-232`
- `docs/services/STOCKER-PARTITIONS.md:421-423`
- `docs/services/STOCKER-PARTITIONS.md:459-464`
- `docs/services/STOCKER-PARTITIONS.md:500-506`
- `services/stocker/src/schema/series.ts:584-631`
- `services/stocker/src/schema/series.ts:827-832`

**Problem.** (1) There are two consecutive liquidations paragraphs. (2) 'Every dataset spills back', yet okx books do not spill (and the code agrees). (3) The htx mark and index rows fold two eras into one row, which contradicts the 'one row per era' rule; the code has two series split at HTX_CUT. (4) 'Known discrepancies with the catalog' lists things that are not discrepancies.

**Evidence.** STOCKER-PARTITIONS:223 and :227 have the same column list. series.ts:828-831 has no spill on okx books.

**Fix.** Merge 223-232 into one paragraph with targets `ts, side, size = original_quantity, price, averagePrice, status`, keeping the sentence on the margin-dependent unit. :421 becomes '**Every dataset but books spills back**'. Split the htx rows into a 'before 2026-02-01' row (Hdr no, Sym no, `ts, O, C, H, L` by position; on the future row, note that a header line in some files drops as an unparseable row) and a 'from 2026-02-01' row (Hdr yes). Rename :500 to 'Partitions read with another market's formats', keep the bitget and htx future bullets, and drop the linear/inverse bullet.

**Tests.** None (docs).

**Verifier notes.** Confirmed.

## DSTK-22 — The revision inputs are listed incompletely; the ledger-check description is imprecise; repair timing is incomplete

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F26

**Locations:**

- `docs/services/STOCKER.md:195-201`
- `docs/services/STOCKER.md:275-280`
- `docs/services/STOCKER.md:293-296`
- `services/stocker/src/vault.ts:94-102`
- `services/stocker/src/ledger.ts:253-264`
- `services/stocker/src/scan.ts:847`

**Problem.** (1) The revision also hashes the catalog partition id (grain and bundle included) and an 'apart' marker. (2) The startup check counts files for every partition and also checks size for bundles. (3) Repair also runs right after a failed put-in-place. (4) The sentence on `outdated` arguably states consumer policy ('not a partition to copy elsewhere').

**Evidence.** vault.ts:96 hashes `${partition.id}\n${partition.version}`; vault.ts:99 'apart'; ledger.ts:256-257; scan.ts:847 `if (marked) await repair()`.

**Fix.** STOCKER.md:199: 'the catalog partition it is stocked from (its venue, market, dataset, variant, grain, bundle and month) and the catalog's version of it, which changes whenever a file of it does'. Add a bullet: 'whether the month has any side, built or missing, stored apart'. Lines 293-295: 'Every partition it holds must have as many files in the vault as the ledger gives, and a bundle's files must also weigh what it gives'. Lines 278-279: add 'and straight after a put-in-place that stopped part way'. Lines 275-276: see Deferred.

**Tests.** None (docs).

**Verifier notes.** Confirmed. The repair call is at scan.ts:847, not :850. Part (4) is borderline, so it is deferred to the owner.

## DSTK-23 — 'The series declares 1m' is wrong for okx and bitget klines: the interval is the catalog's variant

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F10

**Locations:**

- `docs/services/STOCKER-PARTITIONS.md:72-73`
- `docs/services/STOCKER-PARTITIONS.md:449-452`
- `docs/services/STOCKER-PARTITIONS.md:483-484`
- `services/stocker/src/schema/series.ts:815`
- `services/stocker/src/schema/series.ts:894`
- `services/stocker/src/schema/series.ts:990-994`

**Problem.** Both entries are `variant: '*'`, and extrasOf takes interval= from the catalog's variant. The okx row at :72 already says this correctly, so the doc contradicts itself.

**Evidence.** series.ts:993 `return variant && variant !== 'ticks' ? { interval: variant } : {};`

**Fix.** Line 73: change the 'Interval from' cell to 'the catalog's `1m`, named nowhere in a file'. In the okx (~451) and bitget (~484) paragraphs, replace 'so the series declares `1m`' with 'the catalog files them as `1m`, and the bars' spacing agrees'.

**Tests.** None (docs).

**Verifier notes.** Confirmed.

## DSTK-24 — README says containers register in containers/index.ts; the registry is containers/registry.ts and keys.ts must change too

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F16

**Locations:**

- `services/stocker/README.md:98`
- `services/stocker/src/containers/registry.ts:21`
- `services/stocker/src/containers/index.ts:124`
- `services/stocker/src/keys.ts:127-135`

**Problem.** CONTAINERS is in registry.ts, and index.ts only re-exports from it. A new container also needs its file ending mapped in containerOf, and possibly removed from UNOPENED.

**Evidence.** registry.ts:21 `const CONTAINERS … = { zip, gzip, 'tar.gz': targz, plain };`

**Fix.** README:98: '| A container format | `src/containers/` | add it to `CONTAINERS` in `containers/registry.ts`, and map its file ending to it in `containerOf` in `src/keys.ts` (taking the ending out of `UNOPENED` if it is one of those) |'.

**Tests.** None (docs).

**Verifier notes.** Confirmed. The formats row is correct.

## DSTK-25 — STOCKER.md uses 'slice', 'partition' and 'dataset' with vault meanings that VOCABULARY does not define

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F18

**Locations:**

- `docs/services/STOCKER.md:76-90`
- `docs/services/STOCKER.md:180-189`
- `docs/services/STOCKER.md:236-243`
- `docs/VOCABULARY.md:31-33`
- `docs/VOCABULARY.md:53-55`
- `docs/VOCABULARY.md:62-64`

**Problem.** VOCABULARY's slice and partition are archive concepts that include grain and bundle. STOCKER.md uses the same words for vault directories. The vault's `dataset=` holds the table root (orderBook, optionTicker), not the catalog's dataset (books, optionSummary), and the doc never says so outright.

**Evidence.** STOCKER.md:242 '`partition` | the vault partition: its slice's directory …'; tables.ts:254 ROOTS.

**Fix.** In STOCKER.md, write 'vault slice' (or 'vault directory') wherever the vault's directory is meant (lines ~76, 79, 181-182, 236, 242). Define it once in the path convention: 'a vault slice is the directory `venue=…/market=…/dataset=…[/levels]`; several archive slices (other grains, bundles) stock into one'. At :89-90 add: 'its value is the canonical table — the three book tables share `orderBook` — not the catalog's dataset name, which the ledger keeps.' Optionally add a definitions-only 'Table' entry to VOCABULARY.

**Tests.** None (docs).

**Verifier notes.** Confirmed. The reviewer's confidence was medium. The doc is partly clear already (':89-90 dataset= rather than table=').

## DSTK-26 — The architecture table is missing the modules that do most of the work

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F24

**Locations:**

- `docs/services/STOCKER.md:309-322`
- `services/stocker/src/build.ts`
- `services/stocker/src/prepare.ts`
- `services/stocker/src/room.ts`
- `services/stocker/src/db.ts`
- `services/stocker/src/spill.ts`
- `services/stocker/src/schema/project.ts`
- `services/stocker/src/containers/pack.ts`
- `services/stocker/src/containers/pool.ts`

**Problem.** build.ts (986 lines), prepare.ts, room.ts, db.ts, spill.ts, schema/project.ts and containers/pool.ts and pack.ts are not in the Concern | Where table.

**Evidence.** Comparing `ls services/stocker/src` with the table.

**Fix.** Add rows worded from each module's docblock: build.ts (reading an instrument or batch, writing, joining a month, pieces, a side's overlap); schema/project.ts (projection, TRY_CAST, timestamp parse, unit inference); prepare.ts with containers/pool.ts and pack.ts (extracting ahead, threads, the scratch bound, gathering); room.ts (room to extract and build); db.ts (one engine instance, memory and thread caps, the spill directory); spill.ts (a neighbour's reach, the clip).

**Tests.** None (docs).

**Verifier notes.** Confirmed.

## DSTK-27 — STOCKER.md does not say how stocker uses its providers (the catalog request, headers, retries, the archives layout)

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F25

**Locations:**

- `docs/services/STOCKER.md:141-147`
- `docs/services/STOCKER.md:163-166`
- `services/stocker/src/catalog.ts:22-29`
- `services/stocker/src/catalog.ts:59-87`
- `services/stocker/src/disk.ts:9-21`
- `services/stocker/src/keys.ts:113-119`

**Problem.** CLAUDE.md requires a consumer's doc to say how it uses its providers. STOCKER.md never names the endpoint, the headers, the retry policy or hauler's layout.

**Evidence.** catalog.ts:22-29 path and query; :84-85 headers; :59-62 ATTEMPTS = 4, RETRY_MS = 2000; disk.ts:9-21 layout; keys.ts excludes .bak and .part.

**Fix.** Add a short 'Providers' subsection. Catalog: GET {CATALOG_API}/venues/{venue}/partitions?downloaded=true&settled=true&datasets=<datasets the series map reads>, sending x-catalog-token when CATALOG_TOKEN is set and x-catalog-lens when STOCKER_LENS is set. A connection failure is retried up to 4 attempts, waiting 2 s and doubling; any HTTP status is final. Point to modules/CATALOG-API.md. Archives: <archives>/venue/market/dataset[,variant]/<FL>/<symbol>/YYYYMM/ and …/@/YYYYMM/. Only names that parse as canonical keys count (date[.partNN].ext); .bak and .part are ignored. Point to services/HAULER.md#the-layout-on-disk. Trim step 1 so the request mechanics are not repeated.

**Tests.** None (docs).

**Verifier notes.** Confirmed. The HAULER.md anchor exists.

## DSTK-28 — Small internal inconsistencies and a misplaced paragraph in STOCKER.md

- **Severity:** low  
- **Category:** docs  
- **Decision:** IMPLEMENT  
- **Source:** docs-stocker:docs/F27

**Locations:**

- `docs/services/STOCKER.md:410-415`
- `docs/services/STOCKER.md:545-550`
- `docs/services/STOCKER.md:684-686`
- `docs/services/STOCKER.md:702-724`
- `services/stocker/src/build.ts:441-454`

**Problem.** (1) 'Four things follow' is followed by five bullets. (2) The heading 'joined by appending, never by sorting' has sorting exceptions, including joinPieces. (3) The xlsx paragraph sits under malformed files when it belongs under 'One series per format'. (4) 'Bitget, okx and htx cut at 16:00 UTC' is false for okx books.

**Evidence.** Bullets at :704, 707, 711, 716, 720; build.ts:451 joinPieces ORDER BY.

**Fix.** 'Five things follow'. Retitle to '**A month is joined by appending wherever its files are already in order.**' and list the sorting joins: interleaving symbols (a big instrument read out of a batch) and the pieces of a big instrument (joinPieces). Add the side-overlap rewrite only after confirming it in build.ts. Move 545-550 into 'One series per format' (~line 351). Line 684: 'Bitget, htx and okx (all but okx's books) cut at 16:00 UTC'.

**Tests.** None (docs).

**Verifier notes.** Confirmed. The verifier did not check the side-overlap sort claim, so confirm it before adding.

## Deferred — decisions needed

No item is wholly deferred. The documentation part of each item below is IMPLEMENT; the code or data decision waits on the owner:

- **DSTK-07**: Delete the `settlement` table from tables.ts and the Table union in types.ts? No series produces it and no code or test references it. Or keep it as a planned table and list it in planning/STOCKER.md?
- **DSTK-12**: If a monthly okx fundingrates file turns out to have different columns from the daily bundle, should it get its own Series, or should the entry be restricted by bundle so only the daily bundle is read? This needs a real downloaded sample first.
- **DSTK-13**: How should okx perp trades for 2021-10 be handled? (a) Keep them as published, which is documented. (b) Skip the month by adding a month bound to the series. (c) Dedupe on trade_id, which needs a rule for the side, and the data cannot supply one. Any change needs a series version bump.
- **DSTK-22**: Should the 'outdated' passage (STOCKER.md:275-276) become 'An outdated partition keeps its files and is read like any other; they are not what its archives would stock today' (pure provider definition)? Or is 'not a partition to copy elsewhere until stocked again' meant as the mark's own definition?
- **DSTK-06 (cold scripts)**: before removing the cold-scripts clause from planning/CATALOG.md step 4, confirm whether the cold-push code already reads hauler's layout.

## Rejected

None. Every finding was confirmed. Some parts of the original fixes were corrected rather than rejected: the reviewer's ROADMAP wording ('mapped for every venue and dataset'), the claim that `symbol` is undocumented (DSTK-07), the claim that every measured number is already in code docblocks (DSTK-20), and moving 'not yet seen in a file' to planning (DSTK-05/20).
