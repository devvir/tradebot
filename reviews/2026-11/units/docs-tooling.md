# Review: docs-tooling

Scope: docs/tooling/**, dev/tooling/README.md, dev/tooling/src/tools/cold/legacy/README.md, docs/planning/COLD.md, checked against dev/tooling/**, ./tb and ./tools.

## Assessment

Each per-command cold doc (COLD-PUSH, COLD-EVICT, COLD-PULL, COLD-VAULT, COLD-AUDIT, COLD-CATALOG) gets the main mechanics right: tar states (.tmp/.unverified/.tar), the 5 GB cap, the 25 GB and 5 GB free-space reserves, the lock names, the Mega whoami retry, the backup of cold's files, the eviction rules, the catalog snapshot, and the audit checks. The docs around them are in much worse shape. docs/planning/COLD.md says audit, pull archives and evict-partly-away are unbuilt, but all three are built, and it points at a file that does not exist. The legacy README describes its own files wrongly. dev/tooling/README.md gives the wrong env precedence, documents a variable nothing reads and a -v flag that does nothing, leaves out `cold` entirely, and calls `rabbit <queue>` 'fetch recent messages' when it actually removes the oldest messages from a live queue (the one high-severity item). Several claims made across the cold docs are false: that nothing in a container reads cold's output (stocker reads backedup.csv); that evict is the only command that removes anything (audit deletes outright and skips the trash); that every command backs up the record (the catalog commands skip it); and that config is read from dev/tooling/.env. `cold push` silently ignores --dry-run and, for the vault, --lens. There are plans and a dated measurement inside tech docs, the 'second look' and Mega-confirmation text is copied into three docs, and the env table, the record's seven tables and the cold paths have no single complete home. ROADMAP, VOCABULARY and the root README contradict the cold docs. Both verifiers confirmed all 19 findings. Recommended restructure for a fresh start (DTL-20, an owner decision): (1) a new docs/tooling/README.md for the ./tools CLI as a whole (build, env precedence, global options, rabbit/monitor/remote), with dev/tooling/README.md shrunk to developer notes; (2) docs/tooling/COLD.md as the home for everything the cold commands share: origins and CLI conventions, one Configuration table, one 'Where things live' table, 'The record' (all 7 tables), backups, and 'How Mega is trusted'; (3) split the remaining pages by tree rather than by command: COLD-ARCHIVES (push+evict+the archives half of pull), COLD-VAULT, COLD-CATALOG, COLD-AUDIT; (4) a concrete register in which each rule starts with the number, flag or file and adds one line of rationale, with the long rationale left to the docblocks; (5) planning/COLD.md holding only open items, then delete legacy/; (6) neighbouring docs trimmed to pointers. Out of scope but related: STOCKER.md:65-66 justifies the vault layout by how cold uses it, which points the dependency the wrong way.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| DTL-01 | high | docs | IMPLEMENT | Rabbit README says the command fetches recent messages; it actually removes the oldest ones from the queue |
| DTL-02 | medium | docs | IMPLEMENT | docs/planning/COLD.md lists built work as unbuilt and points at a missing file |
| DTL-03 | medium | docs | IMPLEMENT | Docs say evict is the only command that removes anything; audit deletes outright, bypassing the trash |
| DTL-04 | medium | docs | IMPLEMENT | 'Nothing running in a container reads or writes any of it' is false: stocker reads backedup.csv |
| DTL-05 | medium | docs | IMPLEMENT | Cold's configuration has no correct home: wrong source file, missing variables, wrong defaults, CATALOG_DIR ignored from the module |
| DTL-06 | medium | correctness | IMPLEMENT | Record backups are said to run around 'any command', but push catalog and pull catalog skip them |
| DTL-07 | medium | correctness | IMPLEMENT | `cold push` silently ignores --dry-run (both trees) and --lens (vault) |
| DTL-08 | medium | docs | IMPLEMENT | dev/tooling README gives the wrong env-file precedence and documents RABBITMQ_MGMT_URL, which nothing reads |
| DTL-09 | medium | docs | IMPLEMENT | dev/tooling README leaves out `cold`, shows a stale layout, documents a no-op -v, a broken ts-node command, and plans |
| DTL-10 | medium | docs | IMPLEMENT | ROADMAP, VOCABULARY and the root README contradict the cold docs |
| DTL-11 | low | docs | IMPLEMENT | Legacy README describes reclaim.ts wrongly, lists rebuilt checks as missing, and names tests that cannot run |
| DTL-12 | low | docs | IMPLEMENT | No doc lists the whole record (7 tables), every cold path, or the fact that audit and stats take no lock |
| DTL-13 | low | docs | IMPLEMENT | The 'second look' and the Mega-confirmation rule are copied into three docs |
| DTL-14 | low | docs | IMPLEMENT | A 'Not built' design, a dated measurement and backlog text sit in tech docs |
| DTL-15 | low | docs | IMPLEMENT | COLD.md says -w works for 'evict', but `cold evict vault` never watches, and `all -w` loops any command |
| DTL-16 | low | docs | IMPLEMENT | Code docblocks contradict the docs on what 'ready' means and on why push and evict don't collide |
| DTL-17 | low | docs | IMPLEMENT | COLD-PUSH doesn't say it covers only the archives, and COLD.md 'The code' table is inaccurate |
| DTL-18 | low | docs | IMPLEMENT | Cold docs re-explain stocker's ledger marks without pointing at STOCKER.md, and the wording has drifted |
| DTL-19 | low | docs | IMPLEMENT | 'Asked for again, three times at the most' means three requests in total, not three retries |
| DTL-20 | low | docs-structure | DEFER | Restructure the tooling docs for a fresh start (per-tree pages, shared COLD.md, a CLI README) |

## DTL-01: Rabbit README says the command fetches recent messages; it actually removes the oldest ones from the queue

- **Severity:** high
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F1
- **Locations:** `dev/tooling/README.md:50`, `dev/tooling/README.md:58-62`, `dev/tooling/README.md:67-68`, `dev/tooling/README.md:80-86`, `dev/tooling/src/tools/rabbitmq/index.ts:72-92`, `dev/tooling/src/tools/rabbitmq/index.ts:108-117`, `dev/tooling/tests/tools/rabbitmq.test.ts:60`

**Problem.** The README says `./tools rabbit <queue>` will 'Fetch 10 recent messages' and that watch mode leaves messages in the queue. In fact, fetch mode calls channel.get(queue,{noAck:true}) up to N times, which takes the oldest N messages off the queue for good. Watch mode attaches a competing consumer (prefetch 1, nack with requeue). It takes deliveries away from the real consumers in turn, can reorder messages, shows the backlog as well as new messages, and on a queue with no other consumer redelivers the same message in a tight loop. It also ignores --messages, so the 'Watch with message limit' example does nothing.

**Evidence.** index.ts:109 `await channel.get(queueArg, { noAck: true })`; the test pins it at rabbitmq.test.ts:60. Watch path: `prefetch(1)`, `consume(..., nack(msg,false,true), {noAck:false})`, and options.messages is never read. The repo's queues are classic queues (packages/rabbitmq/src/queue.ts:183, no x-queue-type=stream), so removal is real.

**Fix.** Docs (now): README:50 should read '--messages <count>: number of messages to take from the head of the queue (default 10); fetch mode only; they are removed'. At :58-62, describe fetch as consuming: the messages are deleted and do not reach the service consumers. Delete the 'Watch with message limit' example (:67-68). At :80-86, say what watch really does: a prefetch-1 consumer that nacks each message with requeue, shows the backlog too, competes with live consumers, can reorder messages, redelivers in a loop on a queue with no other consumer, and ignores --messages. Code (owner decision, separate change): make fetch a non-destructive peek (get with noAck:false for all N, then nackAll(true)). Make watch bind a temporary exclusive autoDelete queue to the same exchange, or stop at the first redelivered message. Either honour --messages in watch mode or reject it there. Then document the peek.

**Tests.** Only if the code changes: update rabbitmq.test.ts:60 to expect {noAck:false} plus a requeue nack, and add a watch-mode test that --messages is honoured or rejected.

**Verifier notes.** Both verifiers confirmed high. The second verifier added the watch-mode redelivery loop and the backlog behaviour. The line cite is index.ts:109, not 108.

**Owner question.** Should `rabbit <queue>` become a non-destructive peek (and watch a copy-via-temporary-queue), or stay destructive with clear warnings in the docs?

## DTL-02: docs/planning/COLD.md lists built work as unbuilt and points at a missing file

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F4
- **Locations:** `docs/planning/COLD.md:8-19`, `docs/planning/COLD.md:31-39`, `dev/tooling/src/tools/cold/pull/archives/index.ts`, `dev/tooling/src/tools/cold/audit/checks/mega.ts`, `dev/tooling/src/tools/cold/evict/archives/survey.ts:63-83`, `docs/tooling/COLD-AUDIT.md:114-115`, `docs/tooling/COLD-CATALOG.md:147-152`

**Problem.** The intro says pull works only on the vault, that audit exists only 'as designed', and points at legacy/docs/COLD-EVICT.md, which does not exist. Three items listed as unbuilt are built: evict with a vault that is partly away (survey.ts held()), audit against Mega (audit/checks/mega.ts), and pull archives (pull/archives/{index,survey,bring}.ts). The file was last changed on 2026-10-07, before the commits that rewrote pull and added audit, backups, the catalog push/pull and pull needed.

**Evidence.** `ls -R legacy` shows no docs/ directory. pull/command.ts:78 dispatches to runPull. audit/index.ts:99-105 lists 'the record against Mega'. Later commits: 0441677, 4ed19ed, 25851dc, d1bdf84, 10ad65a.

**Fix.** Rewrite the file so it holds only open items. Delete the intro (:8-19) and the items at :31-39. Keep 'A partition the catalog withdraws entirely stays in its tar'. Keep 'first real push' and 'first real run of the vault commands' only if the owner confirms they have not happened yet. Add the items that really are unbuilt and now sit in tech docs or legacy: months with a gap between them (legacy/audit.ts gaps()), the one-page per-venue report (legacy hold/merge/render), the 'files that only just arrived' design (COLD-CATALOG.md:147-152, see DTL-14), and open ROADMAP goals such as REST/WebSocket captures as further origins (DTL-10).

**Tests.** None (docs only).

**Verifier notes.** Confirmed. This matters most for the user's goal: it is the list of 'missing functionality' they plan to build next.

**Owner question.** Have the first real `cold push` and the first real run of the vault commands happened? That decides whether those two planning items stay.

## DTL-03: Docs say evict is the only command that removes anything; audit deletes outright, bypassing the trash

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F7
- **Locations:** `docs/tooling/COLD-EVICT.md:10-13`, `docs/tooling/COLD.md:215-219`, `docs/tooling/COLD-CATALOG.md:77`, `docs/tooling/COLD-AUDIT.md`, `dev/tooling/src/tools/cold/audit/checks/disk.ts:45`, `dev/tooling/src/tools/cold/audit/checks/disk.ts:68`, `dev/tooling/src/tools/cold/audit/checks/mega.ts:75-76`, `dev/tooling/src/tools/cold/audit/checks/staging.ts:71-83`, `dev/tooling/src/tools/cold/audit/checks/staging.ts:119`, `dev/tooling/src/tools/cold/evict/discard.ts:17-23`, `dev/tooling/src/tools/cold/shared/vault/fetch.ts:82`

**Problem.** COLD-EVICT says evict 'is the only command in the family that removes anything' and that removals go to the trash. COLD.md says push removes only one kind of thing in Mega. But audit removes vault and archive files from disk through discard(paths, true), which calls fs.rmSync and skips the trash. Audit also removes Mega objects, staging tars and leftover pull files. push catalog --rebase removes partition files in Mega, as COLD-CATALOG.md:77 itself says. Push and pull also clean up their own temporary files.

**Evidence.** disk.ts:45 `apply: () => discard(back.map(...), true)`; discard.ts:17 `if (! purge) return trash(paths); ... fs.rmSync`.

**Fix.** COLD-EVICT.md:10-12: drop the 'only command' claim and describe evict on its own terms ('What it removes goes to the trash unless --purge'). COLD.md:215-219: add that `push catalog --rebase` removes, in Mega, the catalog partitions' files sent since the previous snapshot. COLD-AUDIT.md: for every removal fix (the 'remove ... again' rows, staging tars, pull leftovers, Mega orphans), state that it deletes outright and does not use the trash.

**Tests.** None (docs only).

**Verifier notes.** Confirmed. The destructive:true flag means the operator is prompted, but nothing tells them the trash is bypassed.

**Owner question.** Should audit's disk removals go to the trash (discard(..., false)) like evict's? If yes, change disk.ts and document that instead.

## DTL-04: 'Nothing running in a container reads or writes any of it' is false: stocker reads backedup.csv

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F6
- **Locations:** `docs/tooling/COLD.md:6-7`, `dev/tooling/src/commands/cold.ts:25-26`, `docs/tooling/COLD-VAULT.md:90-98`, `dev/tooling/src/tools/cold/shared/vault/ledger.ts:77-88`, `docs/services/STOCKER.md:290-296`, `services/stocker/src/ledger.ts:12,48,302`

**Problem.** COLD.md gives this claim as the reason cold lives in the tooling. But cold writes <vault>/backedup.csv, and the stocker service reads it to decide whether a missing vault file is a loss. Cold also reads stocker's ledger and ERROR.log. So the claim hides the one real interface between cold and a service, and a 'tooling-only' format change to backedup.csv would make stocker report losses, which then blocks cold's vault commands through ERROR.log.

**Evidence.** ledger.ts:80-87 'This is the one thing cold writes into the vault ... fs.appendFileSync'; STOCKER.md:291 'Stocker reads it and never writes it.'

**Fix.** Replace the sentence in COLD.md:6-7 and in the commands/cold.ts:25-26 docblock with one that is true and names no consumer: 'Cold storage runs from the host and no service calls it, so it lives in the tooling and holds its own state. It reads the vault's ledger and writes one file into the vault, backedup.csv (see COLD-VAULT.md#backedupcsv).' Make COLD-VAULT.md's backedup.csv section the home of its format (partition, revision, date; append-only; at the vault root; what a line promises). STOCKER.md describes only how stocker consumes the file and points to COLD-VAULT for the format.

**Tests.** None (docs only).

**Verifier notes.** Confirmed. Verifier refinement: cold is the provider of backedup.csv, so under CLAUDE.md's dependency rule its doc must not name stocker.

## DTL-05: Cold's configuration has no correct home: wrong source file, missing variables, wrong defaults, CATALOG_DIR ignored from the module

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F8
- **Locations:** `docs/tooling/COLD.md:148`, `docs/tooling/COLD-PUSH.md:192-211`, `docs/tooling/COLD-EVICT.md:193-199`, `dev/tooling/src/tools/cold/config.ts:45-87`, `dev/tooling/src/tools/cold/config.ts:149-150`, `dev/tooling/src/tools/cold/push/catalog/index.ts:64-65`, `.env.example:23-25`, `dev/tooling/.env.example`, `modules/collect/archives/.env.example:16-33`

**Problem.** The docs say cold's config is 'read from dev/tooling/.env', but DATA_DIR, DATA_ARCHIVES_DIR and DATA_VAULT_DIR come from the root .env through loadEnv's layering. The env table sits in COLD-PUSH, and COLD-EVICT adds DATA_VAULT_DIR in a table of its own. CATALOG_DIR and CATALOG_DB appear nowhere in docs/tooling, yet the error message names CATALOG_DIR. Cold takes CATALOG_PORT and CATALOG_TOKEN from modules/collect/archives/.env but not CATALOG_DIR, so a CATALOG_DIR set where that module documents it is ignored. When the module leaves CATALOG_PORT empty, as its .env.example recommends, CATALOG_URL falls back to a hardcoded 9010, which no doc mentions.

**Evidence.** config.ts:79 `catalogDb: getEnv('CATALOG_DB','') || path.join(under('CATALOG_DIR','catalog'),'catalog.db')` (process env only); config.ts:85 `archives['CATALOG_PORT'] || 9010`; config.ts:149-150 parses the module file for PORT/TOKEN only.

**Fix.** Docs: add one 'Configuration' section to COLD.md. Name the sources and their precedence (root .env < -e < dev/tooling/.env < process env; CATALOG_PORT and CATALOG_TOKEN fall back to modules/collect/archives/.env). List every variable config.ts reads, with its real default: DATA_DIR (required), MEGA_ROOT (required), SOURCES_COLD_DIR (<DATA_DIR>/@cold), DATA_ARCHIVES_DIR (<DATA_DIR>/archives), DATA_VAULT_DIR (<DATA_DIR>/vault), COLD_QUEUE_TARGET_GB (10), COLD_SETTLED_HOURS (none), CATALOG_DIR (<DATA_DIR>/catalog), CATALOG_DB (<CATALOG_DIR>/catalog.db), CATALOG_URL (http://localhost:<module CATALOG_PORT>, else 9010; set it explicitly when the module leaves the port empty), CATALOG_TOKEN (from the module). Replace the env sections in COLD-PUSH and COLD-EVICT with a pointer, and fix COLD.md:148. Code (small): in config.ts:79, fall back to the module's CATALOG_DIR before <DATA_DIR>/catalog. Expand ${DATA_DIR} in that value against dataDir (parseEnvFile does not expand references), or require an absolute path and document that. If the owner prefers not to change the code, document that CATALOG_DIR is not read from the module.

**Tests.** A config test that writes a temporary modules/collect/archives/.env (or stubs catalogModule) with CATALOG_DIR, including a ${DATA_DIR} reference, and checks catalogDb.

**Verifier notes.** Confirmed. The verifier proposed the code fallback, citing config.ts's own principle of not giving a second place to be wrong.

**Owner question.** Should cold read CATALOG_DIR from the archives module's .env, as it already does for PORT and TOKEN, or should the docs just state that it doesn't?

## DTL-06: Record backups are said to run around 'any command', but push catalog and pull catalog skip them

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Source finding:** F9
- **Locations:** `docs/tooling/COLD.md:166-186`, `dev/tooling/src/tools/cold/cli.ts:59-73`, `dev/tooling/src/tools/cold/push/command.ts:27-37`, `dev/tooling/src/tools/cold/pull/command.ts:83-93`, `dev/tooling/src/tools/cold/shared/backup.ts:99-176`, `dev/tooling/src/tools/cold/push/catalog/index.ts:70,262,281,293,312,337,400`

**Problem.** backup.check and backup.save are called only in cli.ts each(). The catalog branches of push and pull return before each() is reached, yet push catalog writes catalog_copy rows to cold.sqlite. So the record's copy in Mega lags until some other cold command runs. COLD.md also says a shrunk file 'is asked about' as a command starts, but only the record is checked at start, and a shrunk ledger is only warned about by save() and skipped.

**Evidence.** push/command.ts:27-36 returns before each(); there is no backup call under push/catalog or pull/catalog; backup.ts:108 checked() builds only recordOf.

**Fix.** Code: factor a `guarded(config, run)` helper out of each() in cli.ts that runs backup.check (when not busy), then the run, then backup.save([recordOf(config)]). Use it for the catalog branches in push/command.ts and pull/command.ts. Docs: keep 'any command' in COLD.md once this lands. Reword the shrink bullet: the record is asked about at start; a ledger that has shrunk is warned about and never sent by any command.

**Tests.** A test with a stub Remote showing that push catalog (and pull catalog) calls backup.check before and backup.save with recordOf after.

**Verifier notes.** Confirmed. The exposure is limited to the window before the next cold command runs.

## DTL-07: `cold push` silently ignores --dry-run (both trees) and --lens (vault)

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Source finding:** F10
- **Locations:** `dev/tooling/src/tools/cold/push/command.ts:17-19`, `dev/tooling/src/tools/cold/push/command.ts:43-48`, `dev/tooling/src/tools/cold/push/archives/index.ts:46-97`, `dev/tooling/src/tools/cold/push/vault/index.ts:49`, `docs/tooling/COLD-PUSH.md:3`, `docs/tooling/COLD-PUSH.md:26-29`, `docs/tooling/COLD-VAULT.md:39-71`, `docs/tooling/COLD.md:221-222`

**Problem.** push registers -n/--dry-run (its help text says 'catalog: ...'), but for archives and vault only venues and lens are passed on, so `cold -a -y push --dry-run` packs and uploads for real. Every other cold command honours -n. runPushVault never reads lens, so `cold push all --lens x` narrows the archives but pushes the whole vault. COLD.md:221-222 suggests a lens applies in general.

**Evidence.** push/command.ts:45-48 passes only {venues, lens}; push/vault/index.ts uses only options.venues.

**Fix.** Code: in push/command.ts, for the tree branches, throw when --dry-run, --rebase, --keep-snapshot or --drop-snapshot is given ('these are push catalog's options'). When the only origin is vault and --lens is given, throw ('A lens narrows the catalog; the vault is pushed by its ledger'). When both trees are pushed, warn once that the lens does not apply to the vault. Docs: COLD-PUSH synopsis and COLD-VAULT's `cold push vault` section say -n is catalog-only and that the lens applies to the archives only. Correct COLD.md:221-222 to cover the archives only.

**Tests.** Command tests: push archives -n is refused; push vault --lens x is refused; push all --lens x warns.

**Verifier notes.** Confirmed. The verifier put it at the upper edge of medium: it needs -n together with -y, and without -y the prompt works as a preview.

## DTL-08: dev/tooling README gives the wrong env-file precedence and documents RABBITMQ_MGMT_URL, which nothing reads

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F2
- **Locations:** `dev/tooling/README.md:21-22`, `dev/tooling/README.md:95-98`, `dev/tooling/README.md:197-226`, `dev/tooling/src/shared/utils/env.ts:37-52`, `dev/tooling/src/shared/connections/rabbitmq.ts:14-29`, `dev/tooling/src/index.ts:58`

**Problem.** The README says -e overrides dev/tooling/.env and calls dev/tooling/.env the 'Module .env'. The code merges root .env, then modules/<path>/.env (-m), then the -e file, then dev/tooling/.env, then process.env, so dev/tooling/.env overrides -e. A dev/tooling/.env copied from .env.example (which sets QUEUE_URL= and SOURCES_COLD_DIR) silently overrides whatever an -e file sets for those. Modules are nested, so -m needs a path (collect/archives). RABBITMQ_MGMT_URL is never read: the management URL is hardcoded, or taken from container discovery, which also replaces QUEUE_URL. The 'Required' table lists only optional variables and leaves out cold's DATA_DIR and MEGA_ROOT, which really are required.

**Evidence.** env.ts:47-52 `...rootEnv, ...moduleEnv, ...additionalEnv, ...toolingEnv`; grep finds no RABBITMQ_MGMT_URL in src; rabbitmq.ts:18 hardcodes http://localhost:15672/api.

**Fix.** Rewrite 'Environment Configuration' to match env.ts: 1 root .env, 2 modules/<path>/.env with -m <path> (e.g. collect/archives), 3 the -e file, 4 dev/tooling/.env, 5 process env (highest), then ${VAR} references resolved in one pass. Change the -e help text (index.ts:58, README:21) to 'overrides root and -m .env; dev/tooling/.env and the shell still override it', and -m's help to 'modules/<path>/.env, e.g. collect/archives'. Delete RABBITMQ_MGMT_URL. Under rabbit, say that QUEUE_USER and QUEUE_PASS are read, and that a discovered rabbitmq container replaces QUEUE_URL (management port 15672, or the AMQP port + 10000 when that port is not 5672). Replace the Required table with per-tool pointers (cold: COLD.md Configuration, see DTL-05).

**Tests.** None (docs only).

**Verifier notes.** Confirmed. The README example at :218 is `-e .env.local`, not `.env.staging`; the failure mode is the same.

**Owner question.** Should the precedence change so that -e beats dev/tooling/.env, which is what most people expect from a flag? If yes, change env.ts and document that order instead.

## DTL-09: dev/tooling README leaves out `cold`, shows a stale layout, documents a no-op -v, a broken ts-node command, and plans

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F3
- **Locations:** `dev/tooling/README.md:23`, `dev/tooling/README.md:248-287`, `dev/tooling/README.md:280-282`, `dev/tooling/README.md:365-370`, `dev/tooling/README.md:382-394`, `dev/tooling/src/index.ts:66-68`, `dev/tooling/src/shared/ui/logger.ts:48-53`

**Problem.** The README never mentions cold, which is about 12k lines of the package. The only trace is the example at :218. The tree leaves out commands/cold.ts, tools/cold/, shared/connections and the monitor files, and lists .env where the repo ships .env.example. remote.test.ts is said to cover functions that don't exist. -v only sets DEBUG=1, which nothing reads, and logger.debug is never called. `node --loader=ts-node/esm` cannot work for this CommonJS package (`pnpm dev` does work). Quick Start leaves out that ./tools runs dist/ and needs a build. 'Future Enhancements' is a list of plans.

**Evidence.** grep cold README matches only :218; index.ts:66-68 `process.env.DEBUG='1'`; grep DEBUG src matches only index.ts; remote/sync-env.ts exports only _test_findEnvFiles and run; ./tools runs dev/tooling/dist/index.js.

**Fix.** Add a `cold` entry: one sentence and a link to docs/tooling/COLD.md, with no cold detail. Replace the tree with a two-line layout (src/commands = registration; src/tools/<tool> = implementation; src/shared = ui/env/connections/utils; tests mirror src). Fix or drop the remote.test.ts comment. Remove -v from index.ts and the README (wiring it to LOG_LEVEL=debug would show nothing, because no debug() calls exist). Keep `pnpm dev`, drop the node --loader alternative. Add 'pnpm --filter @tradebot/tooling build first; ./tools runs dist/' to Quick Start. Delete 'Future Enhancements', moving anything wanted to docs/planning/.

**Tests.** If -v is removed: none. If it is kept and wired: a test that -v sets LOG_LEVEL=debug.

**Verifier notes.** Confirmed. The verifier corrected one point: `pnpm dev` works because ts-node is hoisted at the workspace root; only the --loader form is broken.

## DTL-10: ROADMAP, VOCABULARY and the root README contradict the cold docs

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F14
- **Locations:** `docs/ROADMAP.md:178-200`, `docs/VOCABULARY.md:62-64`, `README.md:55`, `docs/tooling/COLD.md:125`, `docs/tooling/COLD-VAULT.md:15-21`, `dev/tooling/src/tools/cold/config.ts:97-98`

**Problem.** ROADMAP says tars are '.pNN.tar' parts, that the vault is packed, and that there are 'three origins'. The real tar name is <venue>-<YYYYMM>.<NNN>.tar, the vault is not packed, and there are two origins. VOCABULARY defines a partition as 'cold-stored, restored and deleted whole, or not at all', yet the vault is evicted and pulled one file at a time, and evict --instruments removes part of a partition. README.md:55 calls docs/tooling 'The `tb` command-line tools', but cold is `./tools cold`, and ./tb runs dx.

**Evidence.** config.ts:97-98 tarName; COLD-VAULT.md:15 'Nothing is packed'; ./tb execs dx/dx.js, ./tools execs dev/tooling/dist/index.js.

**Fix.** ROADMAP: replace the account of how cold storage works with a short goal and a pointer to docs/tooling/COLD.md, and move open goals (such as REST/WebSocket captures as further origins) to docs/planning/COLD.md. VOCABULARY: define partition without operations, e.g. 'One month of a slice: every file its attributes and that month select; the unit data is tracked and versioned by.' Do NOT put vault or cold-storage behaviour in the glossary. README.md:55: 'The `./tools` developer CLI (cold storage: `./tools cold`)'. If tb deserves a row, point it at dx/.

**Tests.** None (docs only).

**Verifier notes.** Confirmed. The verifier rejected the reviewer's VOCABULARY wording, because it put a tooling fact into a doc that must depend on nothing.

## DTL-11: Legacy README describes reclaim.ts wrongly, lists rebuilt checks as missing, and names tests that cannot run

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F5
- **Locations:** `dev/tooling/src/tools/cold/legacy/README.md:5`, `dev/tooling/src/tools/cold/legacy/README.md:11-16`, `dev/tooling/src/tools/cold/legacy/evict/reclaim.ts:11-50`, `dev/tooling/src/tools/cold/evict/discard.ts`, `dev/tooling/src/tools/cold/audit/checks/staging.ts:43-111`, `dev/tooling/tests/tools/cold/legacy/dashboard.test.ts:2-7`, `dev/tooling/tests/tools/cold/legacy/audit.test.ts:11-13`, `docs/tooling/COLD-AUDIT.md:114-115`

**Problem.** The README says reclaim.ts takes back tars left in staging. In fact it is the old evict's trash-or-delete of evicted files, and evict/discard.ts now does that job, so by the README's own rule the file should be gone. The README says staging tars and 'tar holds vs record' are not rebuilt, but audit/checks/staging.ts does both. Only months-with-a-gap and the one-page report are still missing, and COLD-AUDIT.md:114 lists only gaps, which contradicts it. The tests in tests/tools/cold/legacy/ use '../../../src/...' paths, which resolve to tests/src/... and do not exist, so they cannot run.

**Evidence.** reclaim.ts:11 'Move the files to the host's trash, then remove the directories they leave.' The legacy exports _test_gaps and _test_hold exist at legacy/audit.ts:1279-1289, but the test imports do not resolve.

**Fix.** Delete legacy/evict/reclaim.ts. Fix the README table: audit.ts = 'months with a gap between them, and the one-page per-venue report'; drop the reclaim row; types.ts and config.ts are the vocabulary audit.ts is written in. Change :5 to say the legacy tests are kept for reading only and their imports do not resolve. Move both unbuilt audit ideas into docs/planning/COLD.md (DTL-02) and cut them from COLD-AUDIT.md (DTL-14).

**Tests.** None (docs only).

**Verifier notes.** The first verifier lowered this from medium to low, since it concerns an excluded reference folder. The reviewer's claim that the tests import the new audit was imprecise; the actual problem is that their paths are broken.

**Owner question.** Once the gap check and the one-page report are written into planning, can the whole legacy/ folder, tests/tools/cold/legacy/ and their tsconfig/vitest excludes be deleted? That would suit the requested fresh start.

## DTL-12: No doc lists the whole record (7 tables), every cold path, or the fact that audit and stats take no lock

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F13
- **Locations:** `docs/tooling/COLD.md:120-146`, `docs/tooling/COLD-VAULT.md:168-176`, `docs/tooling/COLD-EVICT.md:124-127`, `docs/tooling/COLD-CATALOG.md:47-53`, `dev/tooling/src/tools/cold/shared/record/schema.ts:42-177`, `dev/tooling/src/tools/cold/push/catalog/index.ts:165,184`, `dev/tooling/src/tools/cold/pull/catalog/index.ts:134,196`

**Problem.** The record is summarised as 'every tar and the partitions each holds, and every vault file', but schema.ts has seven tables (tar, held, eviction, vault_file, vault_partition, vault_move, catalog_copy). Their descriptions are spread across three docs, and tar and held are never described by name. 'Where things live' leaves out <cold>/catalog/, <cold>/pulling/catalog/, <cold>/pulled/catalog/catalog.db, <cold>/backup/ (with sent.json), <MEGA_ROOT>/@cold/catalog/, and the cold.catalog.push/pull locks. audit and stats take no lock, and audit can write fixes to the record while holding none, which is not documented.

**Evidence.** schema.ts CREATE TABLEs at :45,69,97,119,138,149,166; audit/index.ts imports busy() but not acquire().

**Fix.** In COLD.md, add a 'The record' table with all seven tables, one line each. Move COLD-VAULT.md:168-176 there, and have COLD-EVICT and COLD-CATALOG link to it. Complete 'Where things live' with the paths and locks above. State that audit and stats take no lock and can run beside any command, and that audit's fixes write to the record without a lock.

**Tests.** None (docs only).

**Verifier notes.** Confirmed; completeness gap.

**Owner question.** Should audit take a lock before applying fixes that write to the record? It currently holds none, so it can race a running push or evict. If the answer is no, document why.

## DTL-13: The 'second look' and the Mega-confirmation rule are copied into three docs

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F11
- **Locations:** `docs/tooling/COLD-PUSH.md:99-105`, `docs/tooling/COLD-PUSH.md:116-131`, `docs/tooling/COLD-VAULT.md:52-57`, `docs/tooling/COLD-VAULT.md:73-88`, `docs/tooling/COLD-CATALOG.md:106-107`, `dev/tooling/src/tools/cold/shared/mega/transfers.ts:136`, `dev/tooling/src/tools/cold/shared/mega/listing.ts`

**Problem.** COLD-PUSH.md:116-131 and COLD-VAULT.md:73-88 are the same text apart from tar/file. The confirmation rule (listed at size and second-precision mtime, not an exit code or leaving the queue) is written out three times. Both are behaviours of the shared Mega layer, so this breaks the one-home rule.

**Evidence.** A diff of the two passages shows only tar/file substitutions.

**Fix.** Add a 'How Mega is trusted' section to COLD.md, after 'A command left watching keeps going'. It covers: confirmation by listing at the local size and second-precision mtime, with the handle recorded; the queue asked only whether a transfer is still on its way; duplicate queued transfers of the same path dropped at the start of each round; and the re-listing after a round (a changed handle is re-recorded, a missing one is marked not stored). Replace the three copies with one sentence and a link each, keeping each tree's specifics (for example, the vault's 'never taken as stored before handed over').

**Tests.** None (docs only).

**Verifier notes.** The first verifier lowered this from medium to low: nothing is wrong today, the risk is future drift.

## DTL-14: A 'Not built' design, a dated measurement and backlog text sit in tech docs

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F12
- **Locations:** `docs/tooling/COLD-CATALOG.md:147-152`, `docs/tooling/COLD-PUSH.md:62-63`, `docs/tooling/COLD-AUDIT.md:110-115`, `docs/tooling/COLD.md:199`

**Problem.** COLD-CATALOG ends with '## Not built: files that only just arrived'. COLD-PUSH carries 'Measured ... on 2026-10-05: 2,006 partitions, 180 tars, 133 GB'. COLD-AUDIT has history and backlog text ('has not been rebuilt', 'Whatever is thought of later goes here'). All of these break 'Only what is true today'.

**Evidence.** The quoted lines.

**Fix.** Move COLD-CATALOG.md:147-152 into docs/planning/COLD.md. Delete COLD-PUSH.md:62-63, or replace it with 'tars land near the 5 GB cap; `cold stats` shows the counts'. In COLD-AUDIT.md, cut 'Adding a check' to two lines (checks live in audit/checks/, listed in CHECKS in audit/index.ts) and move the gap check to planning. Leave COLD.md:199's legacy row until legacy/ goes (DTL-11), then delete it.

**Tests.** None (docs only).

**Verifier notes.** Confirmed. The COLD.md:199 part is the weakest, since that row describes code that exists today.

## DTL-15: COLD.md says -w works for 'evict', but `cold evict vault` never watches, and `all -w` loops any command

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F15
- **Locations:** `docs/tooling/COLD.md:41`, `docs/tooling/COLD.md:52-55`, `dev/tooling/src/tools/cold/evict/vault.ts`, `dev/tooling/src/tools/cold/cli.ts:40-86`

**Problem.** evict/vault.ts never reads isWatch(), so `cold evict vault -w` runs once and exits. In the other direction, with `all`, each() repeats the whole round every 30 minutes for any command, including audit and stats.

**Evidence.** grep isWatch matches only evict/archives, push/archives, push/vault and pull/needed; cli.ts:43 `watching = several && staying`.

**Fix.** COLD.md:41: '`push` (both trees), `evict archives` and `pull needed`'. In 'Watching every tree' (:52-55), add: 'With more than one tree, the round repeats for any command, including those that do not watch on their own (audit, stats, pull, evict vault).'

**Tests.** None (docs only).

**Verifier notes.** Confirmed.

**Owner question.** Should each() honour -w only for commands built to watch, so that `cold audit all -w` stops looping for ever?

## DTL-16: Code docblocks contradict the docs on what 'ready' means and on why push and evict don't collide

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F16
- **Locations:** `dev/tooling/src/tools/cold/push/archives/index.ts:22-23`, `dev/tooling/src/tools/cold/lock.ts:17-26`, `docs/tooling/COLD-PUSH.md:17-24`, `docs/tooling/COLD-EVICT.md:124-127`, `docs/tooling/COLD-EVICT.md:187-191`, `dev/tooling/src/tools/cold/shared/catalog.ts:35-37`, `dev/tooling/src/tools/cold/shared/record/evictions.ts:40`

**Problem.** The runPush docblock says a ready partition has 'not changed for a day'. In fact cold asks the catalog for settled partitions, and adds a quiet period only when COLD_SETTLED_HOURS is set, which it is not by default. lock.ts's rationale describes the pre-partition design ('uploaded part', 'same size and mtime', 'evict never writes to the database'), but evict writes eviction rows.

**Evidence.** catalog.ts:35-37 sends settled-before only when settledHours is set; evictions.ts:40 INSERTs into eviction.

**Fix.** push/archives/index.ts:22-23: 'a partition with nothing left to download that the catalog calls settled — and, where COLD_SETTLED_HOURS is set, unchanged for that many hours since.' lock.ts:17-26: push reads only partitions that are not stored, or are stored at a version other than the catalog's; evict removes only partitions stored at the catalog's version, so the two act on disjoint partitions. Keep the sentence about push tolerating a tree that moves under it. Drop the stale claims. If you say evict writes only its own eviction rows, which push does not read, check that first with `grep -rn evictionsOf dev/tooling/src/tools/cold/push`.

**Tests.** None (docs only).

**Verifier notes.** Confirmed. Separate locks are still right; only the reasons given are stale.

## DTL-17: COLD-PUSH doesn't say it covers only the archives, and COLD.md 'The code' table is inaccurate

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F17
- **Locations:** `docs/tooling/COLD-PUSH.md:1-5`, `docs/tooling/COLD-EVICT.md:7-8`, `docs/tooling/COLD-PULL.md:6-7`, `docs/tooling/COLD.md:190-211`

**Problem.** COLD-PUSH is titled '# cold push' with the general synopsis but covers only the archives' tar flow; it never mentions the vault. COLD-EVICT and COLD-PULL both say 'This page is the archives'. The 'The code' table claims every subcommand directory has archives/vault parts, which is untrue for audit (checks/), stats (single module), push/pull (catalog/, needed/, filter.ts) and evict/vault.ts (a file). It leaves out cleanup.ts and order.ts, and contains forward-looking wording.

**Evidence.** `ls dev/tooling/src/tools/cold/{audit,stats,evict,push,pull}`; grep vault COLD-PUSH.md finds nothing.

**Fix.** Add to COLD-PUSH's intro: 'This page is the **archives**. The vault: COLD-VAULT.md#cold-push-vault; the catalog's copy: COLD-CATALOG.md.' Correct 'The code': each subcommand directory holds command.ts plus what it needs (archives/ and vault for push/evict/pull; catalog/ for push and pull; needed/ for pull; checks/ for audit; stats is a single module). Add cleanup.ts (exit handlers) and order.ts (sort keys). Drop 'another storage is another source beside it'. The larger reorganisation is DTL-20.

**Tests.** None (docs only).

**Verifier notes.** Confirmed. The verifier separated the bounded fix from the restructure, which is a design choice.

## DTL-18: Cold docs re-explain stocker's ledger marks without pointing at STOCKER.md, and the wording has drifted

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F19
- **Locations:** `docs/tooling/COLD-EVICT.md:45-55`, `docs/tooling/COLD-EVICT.md:74-88`, `docs/tooling/COLD-VAULT.md:43-46`, `docs/services/STOCKER.md:233-305`

**Problem.** No doc under docs/tooling links STOCKER.md, which is where the ledger's columns and marks are defined. COLD-EVICT's gloss of `outdated` ('waiting to be stocked again from these very archives') has drifted from STOCKER.md:247/275 ('no longer what would be stocked'; it keeps its files).

**Evidence.** grep STOCKER docs/tooling/*.md finds nothing; compare COLD-EVICT.md:53-55 with STOCKER.md:247,275.

**Fix.** At the start of COLD-EVICT '### Stocked', add: 'The ledger and what its marks mean are [STOCKER.md](../services/STOCKER.md#the-ledger)'s; what follows is what cold concludes from it.' Cut the glosses to cold's rule ('a partition whose last line says updating or outdated is not taken as stocked'). Do the same in COLD-VAULT step 1. Keep the preVersion/postVersion table in COLD-EVICT, since that retention rule is cold's own. Check that the anchor resolves.

**Tests.** None (docs only).

**Verifier notes.** The verifier judged the overlap acceptable in size; what is really missing is the pointer, and the drift.

## DTL-19: 'Asked for again, three times at the most' means three requests in total, not three retries

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F18
- **Locations:** `docs/tooling/COLD-PULL.md:72-73`, `docs/tooling/COLD-VAULT.md:131-132`, `dev/tooling/src/tools/cold/shared/vault/fetch.ts:20-21,71-86,111`, `dev/tooling/src/tools/cold/pull/archives/bring.ts:109-128,191`

**Problem.** ATTEMPTS = 3 counts the first request, so a dropped download is re-requested at most twice.

**Evidence.** fetch.ts:71-86 checks `asked >= ATTEMPTS` before queueDownload, with the first request counted.

**Fix.** In both docs: 'One Mega drops without delivering is asked for again; each is asked for three times at the most in all.' Optionally align the docblocks at fetch.ts:20-21 and bring.ts:109-110.

**Tests.** None (docs only).

**Verifier notes.** Confirmed. A file already in Mega's queue at the start of the run is not counted until it drops.

## DTL-20: Restructure the tooling docs for a fresh start (per-tree pages, shared COLD.md, a CLI README)

- **Severity:** low
- **Category:** docs-structure
- **Decision:** DEFER
- **Source finding:** notes (F17 restructure)
- **Locations:** `docs/tooling/**`, `dev/tooling/README.md`, `dev/tooling/src/tools/cold/legacy/`, `docs/services/STOCKER.md:65-66`

**Problem.** The cold pages are split partly by command (PUSH, EVICT, PULL) and partly by tree (VAULT, CATALOG), so a reader has to jump between four files to learn one command. The ./tools CLI as a whole has no doc under docs/. The prose is abstract and rarely gives the concrete value, flag or file. Docblocks repeat long rationale that is also in the docs (COLD-EVICT is close to runEvict's docblock).

**Evidence.** See DTL-17 and the reviewer's notes.

**Fix.** (1) New docs/tooling/README.md for ./tools: build, env precedence, global options, rabbit (stating plainly that it is destructive), monitor, remote. Shrink dev/tooling/README.md to developer notes plus a link. (2) Make COLD.md the home for what the commands share: origins and CLI conventions (origin/all/-a/-y/-w with exact applicability), Configuration, Where things live, The record, backups, How Mega is trusted. Move 'The code' into a src/tools/cold README or docblock. (3) Split per tree: COLD-ARCHIVES.md (PUSH + EVICT + the archives half of PULL), COLD-VAULT.md, COLD-CATALOG.md, COLD-AUDIT.md, each listing its own flags, ignored ones included. Put `pull needed` in COLD-VAULT or COLD.md. (4) Use a concrete register: start each rule with the concrete fact, give one line of rationale, and leave the long rationale to the docblocks. (5) Then delete legacy/. (6) Out of scope: STOCKER.md:65-66 justifies the vault layout by how cold uses it; reverse that so cold's doc says it mirrors the vault layout.

**Tests.** Check that the links and anchors resolve after the move.

**Verifier notes.** This is a recommendation from the reviewer's notes; the first verifier called the axis choice a design decision for the owner.

**Owner question.** Do you want the cold docs reorganised per tree (COLD-ARCHIVES/VAULT/CATALOG/AUDIT, with COLD.md holding the shared material) and a new docs/tooling/README.md for ./tools? If yes, do it after DTL-01..19, since those fixes define the content.

## Deferred: decisions needed

- **DTL-01** (IMPLEMENT the docs part now; the code or behaviour change waits for this decision): Should `rabbit <queue>` become a non-destructive peek (and watch a copy-via-temporary-queue), or stay destructive with clear warnings in the docs?
- **DTL-02** (IMPLEMENT the docs part now; the code or behaviour change waits for this decision): Have the first real `cold push` and the first real run of the vault commands happened? That decides whether those two planning items stay.
- **DTL-03** (IMPLEMENT the docs part now; the code or behaviour change waits for this decision): Should audit's disk removals go to the trash (discard(..., false)) like evict's? If yes, change disk.ts and document that instead.
- **DTL-05** (IMPLEMENT the docs part now; the code or behaviour change waits for this decision): Should cold read CATALOG_DIR from the archives module's .env, as it already does for PORT and TOKEN, or should the docs just state that it doesn't?
- **DTL-08** (IMPLEMENT the docs part now; the code or behaviour change waits for this decision): Should the precedence change so that -e beats dev/tooling/.env, which is what most people expect from a flag? If yes, change env.ts and document that order instead.
- **DTL-11** (IMPLEMENT the docs part now; the code or behaviour change waits for this decision): Once the gap check and the one-page report are written into planning, can the whole legacy/ folder, tests/tools/cold/legacy/ and their tsconfig/vitest excludes be deleted? That would suit the requested fresh start.
- **DTL-12** (IMPLEMENT the docs part now; the code or behaviour change waits for this decision): Should audit take a lock before applying fixes that write to the record? It currently holds none, so it can race a running push or evict. If the answer is no, document why.
- **DTL-15** (IMPLEMENT the docs part now; the code or behaviour change waits for this decision): Should each() honour -w only for commands built to watch, so that `cold audit all -w` stops looping for ever?
- **DTL-20** (DEFER): Do you want the cold docs reorganised per tree (COLD-ARCHIVES/VAULT/CATALOG/AUDIT, with COLD.md holding the shared material) and a new docs/tooling/README.md for ./tools? If yes, do it after DTL-01..19, since those fixes define the content.

## Rejected

None. Both verifiers confirmed all 19 findings. The parts of findings they corrected (VOCABULARY wording in F14, the ts-node claim in F3, how the legacy tests import in F5) are folded into the fixes above.
