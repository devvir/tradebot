# Owner decisions from the review phase

Unanswered DEFER items are not implemented; unanswered questions on IMPLEMENT items use the reviewer's default.

## A. Deferred items — blocked on the owner (69)

### catalog-ui

- **CUI-21** (high) catalog-ui port published on all interfaces with no auth of its own
  - How should remote operators reach the console: loopback-only by default (with SSH tunnels or a reverse proxy), or a built-in password? Binding to 127.0.0.1 changes how existing remote users reach it.
- **CUI-22** (medium) Lens editor writes the whole definition from a stale local copy: concurrent edits are lost with no warning
  - Do you want optimistic concurrency on lens writes? It changes the API contract of @tradebot/lenses editLens and of both the catalog's and prospector's PUT /lenses/:slug, for a single-operator console where concurrent edits are plausible but rare.
- **CUI-23** (low) Container hardening: whole repo mounted read-write, health port published on all interfaces, upstream URL in 502 bodies
  - Should the shared compose layout split into prod and dev overrides, so prod containers do not mount the checkout? This affects every service, not only catalog-ui.
- **CUI-24** (low) Split Lenses.tsx (1,260 lines) and Surveys.tsx (843 lines) so their pure logic can be exported and tested
  - Schedule the module split as its own refactor, paired with the test suite, before the planned new lens and survey functionality lands?
- **CUI-25** (low) Prospector address is a hard-coded constant, so a host `pnpm dev` cannot reach surveys
  - Make PROSPECTOR_API configurable for host dev runs, or keep it a module-private constant and document the dev limitation?

### catalog

- **CAT-09** (medium) Listing pages still sort the whole remainder of the cursor prefix group; removing that needs a page-reader redesign
  - Is a redesign of the listing page reader (per-series indexed reads merged in JS, or month-by-month widening) worth doing now, given current prefix groups are thousands of files? If series of minute files or many parts per day are expected, approve it; otherwise accept the per-page sort and keep the corrected docs from CAT-06.
- **CAT-10** (medium) Long report settlements and retried creates: synchronous settlement can outlast any sane timeout
  - How should long settlements work: should prospector answer 202 and confirm in the background, or should the catalog cap failed+mismatched keys per report (and at what size)? And should a create whose response was lost be reconciled with a follow-up GET?
- **CAT-26** (low) The public API container mounts the whole repository read-write in every environment
  - Should the /live source mount move into a dev-only compose override for all services (via dx), and may the catalog mount its data directory read-only in prod?
- **CAT-27** (low) The shared lens package's behaviour is tested from the catalog's suite
  - Where should the canonical CATALOG_SCHEMA live so shared/lenses tests can use it: a test-only relative import of prospector's schema.ts, or a new shared package (e.g. shared/catalog-schema)?
- **CAT-28** (low) extensionOf logs a warning per listed file on every request
  - Keep warning on every listing of an unrecognised file family (loud by design), or warn once per directory per process?

### docs-catalog

- **DCAT-23** (low) Rename or split planning/CATALOG.md, and decide whether ROADMAP's 'data we do not want' item is solved
  - (1) Should planning/CATALOG.md be renamed to planning/ARCHIVES.md, split per service (PROSPECTOR/HAULER/CATALOG), or left as a cross-service plan? (2) Does lens `prefer` grain/bundle plus settled partitions fully solve ROADMAP's 'what to do about data we do not want' (a month published in two renderings), so the paragraph can be dropped?

### docs-collect

- **DCOL-17** (medium) 'Vault' names two different stores at one container path, and the vault service has no remaining producer
  - What is the vault service's future? (A) keep it as the BitMEX CSV store: rename it in docs, move its container path off /data/vault, and possibly drop the write API; or (B) deprecate it. This decides whether DCOL-03/04/05/06/24 are worth doing.
- **DCOL-26** (low) RabbitMQ service docs are structured three different ways; choose one convention (hoarder and pipe need no docs/services article)
  - Should the three small RabbitMQ services (router, pipe, hoarder) be README-only (fold ROUTER.md into the router README), or should every service have a docs/services article, as the others do? If DCOL-02/15/16/18/19 are applied first, they go into ROUTER.md and move with it.

### docs-consistency

- **DXC-17** (medium) REST knowledge has three deep homes (docs/REST.md, docs/planning/REST.md, each venue doc)
  - Where should the cross-venue REST comparison live: docs/venues/REST.md, or docs/REST.md kept but made venue-agnostic? And should planning/REST.md survive as a short REST-collector plan, or be deleted? The merge also needs fact-by-fact care across about 950 lines, so it should be its own pass.
- **DXC-32** (low) docs/modules/ holds non-module docs (CATALOG-API, CATALOG-LENSES); warehouse module has no doc
  - Where should docs for shared packages live: a new docs/shared/ (e.g. docs/shared/LENSES.md), or alongside the code as shared/lenses/README.md? And should the warehouse module get its own docs/modules/WAREHOUSE.md?

### docs-platform

