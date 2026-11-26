# Docs rewrite — follow-ups

Generated from the docs workflows. "Code/config gaps" are things a docs item expected in code that has not landed;
"Remaining" are what each group's independent checker could not fix (owner questions, other groups' files).

## archives-hauler — checked; items done 17/17

Code/config gaps:
- DPLT-09 (config change, not made): services/prospector/docker/compose.yml and services/catalog/docker/compose.yml guard ${CATALOG_DIR:?}, and services/hauler/docker/compose.yml guards ${DATA_ARCHIVES_DIR:?}, but nothing guards DATA_DIR itself. With an empty root DATA_DIR, the root .env.example's derived values become /catalog and /archives. Those pass the guards and get bind-mounted at the host root. Fix: guard DATA_DIR (${DATA_DIR:?DATA_DIR is not defined}) or stop deriving the paths.
- services/catalog-ui/docker/compose.yml does not pass CATALOG_UI_HOSTS, which catalog-ui's config.ts reads for its Host allowlist. It cannot be set from the module, so the README does not list it (catalog-ui group's file).
- services/prospector/src/config.ts docblock still says 'The facts database belongs to the archivist' (DPLT-18 part; not this group's file).
- services/catalog-ui/docker/compose.yml header still says 'the catalog may run elsewhere' (DCAT-21 wording; catalog-ui group's file).

Remaining after check:
- services/hauler/docker/compose.yml:48 and services/stocker compose: DPLT-09's guard on DATA_DIR itself (`${DATA_DIR:?...}`) is a config change. Per the instructions it was not made, only reported. The root .env.example now derives DATA_ARCHIVES_DIR and CATALOG_DIR from DATA_DIR, so an empty DATA_DIR still gives /archives, which passes the `:?` guard on DATA_ARCHIVES_DIR.
- services/hauler/src/index.ts:66 docblock also says 'The catalog serves every venue as a bucket'. That file is not owned by this group, so it was left as is.

## catalog — checked; items done 32/35
Not fully done: DCAT-04:partial, DCAT-15:partial, catalog-ui:CUI-06:partial

Code/config gaps:
- services/catalog/src/contents.ts (venueContents lensed branch) and services/catalog/src/lenses/figures.ts: under a lens, `withdrawn` is still the whole venue's because it comes from `...row` (venueTotals), and lensFigures does not select SUM(q.withdrawn). DCAT-04's code fix has not landed, so the doc says withdrawn stays the venue's.
- shared/lenses/src/members.ts `rebuild` docblock (not this group's file): it says a lens being rebuilt reads as 'partly the old rules' and partly the new'. In fact catchUp from partition 0 runs whole() in one transaction, so the rows stay the old rules' until that pass commits.
- Other groups' files: ARCHIVES.md (who writes lenses) and services/catalog/src/config.ts and types.ts (read-only comments) were not checked or touched in this pass. They are named in DCAT-01 and belong to other groups or passes.
- services/catalog/src/contents.ts intoShapes: a shape's `symbols` and `buckets` count series, not distinct instruments, so an instrument held under two patterns of one shape counts twice. The doc now says 'series' to match the code.
- services/catalog/src/queries.ts:22-26: the seriesFor docblock says the held venue series feed 'contents, lens options, sizes, checks, scopes'. Only the contents use seriesFor (contents.ts:59, :87). Lens options, sizes and checks are read by @tradebot/lenses on its own, and scopes read lens_member. This is a comment inaccuracy in a file this group does not own; it was not changed.
- services/catalog/src/contents.ts:50-70: under a lens, the venue row's `withdrawn` and `hosts` are still the whole venue's, and `series` reads n/n (DCAT-04 code fix not landed, as noted in pass 1). CATALOG.md points to CATALOG-LENSES.md for which figures are the lens's and does not claim more.
- services/catalog-ui/docker/compose.yml environment block: CATALOG_UI_HOSTS is read by src/config.ts, but compose never passes it, so in the container the Host allowlist is always empty and any Host is served. The README states 'Compose does not set it'.
- services/catalog-ui/docker/compose.yml:11-12 header comment still says 'the catalog may run elsewhere' (DCAT-21 wording). Not owned by this group.
- services/catalog-ui/src/api/routes.ts forward(): only content-type is relayed, so an upstream redirect's Location header is dropped (redirect: 'manual'). Harmless today, because neither service redirects on the allowed routes.
- services/prospector/src/collector.ts:233-236 (surveying comment) and services/prospector/src/catalog/queries.ts:1259-1261 (standingOf docblock) still say a killed container is what leaves an open job with nothing surveying it. Startup resume() (index.ts:206) claims open jobs, so the actual causes are a survey loop ended on a fault and an out-of-scope venue. These are prospector's files and were not changed.
- services/prospector/src/collector.ts:224-228 and :252-256 have history phrasing ('This used to report...', 'Asking `some` made it report...'). These are prospector's files and were not changed.
- services/catalog-ui/web/views/Table.tsx:134 and web/views/Market.tsx:13 still use the bybit incremental,500/200 example, and web/App.tsx:16 says 'how a consumer sees a slice of it'. These are outside the catalog group's files.

Remaining after check:
- services/catalog-ui/docker/compose.yml:11-13 (not this group's file): the header still says 'the catalog may run elsewhere', the ambiguous DCAT-21 wording. The compose file also does not pass CATALOG_UI_HOSTS, so the Host allowlist cannot be turned on in the container. The README states this correctly; adding it to compose would be a config change
- services/catalog/src/lenses/scope.ts:13-15 (not this group's file): the docblock says a held scope is 'never stale'. admit() in shared/lenses/src/members.ts inserts lens_member rows and moves partitions_through only when it was exactly partitionId-1, so a scope can lag until catchUp moves it
- services/catalog/src/contents.ts:212-214 (not this group's file): the hostsOf docblock says the address is 'the one the catalog lists and probes'. It is prospector that lists and probes
- shared/lenses/src/members.ts:243-247 (not this group's file): the rebuild() docblock says a lens being rebuilt reads as 'partly the old rules' and partly the new'. catchUp from partition 0 runs whole() in one transaction, so readers see the old rows until the pass commits, as CATALOG-LENSES.md says
- services/prospector/src/collector.ts:225-236 (prospector's file): history ('This used to report...') and the 'killed container' claim behind the surveying flag are still there (DCAT-09's PROSPECTOR side)
- services/catalog-ui/web/App.tsx:16 (not this group's file): says a lens is 'how a consumer sees a slice of it'. The plan's terminology makes a lens a named selection, never a slice
- services/catalog-ui/web/views/Lenses.tsx addressIsSound (code, not docs): the editor's check does not reject the reserved slugs options, size, check and resolve. The catalog refuses them with a 400, and the editor shows that as a failed request
- docs/services/PROSPECTOR.md#lenses (promised anchor, owned by prospector-doc): it does not exist yet. None of the catalog group's files link to it, so nothing here breaks

## messaging-vault — checked; items done 20/20

Code/config gaps:
- services/router/docker/compose.yml: ROUTER_PREFETCH (config.ts, default 500) is not passed through, so it cannot be set via compose. This is config: reported, not changed. ROUTER_MAX_READY and ROUTER_WATCH_QUEUES are already passed, so DCOL-16's compose part has landed.
- packages/service-kit/src/core/runner.ts + plugins/shutdown.ts: an error in the service function shuts down through shutdown(), which calls process.exit(0). For example, the router's consumer connection failing after its startup retries, or pipe's... (pipe catches its own errors and exits 1). So the router exits with code 0 on a startup failure. ROUTER.md says 'shuts down' without naming an exit code. This is in a submodule and was not touched.
- DCOL-02 test suggestion: no check made for a buildPublisherTopology unit test in services/router/tests. Tests are outside docs scope.
- services/vault/src/fs/writer.ts:40-49,75-79 and data/bucket.ts:199-201: after a zipper quarantine (both append and truncate fail), the fresh .csv.gz.tmp has no header row, because writers.has(key) keeps isInitialized true. The read path then takes the first data record as the column names. The owner question from DCOL-03 is still open: add a zipper preamble option, switch to recovery 'none' and handle quarantine in the vault service, or rebuild at seal. VAULT.md documents the current behaviour.

Remaining after check:
- services/hoarder/README.md:46 and services/hoarder/src/venues/kraken.ts (docblock) link docs/venues/KRAKEN.md, which does not exist yet. The plan has the venues-b group create it ('## WebSocket' only). The links resolve once that lands. No change made because the file belongs to another group.
- DCOL-16 config check, reported only: services/router/docker/compose.yml now passes ROUTER_MAX_READY (default 0), ROUTER_WATCH_QUEUES and ROUTER_PREFETCH, so nothing is missing there.

## planning — checked; items done 23/30
Not fully done: DPLT-21:partial, DCAT-20:partial, DSTK-06:partial, DCAT-23:not_done, DPLT-19:partial, DPLT-24:rejected, DPLT-21:rejected

Code/config gaps:
- services/prospector/src/adapters/okx.ts:31-35 — the ruleOnFailure docblock says the 404 'drop' is 'Kept deliberately; see docs/planning/CATALOG.md', but planning/CATALOG.md#prospector calls it temporary, to be removed once the backlog is drained. One of the two must change (owner question). Pass 3 should keep the CATALOG entry consistent with whatever is decided.
- services/hoarder/README.md:40 still says Binance futures 'delivers nothing from our network ... needs verifying before being added' (DCOL-14, a docs change owned by messaging-vault, not code).

Remaining after check:
- No live doc links to docs/planning/ROADMAP.md, which calls itself 'Read this first if you are picking up work'. A repo-wide grep finds only planning/UI.md pointing at it. This is outside planning's files: the docs index or root README owner should add the link.
- docs/planning/mental-model.html: kept in place as the plan says. Owner question: archive it (DPLT-21) or keep it in live planning on purpose.
- docs/planning/COLD.md:12-25 'Not run against Mega' (first real push; first real run of the vault commands; cold audit against real Mega): kept. Nothing in the code or git log shows a real run, and only the owner can confirm (DXC-06/DTL-02).
- docs/planning/CATALOG.md:43-52 Hauler items 1-3 (first haul through backfill-20, untouched files, compare against catalog.bak) and the 'live database is a backup' note: kept. They depend on the live system and can't be checked from code (DXC-07/DCOL-25).
- docs/planning/ROADMAP.md 'Deciding what to do about data we do not want': kept, without its dead link, because DCAT-23 is deferred. The owner decides whether lens `prefer` / cold --prefer-* already solve it.
- docs/planning/ROADMAP.md 'Binance futures is to be added to hoarder': services/hoarder/README.md only says futures 'needs verifying ... before being added'. Owner should confirm the intent. That README also says fstream delivers nothing, while BINANCE.md says /public/ws streams (messaging-vault's file, not changed).
- docs/venues/GATE.md:429-436 still holds the SUN_USDT REST item and sweep proposal that moved to planning/REST.md. Deleting it is venues-b's job and wasn't done when this check ran.
- docs/planning/REST.md beyond the Gate addition: only links were checked (all resolve). It is otherwise as at baseline per instruction 7 (DXC-17/DVEN-18 deferred).

## platform-infra — checked; items done 11/12
Not fully done: DPLT-09:partial

Code/config gaps:
- services/hauler/docker/compose.yml (DATA_ARCHIVES_DIR volume) and services/stocker/docker/compose.yml (DATA_ARCHIVES_DIR, DATA_VAULT_DIR volumes): the :? guards check only the derived paths. With an empty DATA_DIR these resolve to /archives and /vault and pass the guard. DPLT-09 asked for a guard on DATA_DIR itself (or explicit required paths), and that has not landed. catalog and prospector guard CATALOG_DIR the same way.
- docker/prod.node.Dockerfile: the runtime stage is still headed 'Production Stage - Minimal runtime image', but the stage copies the whole built workspace. Comment only; the file is not in this group.
- dx/utils/docker.js ensureNetworkExists: it uses `${COMPOSE_PROJECT_NAME || 'dx'}-network`, but the compose files join `${PROJECT_NAME:-tradebot}-network`. Only the ./tb wrapper creates the right network (dx is a submodule).
- services/_stub/ui/docker/compose.yml: publishes ${UI_PORT:-3000}:3000 with no bind address, so the port is on every host address, unlike the 127.0.0.1 default elsewhere. It also does not pass UI_DIGGER_*_PORT through to the container.
- DPLT-01: I did not check or change the `main` fields in services/*/package.json (outside this group's files).

Remaining after check:
- Config, report only (per plan): compose does not guard DATA_DIR itself. With DATA_DIR empty, the derived variables in .env.example become /archives, /catalog and /vault, which are non-empty. The `:?` guards in services/hauler/docker/compose.yml:47, services/stocker/docker/compose.yml:63-64, services/catalog/docker/compose.yml:40 and services/prospector/docker/compose.yml:58 therefore never fire.
- Out of group, report only: dx/utils/docker.js:59-62,79 creates '${COMPOSE_PROJECT_NAME||dx}-network', but the root .env.example says to leave COMPOSE_PROJECT_NAME unset. The real shared network '${PROJECT_NAME}-network' is created by ./tb, which the infra README describes correctly. dx is a submodule, not edited.
- Out of group, report only: the comment in services/_stub/ui/docker/compose.yml:15 calls UI_REST_PROXY 'required', but it has a default (http://proxy) there and in vite.config.ts.

## prospector-doc — checked; items done 52/52

Code/config gaps:
- services/prospector/src/probe.ts CONFIRMATIONS docblock (~L607-612) says 'Three attempts across a pass' sweeps', but CONFIRMATIONS is {confirmed: 30, assumed: 2} (prospector-satellites, DPR2-17)
- services/prospector/src/context.ts surveying docblock (~L37-42) still argues 'confirming it a hundred times is a hundred requests' on an update; the core already judges by existence (30/2) (DPR2-24 code side; context.ts is assigned to no docs group)
- services/prospector/src/database/schema.ts unreadable.reason comment (~L195-196) describes two reasons, but only 'unread' is ever written (survey.ts:1198; types.ts Unreadable.reason: 'unread')
- services/prospector/src/types.ts Occasion docblock (L337-354): 'partial' 'still reconciles', 'Decided by the request, not by the state', 'An earlier version...' (DPR1-05, prospector-satellites)
- services/prospector/src/sync.ts:356 'A walk never reconciles' comment (DPR1-03, prospector-satellites)
- docs/services/PROSPECTOR.md L165-178 (the model section) still says 'full' and 'partial' both reach the venue by 'reconciling against its instrument listing', and 'never by what a caller asked for'. That is DPR1-05 for a later prospector-doc pass; the new '#### getContext and the occasion' text is correct and can become its home or a pointer
- services/prospector/src/adapters/okx/instruments.ts findEnd / _test_findEnd is dead code (optional cleanup from DPR2-02)
- services/prospector/src/types.ts:337-355 (Occasion docblock): says 'partial' 'still reconciles' and 'Decided by the request, not by the state', and has an 'An earlier version...' history sentence. None of that is true: no getContext reaches a venue, and passFor in sync.ts decides the pass (DPR1-05).
- services/prospector/src/survey.ts:1189-1196: the docblock says 'The file is still catalogued if it carries a date', but the code at :1225-1238 sends an unplaced or unread path to unreadable and skips it (DPR1-09).
- services/prospector/src/types.ts:370-371 (Phase) and services/prospector/src/catalog/queries.ts:1323-1324 (phaseOf): 'never goes back to walking scopes it has already exhausted' reads as if a venue never walks again, while the walk schedule re-walks listable venues. It is true only of the exhausted scopes themselves.
- services/prospector/src/pace.ts:84-87 (paceFor docblock): says a venue's instrument-listing API 'keeps that on a limiter of its own'; in fact API calls (fetchJson, bitget search) are not paced at all
- services/prospector/src/http.ts:37-44 (blocked docblock): presents 'AmazonS3 as the server' as part of the generic S3 test; only bitget's refusesUs reads the server header
- services/prospector/src/http.ts:217-218 (send docblock): 'Every request this service makes to a venue, and the only one' is false; metadata.ts fetchJson and bitget/symbols.ts fetch bypass it
- services/prospector/src/api/lenses.ts:24-29: 'The working out is the long part, and that does take its turn there [the survey's write queue]' contradicts lenses.ts:19-23 ('Not in the queue the survey's writes wait in')
- services/prospector/src/metadata.ts:12-14: history ('This began as okx's, was copied to bitget...')
- services/prospector/src/collector.ts:225-229 and :254-258: history in docblocks ('This used to report...', 'Asking `some` made it report...')
- services/prospector/src/exclusions.ts:22-27 and survey.ts:95: exclusion rows are loaded per venue_id (exclusionsFor) but stored in a map keyed by adapter.name. bybit's two servers therefore overwrite each other's set, so a row written for only one server would leak onto, or be lost from, the other. Today's shipped rows are written for every server of their venue, so nothing breaks yet.

Remaining after check:
- services/prospector/src/pace.ts docblock for paceFor (around line 85, 'A venue that also calls its own API elsewhere — an instrument listing — keeps that on a limiter of its own'): metadata.ts and the adapters' instrument code use no Pace or limiter, and PROSPECTOR.md 'Asking a venue about itself' correctly says these calls pass no pace gate. The file belongs to prospector-satellites, so I left it.
- services/prospector/src/survey.ts:746-750 docblock says twelve attempts are 'a little under seven minutes'. The arithmetic is 422 s, just over seven. This is a code comment owned by prospector-satellites, so I left it.
- docs/services/PROSPECTOR.md 'When an update is a walk' and services/prospector/README.md 'When a venue is walked' both carry the schedule format and the bad-schedule exit-78 paragraph almost word for word. The plan assigns content on this to both files, so I kept both. Merging them is a plan decision.
- PROSPECTOR.md is still about 3,050 lines with some smaller overlap inside the file (for example 'Two things this shorthand gets wrong' repeats the discovery point of the seed section). The split is DPR2-13, which is DEFERRED, so I did not restructure.
- The link checker reports #overdue_days-is-a-decision-not-a-measurement as unresolved, but that is a false positive: its slug function strips underscores and GitHub keeps them, so the anchor resolves. Every other relative link and anchor in the file resolves, and every inbound PROSPECTOR.md# anchor used elsewhere in the repo exists.

## prospector-satellites — checked; items done 27/31
Not fully done: DPR1-12:partial, DXC-01:partial, DPR1-09:partial, DXC-09:partial

Code/config gaps:
- services/prospector/src/survey.ts:1188-1196: the docblock says 'The file is still catalogued if it carries a date', but the code below sends unplaced files to `unreadable` and skips them. This is a docblock-only fix (DPR1-09), owned by this group in a later pass.
- modules/collect/archives/compose.yml:26-27 still has the commented-out archivist include ('Not started — will own the facts database'). DPLT-18 asks for it to be deleted, and that file belongs to another group.

Remaining after check:
- services/prospector/src/database/migrations/seeds/README.md:321 ('After seeding'): links to docs/services/PROSPECTOR.md#bitget. That anchor is promised in DOCS-PLAN.json (prospector-doc group, '#venue-by-venue' with per-venue anchors) but does not exist in PROSPECTOR.md yet. I left the link because the anchor is a promised link target; if prospector-doc does not add it, the link has to drop the anchor.
- services/prospector/src/database/migrations/seeds/README.md ('The floors held' table): the margins above the research floors (85/69/92 days, 8 months) come from the seeding run and cannot be checked against the code or CSVs. The 'earliest first found' column does match the shipped floors (20180725, 20240709, 20250801, 202508/202509). I kept the table because the plan asks for it.

## stocker — checked; items done 32/34
Not fully done: stocker:STK-10:partial, DXC-10:partial

Code/config gaps:
- services/stocker/src/types.ts:146 (Series.instrument docblock) still says 'Rows are split by it, one vault file per instrument'. That is the 'one file per instrument' claim DSTK-03/STK-10 removed from the docs; a month under 1 GB is one @ file. This file is not owned by the stocker docs group.
- modules/store/warehouse/compose.yml:8 (header comment) says 'Parquet vault, one directory per partition'. A partition is a month's files under @ or under per-symbol folders, not a directory of its own. This file is not owned by the stocker docs group.

Remaining after check:
- modules/store/warehouse/compose.yml:8 has a comment saying 'Parquet vault, one directory per partition'. That is wrong: a vault partition is one file under @ or a file per instrument, inside a vault slice directory. The file is not owned by the stocker group, so I left it.
- services/stocker/src/schema/series.ts: the earlier writer commit 1d08da6 changed comments beyond the assigned lines 506-507 (the top docblock about unverified entries, 'Buckets' to 'Periods' at about lines 537, 779 and 870, and okx books 'no spill'). I checked each against the code and they are accurate. I kept them rather than revert them to the false originals, but they go beyond the assigned scope.
- services/stocker/src/schema/project.ts:44-47 still says 'mapping.test.ts drives every series against a real file'. That is false (not every series has a fixture), but the file is not owned by this group.
- Nothing failed verification in the rest. Checked against the current code with no change needed: every constant in STOCKER.md (1 GB split; 32/64 MB tasks and batches, 256 instruments; 64 MB alone; 8 GB pieces; 16 partitions / 2 GB ahead; 1/5 and 2 GB scratch bound; 8x and 1032x expansion; zip 32/64 MB; gather 64 KB / 32 KB / 64 KB; 2 extraction threads; 4 attempts at 2 s doubling; 5-minute sweep; 2015-2035), the ledger columns and marks, ERROR.log format, backedup.csv reading, revision inputs, the outcome table (including noRoom), path levels, canonical column lists, README env vars and defaults, /health on :3000, LOG_LEVEL and TZ, and the extension registry names. Every relative link and anchor in the group's files resolves, and so do the STOCKER.md anchors other docs link to.

## tooling — checked; items done 21/30
Not fully done: DXC-11:partial, DXC-12:partial, DTL-12:partial, DTL-13:partial, DTL-17:partial, tooling-cold:TCL-14:partial, DTL-06:partial, DVEN-16:rejected, DTL-07:partial

Code/config gaps:
- dev/tooling/src/index.ts tools[] (cold entry): the menu describes cold as 'Cold storage: pack, upload, and account for backups', while src/commands/cold.ts says 'Cold storage: pack, upload, and account for what is backed up'. Cosmetic.
- dev/tooling/src/program.ts -e help: 'overrides every other .env file' is accurate for files, but values the shell exported still override it. Consider adding 'the shell still wins'.
- README.md:55 (root, other group): still says 'The `tb` command-line tools' for docs/tooling/, which covers ./tools.
- dev/tooling/src/tools/cold/push/command.ts:27-36 and pull/command.ts:36-44 (DTL-06): the catalog branches still skip each(), so push catalog and pull catalog never call backup.check or backup.save, even though push catalog writes catalog_copy rows to cold.sqlite.
- dev/tooling/src/tools/cold/config.ts:86 (DTL-05): CATALOG_DIR is read only from the env layers, not from modules/collect/archives/.env as CATALOG_PORT and CATALOG_TOKEN are. A CATALOG_DIR set only in that module is ignored unless -m archives is given.
- dev/tooling/src/tools/cold/config.ts:93 (DPLT-11, optional part): an empty CATALOG_PORT still falls back silently to http://localhost:9010. There is no clear error; only the 'waiting for it' message, which names the URL.
- dev/tooling/src/tools/cold/evict/vault.ts (DTL-15): evict vault never reads isWatch(), so `cold evict vault -w` runs once. cli.ts each() repeats the whole round for any command when watching several trees, including audit and stats.
- dev/tooling/src/tools/cold/lock.ts:11-34 (DTL-16/TCL-19): the docblock owned by this group has not been revised yet; it is planned for a later pass.
- dev/tooling/src/tools/cold/push/command.ts:43-48: for archives and vault, --dry-run, --rebase, --keep-snapshot and --drop-snapshot are silently ignored, so 'cold push archives -n' pushes for real. push/vault/index.ts never reads options.lens, so 'cold push vault --lens x' pushes the whole vault without a warning (DTL-07's refuse/warn fix has not landed).
- dev/tooling/src/tools/cold/shared/vault/ledger.ts:44 (stockedIn): only 'updating' and 'outdated' are treated as not stocked. Stocker also writes 'updating-sides' (services/stocker/src/ledger.ts:307), and STOCKER.md#the-ledger says a partition whose last line says it is not stocked. Cold takes such a line as stocked at revision 'updating-sides', so evict may treat a month, and its neighbour's sides, as stocked while stocker is still adding the sides.
- dev/tooling/src/tools/cold/shared/vault/ledger.ts:44-47 (stockedIn): treats a ledger line whose revision is `updating-sides` (written by services/stocker/src/ledger.ts:307) as a real revision instead of as not stocked. The docs describe only `updating` and `outdated`.
- dev/tooling/src/tools/cold/push/vault/work.ts:64: the re-plan while watching calls trusted(config) without { watching: true }. A watched `push vault` that sees an ERROR.log once therefore sets process.exitCode = 1 although it keeps running.

Remaining after check:
- dev/tooling/src/program.ts:22: help mismatch (code, not editable here). The `-m, --module` help text says 'modules/<group>/<name>/.env, or just <name>', but moduleEnvPath in src/shared/utils/env.ts tries modules/<name>/.env first and only then the single modules/<group>/<name>/.env. The README describes the code's order.
- dev/tooling/src/index.ts:44 vs src/commands/cold.ts:38: wording mismatch (code). The menu says 'Cold storage: pack, upload, and account for backups' and the command says '... account for what is backed up'. Harmless, reported as asked.

## venues-a — checked; items done 18/23
Not fully done: DVEN-04:partial, DVEN-28:partial, DVEN-06:partial, DVEN-11:partial, DVEN-28:partial

Code/config gaps:
- none

Remaining after check:
- docs/venues/OKX.md:740 'Not yet established': DVEN-13 step 13 asked for a last-checked date on each open question. Most entries have none, and the source material gives no dates, so none were invented. The 'in a few weeks' wording and the planned re-walk are gone.
- docs/venues/BITGET.md:184-202: the 440 era-2 kline keys are said to be scattered 2019-08-01 to 2023-02-21. docs/planning/BUGS.md (another group's file) reports spot klines with the same two-copy pattern up to 2023-10-31. Whether more pre-2024 era-2 spot keys exist is not settled by either doc. Left as measured, not changed.
- docs/venues/BITGET.md:219: '5,055,779 indexed URLs' is never said to include or exclude the depth_500 tree. That leaves open whether the 374 misfiled books keys fall inside the 'every URL matches exactly one shape' claim. It cannot be checked from code or the baseline, so it is not changed.

## venues-b — NOT YET CHECKED; items done 13/22
Not fully done: DXC-08:partial, DVEN-04:partial, DVEN-11:partial, DVEN-28:partial, DVEN-23:partial, DVEN-25:partial, HOA-13:partial, DSTK-09:partial, DXC-08:partial

Code/config gaps:
- services/stocker/src/schema/series.ts:30 (and the comment at ~:278-280): the docblock says 'nine Binance futures datasets [gained a header] between 2021-01 and 2022-07'. Sampled files show headers on scattered UM files from 2020-01, and every file has one only from 2022-06 (UM monthly), 2022-07 (CM monthly) and 2022-08 (daily). The comment does not name which nine datasets. Positional reading still works, so behaviour is unaffected; only the comment is inaccurate.
- services/prospector/src/database/migrations/006-binance.ts:20-23: the docblock still explains the 1w/3d/1mo refusal (via accepts) by calling them aggregates; it already points to docs/venues/BINANCE.md for the dates. That file is owned by the prospector-doc group, not this one.
- services/stocker/src/formats/csv.ts:38-40 and services/stocker/src/schema/series.ts:415-416: the comments say Bybit added `rpi` to spot in 2025-04. Live files show spot daily files carry `rpi` from 2025-03-13 (BTCUSDT, ETHUSDT); perp `RPI` from 2025-04-03 is right. More important: spot MONTHLY files (BTCUSDT-2025-03 mixed, BTCUSDT-2025-04, -06, -12, 2026-06) keep the five-name header `id,timestamp,price,volume,side` while their rows carry six values. A name-keyed read (header=true) of those files may not just 'not notice'. The stocker group should verify how DuckDB reads a five-name header over six-value rows, and whether monthly spot files are read at all.
- Corrections that belong in other groups' files: PROSPECTOR.md and STOCKER docs that cite 'rpi in 2025-04' for spot should say 2025-03-13 for daily files. The old 'there is no trading/DATAUSDT/' claim is false: trading/DATAUSDT/ has existed since 2026-07-09 (BYBIT.md now says so).

Remaining after check:
- none