- **DPLT-23** (medium) Infra packs: local's queue is commented out, the cache hostname differs between packs, and no current module uses either
  - Are the queue and cache infra packs still wanted? If so, should local run `queue`, and should the cache be reachable as `cache` in every pack? If not, delete the packs and their docs instead of rewriting them.
- **DPLT-24** (low) Delete docs/planning/archived/ (bot plans built on BitMEX and on retired services)
  - Should docs/planning/archived/ (PLAN, BOT, MILESTONES) be deleted, given that git history keeps it, or kept under its 'records why' policy?
- **DPLT-25** (low) The vault service is deployed by no module and collides with 'the vault' (Parquet)
  - Retire or rename services/vault? And should the cold tooling's `Origin` type be renamed (e.g. to `Tree`), or 'origin' simply defined in VOCABULARY?
- **DPLT-26** (low) The Python Dockerfiles are unused
  - Keep the Python Dockerfiles (planned use) or delete them?

### docs-prospector-2

- **DPR2-13** (medium) Structure: "## Venues" holds ~750 lines of the series model, and several subjects are explained two or three times in one file
  - Do you want PROSPECTOR.md split into an overview plus PROSPECTOR-SERIES.md (data model and rules) and PROSPECTOR-TRANSPORT.md (pacing and transport), or kept as one file with the duplicates removed? If split, should the split happen in the same pass as the content fixes (DPR2-01..12) or right after them, so the same text is not edited twice?

### docs-tooling

- **DTL-20** (low) Restructure the tooling docs for a fresh start (per-tree pages, shared COLD.md, a CLI README)
  - Do you want the cold docs reorganised per tree (COLD-ARCHIVES/VAULT/CATALOG/AUDIT, with COLD.md holding the shared material) and a new docs/tooling/README.md for ./tools? If yes, do it after DTL-01..19, since those fixes define the content.

### docs-venues

- **DVEN-18** (medium) Per-venue REST facts have three homes: the venue docs, docs/REST.md and docs/planning/REST.md
  - Should docs/REST.md be cut to the cross-venue depth table plus links, or merged into docs/planning/REST.md? Also confirm that planning/REST.md's per-venue 'The API'/'Behaviour' bullets can be reduced to links into the venue docs.
- **DVEN-29** (low) The venue docs share no structure in their Archives sections (template rewrite, CI link check)
  - Approve a fixed section template for docs/venues/*.md (the one above, or an amended one), and decide whether to add a docs link/anchor check to CI. After that, the reorder proceeds one PR per venue.

### hauler

- **HAU-14** (medium) No resume: any mid-body error, or a stop, discards the partial of a large file and restarts from byte 0
  - Is resuming large downloads worth the added complexity (resume state that must stay valid across addresses and restarts, sweepPartials keeping partials, a redesigned store invariant)? If so, within one process only, or across restarts too? How flaky is the haul machine's link in practice?
- **HAU-16** (low) A persistent mismatch (served bytes disagree with the venue's own description) is re-downloaded on every walk
  - When a venue persistently serves bytes that disagree with its own listing, should hauler back off re-fetching it (how many walks?) or keep re-fetching every walk as today? The reviewer's 'never re-fetch while unchanged' was judged harmful by the verifier.
- **HAU-21** (low) Venues and their addresses are read from the catalog once at startup and never refreshed
  - Is restart-to-pick-up-new-venues acceptable (new venues need a prospector deploy anyway), or should hauler refresh /venues while running? If refresh: is the loop-lifecycle and shutdown complexity worth it?

### hoarder

- **HOA-17** (medium) Frames are published to an exchange with no bound queue, no mandatory flag and no publisher confirms, so they are discarded until a consumer binds
  - Who owns durability of hoarder's output: should hoarder declare its own capped durable queue (what cap and overflow policy), or should the future consumer own its queue with frames dropped until it binds? Are publisher confirms wanted in packages/rabbitmq?
- **HOA-24** (low) Envelope has no connection epoch, so reconnect gaps are invisible; HOARDER_REPLICAS duplicates every stream
  - What envelope contract should the future normaliser get: a per-socket connection id and/or explicit open/close control messages? And is running several hoarder replicas meant for redundancy (then define dedup keys) or not (then remove `scale:` or require disjoint HOARDER_VENUES)?
- **HOA-25** (low) Compose bind-mounts the whole repository read-write into the container in every environment
  - Adopt a repo-wide dev-only compose override for the /live source mount (and which form: per-service compose.dev.yml or one root override)?
- **HOA-26** (low) Venue.unsubscribeFrame is required and implemented four times but never called
  - Will hoarder change channels at runtime (keep unsubscribeFrame, narrowed to one channel), or should it be removed?

### infra

- **INF-19** (medium) RabbitMQ runs on the EOL 3.12 series while the README claims 3.13
  - When should the broker upgrade happen, and on which hosts? Do any queues rely on transient non-exclusive or mirrored semantics that 4.x drops?
- **INF-20** (medium) The whole monorepo, every .env file included, is bind-mounted writable into every container, prod included
  - How should per-environment compose overrides work: a change to dx, compose profiles, or an include selected by APP_ENV? Does any dev workflow write to /live from inside a container?
- **INF-21** (medium) Prod image ships the whole monorepo with dev dependencies for every service, and the install layer is invalidated by any edit
  - Is a `pnpm deploy`-based slim prod image wanted now? It needs validation on a docker host, and it pairs naturally with INF-20's dev override.
- **INF-28** (low) nx and @nx/vitest are installed and configured but unused, and .github holds only Nx Cloud CI skills and agents for a CI the repo does not have
  - Remove nx and all its Nx Cloud boilerplate, or adopt it as the task runner?
- **INF-29** (low) Env parsing, retry/backoff and the vault ledger format are copied across packages and behave differently
  - Where should the shared env, retry and vault-format code live (shared/utils or a new shared/vault package)? Should dev/tooling depend on it?
- **INF-30** (low) shared/lenses runs SQL against tables defined in prospector's migrations, and catalog's tests keep a hand-copied schema
  - Which package owns the catalog.db schema: prospector, or shared/lenses (or a new schema package)?
- **INF-31** (low) Two brokers per host each use the 60%-of-host-RAM watermark, and no container has a memory limit
  - What memory budget should each host give the brokers and stocker?
- **INF-32** (low) Stocker downloads the DuckDB excel extension at runtime into the container's ephemeral home
  - Must store hosts work with restricted egress? If so, pre-install the extension in the image. Otherwise persisting it under the vault dir is enough.

### prospector-catalog

- **PRC-04** (medium) putFiles withdraws catalogued paths the survey filtered out (excluded/refused/unplaced) as if the venue had withdrawn them
  - What should happen to an already-catalogued file that the reader now declines (excluded, refused by accepts, or no longer placed)? Leave it untouched, or remove it under a distinct non-venue cause such as 'excluded'?
- **PRC-23** (medium) Three indexes on the largest tables have no production reader
  - Do you use file_when, file_partition or revision_when for ad-hoc sqlite3 queries or operations (e.g. 'what changed since' through revision_when)? If not, may they be dropped from the schema and from the live catalog?
- **PRC-24** (low) seriesFor/patternsOf scan and copy every venue's series on each call
  - Is preamble latency on large unseeded venue onboarding a concern? If yes, choose between local memoisation now or a byVenue index within the registry/state refactor.
- **PRC-25** (low) Registry identities omit variant although one URL shape may publish into two slices
  - Is a URL shape's identity independent of variant (enforce one variant per shape and refuse otherwise), or may one shape serve two variants (widen the registry keys)?
- **PRC-26** (low) queries.ts is a 1,932-line grab bag with duplicated SQL and three statement-cache schemes
  - Do you want the catalog restructured before the new functionality lands: queries.ts split by subject plus a single per-database state object owning registries, counters and statement caches? If yes, agree the module boundaries first.

### prospector-walk

- **PRW-28** (low) Retry-After is uncapped and a pause cannot interrupt it, and refine's wait for the victim partition is not bounded by SPLIT_MS
  - Should Retry-After stay 'honoured as sent, never capped', or get a sanity ceiling (for example pacing.ceilingMs) above which the pace latches instead of sleeping in-request? And is threading a stop signal through fetchPage/fetchHead/waitOut (a ListingContext interface change) acceptable now, or should it wait for a broader per-venue abort token?
- **PRW-29** (low) Listing GETs follow redirects to any host or scheme and read bodies of any size into memory
  - Do any venues rely on listing redirects today? Is it acceptable to log res.redirected hosts for a week and then switch listings to redirect:'manual' (or same-origin https only)? What body ceiling is acceptable per format?
- **PRW-30** (low) Every service's compose mounts the whole repository read-write at /live, including in prod
  - Should the repo-wide /live bind mount move into a dev-only compose override for all services (a cross-service change outside prospector), and should a bad walk schedule keep the container down (restart: on-failure) rather than restart-loop under unless-stopped?

### router-pipe

- **RTP-03** (high) The source is acked before the broker confirms the republish (no confirm channel, no mandatory flag, publisher never flushed or closed): messages are lost on a broker or connection fault
  - Which delivery guarantee should the router give: at-least-once with publisher confirms (needs a `confirm` option in @devvir/rabbitmq, plus mandatory/return handling and some throughput cost), or the current at-most-once on faults, documented as such? If at-least-once, will the rabbitmq submodule owner add confirm channels, or should the router own a confirm channel itself?
- **RTP-15** (medium) Backpressure keeps up to prefetch deliveries unacked for the whole pause; RabbitMQ 3.12 consumer_timeout (30 min) then closes the consumer channel
  - While downstream queues are full, should the router stop consuming (cancel and re-consume, so no delivery is held), nack and requeue held deliveries periodically, or keep holding them under a raised consumer_timeout policy? And is maxReady a soft limit (overshoot of up to one prefetch is acceptable)?
- **RTP-16** (medium) No poison-message policy: failures are requeued forever with no retry limit and no dead-lettering
  - What should happen to a message that keeps failing: dead-letter it (through a RabbitMQ policy, with an exchange or queue to be named), drop it after N retries, or keep retrying forever with backoff? Who owns the DLX and its consumers?
- **RTP-23** (low) Graceful shutdown neither cancels the raw consumers nor drains in-flight handlers, and never closes the publisher
  - Should service-kit gain an ordered pre-shutdown (drain) phase that runs before providers disconnect, or should the router stop using the provider broker and own both broker lifecycles? Decide together with RTP-02's follow-up and RTP-03.

### shared

- **SHR-07** (medium) Two parallel BitMEX schema registries: unused TABLE_SPECS + @tradebot/types vs vault's TABLE_HEADERS/TABLE_CASTS, already disagreeing
  - Which package owns the BitMEX table schema going forward (for the replay work): delete TABLE_SPECS and @tradebot/types, or move vault's TABLE_HEADERS/TABLE_CASTS into shared and make them the single source of truth? Are TABLE_SPECS's keys/filter wanted for replay?
- **SHR-08** (medium) Shared CSV format writes null, undefined and '' identically, so null updates in websocket deltas are lost
  - Does captured BitMEX traffic carry explicit nulls or empty strings in update messages? If yes, approve a versioned three-state CSV encoding (absent / \N / "") and decide how existing vault files are handled.

### stocker

- **STK-04** (high) Withdrawn files stay on disk under canonical names, so a partition holding one never matches the catalog again
  - Where does partition file identity come from? (a) catalog returns confirmed file keys+sizes per partition (new prospector/catalog API), or (b) hauler/prospector moves withdrawn files aside (e.g. `.withdrawn` suffix). This also defines the hauler/catalog/stocker archive contract: which files under a partition's directories are 'the partition'. Meanwhile, should the safe diagnostic stopgap (distinct log when withdrawn > 0) land now?
- **STK-15** (medium) Rows that share a timestamp are written in no fixed order (no tie-breaker; parallel sort is not stable)
  - Is the order of rows within one timestamp part of the vault's contract? If yes, which tie-breaker per table, and is a restock of the affected tables (trades etc.) acceptable given some archives may be gone?
- **STK-27** (low) Splitting by instrument rescans the whole temporary table once per instrument
  - Is the per-instrument COPY cost significant on real bybit option / OKX chain months? Approve a measurement run, and the PARTITION_BY rewrite only if it is.
- **STK-28** (low) A side's revision ignores the version of the series that reads the neighbour's files (era cuts)
  - Should side revisions track the neighbour-era series version (safe, revision-stable variant), or is it acceptable to require a manual restock when an era-cut series is re-versioned?
- **STK-29** (low) SIGTERM exits immediately mid-placement; DuckDB connections are never closed
  - Do you want a graceful drain on planned restarts? If so: what to wait for (placement only, not joins), the timeout, and the compose stop_grace_period.
- **STK-30** (low) Duplicated build logic and oversized decide/stock/build.ts
  - Do the module split of build.ts and the decide/stock restructuring now, as part of the pre-feature 'fresh start' (it overlaps the planned new functionality), or after STK-01/03/05 land? Approve the small helpers (a,c,d,e) now?

### stub-ui

- **SUI-11** (medium) Data sources are hard-wired to BitMEX and the digger replay backend, none of which exist; no environment can produce data
  - What will this UI talk to (vault-backed REST, a new replay service, another venue)? Until then, should the live/testnet/replay envs, DiggerClient and the replay proxy rules be deleted, or kept dormant behind a single env-driven source config?
- **SUI-23** (low) Orderbook and Recent Trades re-render on every WS message with no frame batching
  - Pick up together with wiring a real data source (SUI-11)? No decision beyond timing is needed.
- **SUI-24** (low) ReplayClock: set-clock fires on every partial edit, parses local time while the chart shows UTC, widgets keep pre-seek state
  - Remove the replay UI (ReplayClock, DiggerClient, replay env) until a new replay backend exists, or keep and fix it now against the old set-clock contract?
- **SUI-25** (low) Fabricated market figures and an always-on 'Online' indicator beside live data; fetch failures are invisible
  - Should the static mock chrome (ContractBar stats, BottomBar prices, Sidebar order form, BitMEX branding) be removed, labelled as placeholder, or wired to data? Is a connection-status API on WsClient wanted now?
- **SUI-26** (low) Vite dev server published on all interfaces with the whole monorepo mounted
  - Should service ports (this UI and the others) bind to loopback by default with an opt-in bind variable, or stay published on all interfaces?

### tooling-cold

- **TCL-15** (medium) Archives pulled back are evicted again on the next evict run, and the docs contradict each other on whether that is intended
  - After `cold pull archives`, should the pulled partition stay on disk until the operator says otherwise (needs a 'pulled' marker), or be eligible for eviction again immediately (rewrite the evict docs)?

### tooling-other

- **TOT-21** (low) Untrusted raw message bodies and queue/container names written unescaped to the terminal
  - No owner decision needed. Deferred only as a standalone change: the implementer should fold it into TOT-02 when that rewrite touches the code, and otherwise leave it.

### vault

- **VLT-19** (medium) Crash recovery: resuming a .csv.gz.tmp does not repair a torn final member, and files recreated after quarantine (or 0-byte tmps) get no header
  - Should resume repair (truncate to last complete gzip member) and 'write the CSV header whenever the target file is (re)created, including after quarantine' be added to @devvir/zipper (preamble/onCreate option), or implemented in vault (startup scan of open .tmp files plus moving the header decision into the write chain)? Is a startup scan of large open files acceptable?
- **VLT-20** (medium) Decide vault's role: live writer or read-only server of the BitMEX CSV.gz archive
  - Will vault ingest live rows again (any producer planned for POST /rows, /close, PUT, DELETE), or should it become a read-only server of the existing BitMEX archive, with the write machinery deleted rather than fixed?
- **VLT-29** (low) Unauthenticated API published on all host interfaces, repo mounted read-write at /live, requestTimeout = 0
  - Must vault's port 8000 be reachable from outside the compose network? If not, may the publish be dropped (or bound to 127.0.0.1)? Should the read-write /live mount be moved to a dev-only override repo-wide?
- **VLT-30** (low) Synchronous filesystem calls on request paths
  - Is event-loop blocking on degraded storage a concern worth a state cache, or is the cheap writers.has(key) short-circuit plus converting non-hot paths enough?

## B. Implemented with the reviewer's default unless the owner says otherwise (58)

### catalog-ui

- **CUI-14** (low) Dead version-skew fallbacks for first/previous/probing, computed three different ways
  - Replacing the hand-mirrored lens types in web/types.ts with `import type` from @tradebot/lenses goes against the stated design ('types are mirrors') and adds a build-order coupling. Keep mirrors, or import?

### docs-catalog

- **DCAT-05** (medium) UI.md and the _stub/ui README describe an unbuilt architecture, unread env vars and gone backends
  - Should the BitMEX-era replay/time-machine design in UI.md be kept as docs/planning/UI.md, or deleted along with UI.md? Separately, is the _stub/ui service itself worth keeping now that both its backends are gone?

### docs-collect

- **DCOL-02** (high) ROUTER.md examples that put a queue on an explicit exchange deliver nothing to that queue
  - Optional code change: should a destination queue on a topic exchange be bound with '#', or should destinations accept an explicit binding key (e.g. reuse `(key:X)`)? Direct exchanges have no wildcard and would need an explicit key. If you change it, also fix buildConsumerTopology (topology.ts:47-48), which defaults a direct-exchange source to '#' (a literal there), and add a direct-source test.
- **DCOL-03** (medium) VAULT.md write-safety, serialisation and restart sections describe an implementation that no longer exists; quarantine leaves a headerless file
  - How should a post-quarantine file get its header? (a) add a zipper option (preamble/onFreshFile) that writes a header member before the re-append; (b) switch vault to recovery 'none' and handle quarantine itself (header + member); (c) track quarantined keys and rebuild the file at seal. This is moot if vault is deprecated (DCOL-17). The trigger is rare: both the append and the truncate must fail.
- **DCOL-15** (medium) ROUTER.md health section describes responses the router never gives
  - Optional: do you want a real health signal (a healthCheck listener answering 503 when consumer.getChannel() is null)? If so, implement and document it separately.
- **DCOL-25** (low) Planning items on hauler have landed or are out of date
  - Minor: are planning/CATALOG.md items 1-3 still open on the live system, and is the one-page cold audit report going to be rebuilt (keep or delete the BUGS.md entry)?

### docs-consistency

- **DXC-06** (medium) planning/COLD.md lists landed work as not built, with a broken reference
  - Have `cold push`, the vault commands, `pull archives` and `audit` run against real Mega yet? The answer decides which "first real run" items stay. This is a sub-question; the decision on the item is still IMPLEMENT.
- **DXC-07** (medium) planning/CATALOG.md and planning/BUGS.md hold landed or unverifiable entries
  - Is the first haul through backfill-20 finished, and are Hauler items 2-3 still pending? This is a sub-question; the decision on the item is still IMPLEMENT for the clearly stale lines.
- **DXC-11** (medium) Tooling docs: `cold` missing from the tooling README, env precedence wrong, root README calls the tools `tb`
  - dev/tooling/.env overrides an explicit `-e` file. Is that intended? The docs should describe the code as it is; if it is not intended, changing it is a separate code change.
- **DXC-13** (medium) Infra pack, redis and rabbitmq READMEs contradict the compose files and each other
  - Should the market pack name its cache `cache`, extending services/redis the way local does, so that CACHE_URL works on every pack? If not, the infra README documents the difference between packs.
- **DXC-15** (medium) docs/services/UI.md and the UI stub README describe things that are not there
  - Should services/_stub/ui stay where it is or move to services/.deprecated/? The doc fixes are the same either way.
- **DXC-23** (low) Vault service README misses VAULT_COMPRESSION_LEVEL; no service README says what deploys it
  - Should vault, router, pipe and hoarder move to services/.deprecated/? The doc fixes stand either way.

### docs-platform

- **DPLT-04** (medium) ROADMAP lists as open work items that have already landed or that name code that no longer exists
  - Is a floor audit of the seeded venues (okx, bitget) against the catalog still wanted? If not, delete the section outright.
- **DPLT-06** (medium) planning/COLD.md lists cold audit and cold pull archives as unbuilt, and points to a missing legacy doc
  - Has a first real end-to-end `cold push` (or vault run) happened since 2026-10-07? If so, cut that item too.
- **DPLT-17** (low) ROADMAP has broken links and cites BUGS entries that no longer exist
  - Is 'a survey is decided by its worst partition' still planned work, so that planning/SCOPING.md should be written? And is the okx day-major grouping problem real, so that it should get a BUGS entry?

### docs-prospector-1

- **DPR1-11** (medium) 'partition', 'run' and 'revision' mean different things in PROSPECTOR.md than in VOCABULARY.md
  - Optional: should code identifiers (openPartitions, refinePartition, partitionId for run scopes) be renamed to 'scope' later, so code and docs agree? That is a code decision outside this docs pass.
- **DPR1-16** (medium) Run kinds and `establishedAt` are described wrongly: no `probe` run rows exist, and establishedAt is not walk-only
  - Should 'probe' be removed from RunKind (types.ts:1328), with tests/catalog.test.ts:746-749 updated? That is a small code change; tsc would flag any remaining use.
- **DPR1-23** (low) Plans and conditional futures inside a tech doc
  - Are the delimiter-map pass or a history of passes live intentions? If so, add a line under 'Prospector' in docs/planning/CATALOG.md; otherwise drop them.
- **DPR1-25** (low) PROSPECTOR.md justifies gate's `probingLag` of 1 by walks that do not run on most updates
  - Should gate declare `probingLag: 3` (or 2), like the other adapters, given its measured p99 of 28.0h and that most of its updates probe? If yes, add it to src/adapters/gate.ts with the standard docblock and update the table cell.

### docs-stocker

- **DSTK-07** (medium) Canonical schemas have no complete home; the column lists omit margin, four tables are missing, and the unproduced `settlement` table is listed
  - Delete the `settlement` table from tables.ts and the Table union in types.ts? No series produces it and no code or test references it. Or keep it as a planned table and list it in planning/STOCKER.md?
- **DSTK-12** (medium) 'The monthly per-instrument rendering [of okx funding] is not mapped' is false: the same entry reads it and rank() prefers it
  - If a monthly okx fundingrates file turns out to have different columns from the daily bundle, should it get its own Series, or should the entry be restricted by bundle so only the daily bundle is read? This needs a real downloaded sample first.
- **DSTK-13** (medium) okx swap trades for 2021-10, published with every trade twice, are stocked as published and no stocker doc says so
  - How should okx perp trades for 2021-10 be handled? (a) Keep them as published, which is documented. (b) Skip the month by adding a month bound to the series. (c) Dedupe on trade_id, which needs a rule for the side, and the data cannot supply one. Any change needs a series version bump.
- **DSTK-22** (low) The revision inputs are listed incompletely; the ledger-check description is imprecise; repair timing is incomplete
  - Should the 'outdated' passage (STOCKER.md:275-276) become 'An outdated partition keeps its files and is read like any other; they are not what its archives would stock today' (pure provider definition)? Or is 'not a partition to copy elsewhere until stocked again' meant as the mark's own definition?

### docs-tooling

- **DTL-01** (high) Rabbit README says the command fetches recent messages; it actually removes the oldest ones from the queue
  - Should `rabbit <queue>` become a non-destructive peek (and watch a copy-via-temporary-queue), or stay destructive with clear warnings in the docs?
- **DTL-02** (medium) docs/planning/COLD.md lists built work as unbuilt and points at a missing file
  - Have the first real `cold push` and the first real run of the vault commands happened? That decides whether those two planning items stay.
- **DTL-03** (medium) Docs say evict is the only command that removes anything; audit deletes outright, bypassing the trash
  - Should audit's disk removals go to the trash (discard(..., false)) like evict's? If yes, change disk.ts and document that instead.
- **DTL-05** (medium) Cold's configuration has no correct home: wrong source file, missing variables, wrong defaults, CATALOG_DIR ignored from the module
  - Should cold read CATALOG_DIR from the archives module's .env, as it already does for PORT and TOKEN, or should the docs just state that it doesn't?
- **DTL-08** (medium) dev/tooling README gives the wrong env-file precedence and documents RABBITMQ_MGMT_URL, which nothing reads
  - Should the precedence change so that -e beats dev/tooling/.env, which is what most people expect from a flag? If yes, change env.ts and document that order instead.
- **DTL-11** (low) Legacy README describes reclaim.ts wrongly, lists rebuilt checks as missing, and names tests that cannot run
  - Once the gap check and the one-page report are written into planning, can the whole legacy/ folder, tests/tools/cold/legacy/ and their tsconfig/vitest excludes be deleted? That would suit the requested fresh start.
- **DTL-12** (low) No doc lists the whole record (7 tables), every cold path, or the fact that audit and stats take no lock
  - Should audit take a lock before applying fixes that write to the record? It currently holds none, so it can race a running push or evict. If the answer is no, document why.
- **DTL-15** (low) COLD.md says -w works for 'evict', but `cold evict vault` never watches, and `all -w` loops any command
  - Should each() honour -w only for commands built to watch, so that `cold audit all -w` stops looping for ever?

### docs-venues

- **DVEN-07** (medium) BITGET.md describes discovery from the v2 and v3 listings and the non-crypto refusal as catalog behaviour; the code reads v3 only
  - Should bitget discovery also read the v2 listings, so that v2-only instruments (classic coin-margined, v2 delivery contracts, demo product types) are found? If so, file it in docs/planning/. Not required for this doc fix.
- **DVEN-16** (medium) BINANCE.md mixes catalog design, waste figures and cold-storage state into the venue description
  - Is BINANCE.md L324-332 ('Its raw cannot be reclaimed yet' / month-first eviction) still true? If yes, it moves to docs/tooling/COLD.md in the present tense; if not, delete it. The rest of this item does not wait on the answer.

### hauler

- **HAU-05** (medium) Waits cannot be interrupted at shutdown and Retry-After has no upper limit, so a stop can overrun the grace period and lose page reports
  - (Non-blocking: implement with the default.) What ceiling should a venue's Retry-After get: 30 min (LONGEST_OUT_MS, same as the default backoff) or 1 h? Honouring a long Retry-After is defensible. The cap only guards against absurd values.
- **HAU-08** (medium) Docs claim an old mtime marks a file the catalog no longer lists; files downloaded in earlier passes are never listed again and keep old dates, so following the docs would delete good archives
  - (Non-blocking.) With the claimed property gone, is touch() still worth keeping? If nothing reads mtime, it could be dropped. That would also remove the EPERM trigger in HAU-01. Do you want a non-pending 'audit pass' that would make 'old date = unlisted' true (a planning item)?
- **HAU-11** (medium) HAULER.md breaks the repo's doc rules: duplicates the catalog's key-layout article (with a diverged level name), duplicates the report contract, contains history, and frames hauler around prospector
  - (Non-blocking.) Should the layout rationale (separators, inode cost, '@' ordering) move into CATALOG-API.md, or simply be cut?
- **HAU-24** (low) The multipart-ETag explanation is repeated in two docblocks; Retry-After and jitter helpers duplicate prospector's
  - (Non-blocking.) Move the Retry-After/jitter helpers into shared/utils, or leave the two 10-line copies?

### hoarder

- **HOA-05** (high) No liveness detection: hung handshakes, half-open and silent sockets go unnoticed while health stays green
  - Should hoarder adopt per-venue silence deadlines (and what values), and should /health report unhealthy when any configured venue is stale rather than only when all are? The latter touches shared/utils/src/services.ts used by other services.

### infra

- **INF-03** (high) The shared external network name never matches what `tb` creates, and the only workaround (COMPOSE_PROJECT_NAME) merges every module into one compose project
  - Keep the network name tradebot-network (PROJECT_NAME), as assumed here, or adopt dx's convention? Will you change dx upstream to derive the network from PROJECT_NAME so the `tb` bootstrap can be removed later?
- **INF-04** (high) catalog-ui (an unauthenticated proxy that adds CATALOG_TOKEN), the catalog, Redis, RabbitMQ, vault and every :3000 health port are published on all host interfaces
  - Should catalog-ui get its own credential, such as a CATALOG_UI_PASSWORD checked as basic auth before forwarding, or a CATALOG_UI_WRITE flag that otherwise allows only GET/HEAD? Today it gives token-holder rights to anyone who can reach it. Is remote access over an SSH tunnel acceptable with the loopback default?
- **INF-07** (medium) Compose project and container name collisions: infra/store and warehouse are both project "store", local and bootcamp are both "infrastructure", and a bare `tb up` starts every pack
  - Is resetting bootcamp's queue-rt volume acceptable, or should the volume be migrated? Alternatively, keep bootcamp as `infrastructure` and rename local.
- **INF-08** (medium) Infra config contradicts itself: market's Redis answers as `redis` while CACHE_URL targets `cache`; local has no `queue` although docs say it does; stale VAULT_URL and REGISTRY_* entries
  - Should the local pack run `queue` again (uncomment it), or is it intentionally queue-rt only?
- **INF-18** (medium) Floating base-image tags, and unused Python Dockerfiles that pull uv:latest and run as root
  - Is a Python service coming soon? If so, keep the Python images and pin and harden them instead of deleting them.
- **INF-22** (low) RabbitMQ, Redis and infra-pack READMEs, .github/copilot-instructions.md and .gitignore describe things that do not exist
  - Are the cold tools invoked as `tools cold` or through `tb`? This decides the wording in README.md:55.
- **INF-27** (low) Coverage thresholds fail and are enforced nowhere; credential-redaction and service-bootstrap helpers in shared/utils have 0% coverage
  - Should coverage be enforced in CI, or should per-package thresholds be lowered to their measured values? Either way, do not keep a `test:coverage` script that always fails.

### prospector-catalog

- **PRC-01** (high) reconcile deletes series that still have file/wip rows: FOREIGN KEY constraint failed wedges the venue's pass
  - Optional follow-up, not blocking: should a series whose files are all withdrawn carry a marker (e.g. bounds reflecting 'no live files') distinct from 'never discovered'? Today first === null means the latter, so the fix leaves the bounds alone.
- **PRC-20** (low) Production-dead and test-only API in the catalog barrel
  - Are unenrol and unreadable (the reader of the survey's unreadable-paths worklist) wanted by the upcoming missing functionality, e.g. an endpoint? If not, delete them.

### router-pipe

- **RTP-17** (low) Republish is not property-faithful: it forces persistent, stamps a missing contentType as application/json, lets injected headers override existing ones, and key replace is unanchored and expands $-patterns
  - (Upstream) Should @devvir/rabbitmq Exchange.republish preserve the original properties exactly, without the persistent/contentType defaults? That is the only way to keep a missing contentType missing.
- **RTP-21** (low) Pipe only adds bindings: removing or narrowing a rule in PIPE_BINDINGS leaves the old binding active (undocumented)
  - Should pipe reconcile its bindings (tag them with an argument such as x-declared-by=pipe and unbind tagged bindings that are no longer configured, through the management API, which needs credentials and a host), or stay additive with a documented manual cleanup? Note that adding the tag changes binding identity, so existing untagged bindings would not match.
- **RTP-22** (low) Dead code, weak typing and duplicated topology helpers with inconsistent defaults (wrong type shown in the route log)
  - Should SKFactory accept an explicit RabbitMQ URL (so services can pass their sanitised config URL), or should sanitizeUrl be removed from service configs? This affects every service.

### tooling-cold

- **TCL-03** (high) Once-stored tars moved back to 'planned' are deleted with their partition map by the next plan(); audit applies this unasked, even on an empty listing
  - Should there be a dedicated terminal 'lost' state for tars (and vault files) that were stored but Mega no longer holds correctly - kept in the record, excluded from storedOf/pullableOf, reported by audit/stats, and never replanned while any partition is evicted? And should planTar keep a per-venue-month high-water mark so a dropped tar's remote name is never reused?
- **TCL-08** (medium) evict --cleanup gets past its 'not with --watch' guard when several trees are watched
  - Should `cold evict --watch` with no selection keep re-evicting the whole vault every round (and therefore files pulled with `cold pull vault`)? COLD-EVICT.md:7 says the vault is evicted 'on request, by a selection' while the evict/vault.ts docblock calls an empty selection ordinary housekeeping; pick one and make both agree.
- **TCL-22** (low) The catalog push never checks that prospector stayed stopped during the long snapshot copy
  - Should the catalog snapshot be taken with VACUUM INTO or the SQLite backup API (consistent by construction) instead of a raw byte copy of catalog.db, accepting that the stored file is no longer byte-identical to the live one?
- **TCL-29** (low) Every command makes a full VACUUM INTO copy of the record and reads it whole into memory to hash it
  - Should read-only commands and dry runs skip the backup check/save, and should the VACUUM be skipped when the db and -wal size/mtime match what sent.json recorded at the last send?

### tooling-other

- **TOT-09** (medium) sync-env: empty or '/' path targets the remote root; overwrites every remote .env without confirmation; files land world-readable; walks .deprecated/dx/dot-dirs
  - Should sync-env include dev/tooling/.env (cold tooling may run on the server) and dx/**? Should it back up or diff remote files before overwriting, or restrict the set to root, services/*/.env and modules/*/*/.env? Those parts are left out of the IMPLEMENT scope.
- **TOT-12** (low) sync-env reports 'N file(s) synced' and exits 0 after failures; find exit 1 aborts the sync
  - Should the transfer move to a single connection (tar over ssh with umask 077, or rsync -R --chmod=F600)? That transport rewrite is deferred until an owner decides how files should be transferred.
- **TOT-16** (low) `-v/--verbose` does nothing; debug logger helpers unused
  - Remove -v, or wire it to LOG_LEVEL=debug? The default here is to remove it.
- **TOT-17** (low) Root README calls docs/tooling 'the `tb` command-line tools'; `./tb` carries the dx template banner
  - tb is copied from the dx template. Is it fine to diverge from the template banner? If not, apply only the README change.
