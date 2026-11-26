# Review: docs-platform

## Overall assessment

The platform docs are not usable as a reference today. docs/DATA_PIPELINE.md says of itself that it is outdated, and it still makes wrong claims: that stocker reads every collector's output, that raw data lands in the vault service, and a vault layout keyed by `table=`. docs/ROADMAP.md is a plan that sits outside docs/planning/. Several of its items have already landed (book series, grain/bundle preference, the DATA_VAULT_DIR guard, the seed rebuilds) or name code that no longer exists (`scattered`, `subject`, adapter floors, `.pNN.tar`). It also has broken links (SCOPING.md, a missing CATALOG anchor, BUGS entries that are gone). The infrastructure docs (docker/README.md, modules/infra/README.md and the rabbitmq and redis READMEs) describe another system: node.Dockerfile, npm, DB_* URLs, modules such as archivist and packer, the `redis` hostname, and RABBITMQ_* ports. REST facts are written three times. VOCABULARY.md holds service internals, one of them false (hauler fetches file by file, not whole partitions), and it does not define 'origin', which means two different things. planning/COLD.md tells readers to build commands that already exist.

Two code and config defects surfaced along the way and should be fixed first. (1) docker/prod.node.Dockerfile starts dist/index.js, but every service builds to dist/src/index.js, so every prod image crash-loops. (2) Every .env.example writes `KEY=   # comment` after an empty value. Docker compose reads the comment text as the value; I reproduced this with compose v5.7.1: `QUEUE_USER=  # (required)` gives `'# (required)'`. Copying an example unedited therefore breaks services, for example prospector rejecting PROSPECTOR_VENUES as an unknown venue.

Recommended restructure for the fresh start. (a) Tech docs, present tense only, one home each:
- README.md: what the project is, today's chain in one paragraph (archives -> catalog -> hauler -> stocker -> Parquet vault; WebSocket capture parked; REST and replay not built), how to run it (`tb` for modules via dx/, `./tools` for host tooling via dev/tooling), and a complete docs index.
- DATA_PIPELINE.md: about one page, holding the source-priority principle and the running chain, with no history or plans.
- VOCABULARY.md: definitions only, plus the missing terms.
- Infrastructure docs: rewritten from the compose and Dockerfile sources, with providers described on their own terms and the pack-to-hostname mapping only in modules/infra/README.md.
- REST: per-venue facts only in docs/venues/<VENUE>.md; docs/REST.md stays as a shallow cross-venue summary.
- docs/bitmex/: stays where it is, as a doc of a dataset this repo collected (it names services, so it cannot go under docs/venues/), with its working logs moved out or summarised.
(b) Planning: move ROADMAP.md into docs/planning/, cut every landed item and every broken link, give each open item one home, cut planning/REST.md down to the collector plan, clean BUGS.md and planning/COLD.md, and move mental-model.html out of live planning.
(c) Owner decisions before investing further: whether the queue and cache infra packs are needed at all (no current module uses them; only the parked hoarder, router and pipe would), whether to retire the vault service, and whether to delete the archived bot plans.

Cross-unit notes from the reviewer, out of this unit's scope:
- docs/venues/BYBIT.md:154-155 names 'the prospector', which breaks the venue rule.
- The bybit adapter comment ('No limit was found on this bucket') contradicts BYBIT.md ('It bans an address that asks too fast').
- The prospector compose file has a dangling comment about an HTTP/1.1 ceiling.
- planning/STOCKER.md:110 calls `symbol=` a vault key, but the layout uses a plain `<symbol>/` directory.
- services/.deprecated/README.md is accurate; only its pointer to planning/REST.md should follow DPLT-12.

Sequencing for the implementer: do DPLT-15 (the ROADMAP move) together with DPLT-04, DPLT-17 and DPLT-21, because they all edit ROADMAP.md. DPLT-03 and DPLT-05 share README.md:18-20. DPLT-05, DPLT-12, DPLT-15 and DPLT-20 all touch the README Documentation table.

## Summary

| id | severity | category | decision | title |
|---|---|---|---|---|
| DPLT-01 | high | correctness | IMPLEMENT | Prod Node Dockerfile starts dist/index.js, but every service builds to dist/src/index.js |
| DPLT-02 | high | config | IMPLEMENT | Every .env.example puts comments after empty values, and docker compose reads the comment text as the value |
| DPLT-03 | medium | docs | IMPLEMENT | DATA_PIPELINE.md says it is outdated, still makes wrong claims, and is full of history and plans |
| DPLT-04 | medium | docs | IMPLEMENT | ROADMAP lists as open work items that have already landed or that name code that no longer exists |
| DPLT-05 | medium | docs | IMPLEMENT | README.md: wrong tooling pointer, incomplete doc index, inaccurate module and env claims |
| DPLT-06 | medium | docs | IMPLEMENT | planning/COLD.md lists cold audit and cold pull archives as unbuilt, and points to a missing legacy doc |
| DPLT-07 | medium | docs | IMPLEMENT | docker/README.md describes a Dockerfile and an npm build that do not exist |
| DPLT-08 | medium | docs | IMPLEMENT | modules/infra/README.md describes packs, hostnames, variables and modules that do not exist |
| DPLT-09 | medium | config | IMPLEMENT | Root .env.example: dead variables, wrong role notes, and DATA_DIR not guarded |
| DPLT-10 | medium | config | IMPLEMENT | archives .env.example: CATALOG_DIR default that does not exist, and a venue list missing bitget |
| DPLT-11 | medium | config | IMPLEMENT | The host cold tooling falls back to catalog port 9010, but the archives example leaves CATALOG_PORT empty, which means a random port |
| DPLT-12 | medium | docs | IMPLEMENT | REST knowledge is written three times: docs/REST.md, docs/planning/REST.md and each venue doc |
| DPLT-13 | medium | docs | IMPLEMENT | VOCABULARY.md describes how services and tools work, and the Partition and Revision entries are false |
| DPLT-14 | medium | docs | IMPLEMENT | services/rabbitmq/README.md gets the version, port variables, hostname and env file wrong |
| DPLT-15 | low | docs | IMPLEMENT | ROADMAP is a plan outside docs/planning/, repeats other docs, and misuses 'market' and 'origin' |
| DPLT-16 | low | docs | IMPLEMENT | VOCABULARY.md does not define 'origin', has an ambiguous 'vault', and leaves out widely used terms |
| DPLT-17 | low | docs | IMPLEMENT | ROADMAP has broken links and cites BUGS entries that no longer exist |
| DPLT-18 | low | docs | IMPLEMENT | The first BUGS.md entry is about a legacy tool and a facts store that no longer exist |
| DPLT-19 | low | docs | IMPLEMENT | BITGET.md says era-1 and era-2 copies are identical, which an open BUGS entry contradicts |
| DPLT-20 | low | docs | IMPLEMENT | docs/bitmex mixes a dataset reference with working logs that cite missing tools |
| DPLT-21 | low | docs | IMPLEMENT | mental-model.html (bot design) sits in live planning, unlinked |
| DPLT-22 | low | docs | IMPLEMENT | services/redis/README.md has wrong commands, defaults and hostname |
| DPLT-23 | medium | config | DEFER | Infra packs: local's queue is commented out, the cache hostname differs between packs, and no current module uses either |
| DPLT-24 | low | docs | DEFER | Delete docs/planning/archived/ (bot plans built on BitMEX and on retired services) |
| DPLT-25 | low | docs | DEFER | The vault service is deployed by no module and collides with 'the vault' (Parquet) |
| DPLT-26 | low | config | DEFER | The Python Dockerfiles are unused |

## DPLT-01: Prod Node Dockerfile starts dist/index.js, but every service builds to dist/src/index.js

- **Severity:** high
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:** `docker/prod.node.Dockerfile:52-62`, `docker/node/entrypoint.sh:23`, `docker/README.md:83`, `services/*/package.json (main)`, `services/stocker/tsconfig.json:1-9`

**Problem.**

Every service tsconfig is composite with include src/**/* and no rootDir, so tsc writes dist/src/index.js. The prod image sets WORKDIR /app/services/${SERVICE_NAME} and runs `exec node ... dist/index.js`, which fails with MODULE_NOT_FOUND. Compose selects docker/${APP_ENV:-prod}.node.Dockerfile, so any prod deployment, or one with APP_ENV unset, crash-loops under restart: unless-stopped. docker/README.md and each package.json `main` repeat the wrong path.

**Evidence.**

All nine services (catalog, catalog-ui, hauler, hoarder, pipe, prospector, router, stocker, vault) have dist/src/index.js and no dist/index.js. .dockerignore excludes dist/, and the builder runs `pnpm run build` (tsc -b), so the image has the same layout. The dev entrypoint and each service's `start` script already use dist/src/index.js. Both verifiers confirmed at high.

**Fix.**

Change the last line of docker/prod.node.Dockerfile to `CMD ["/bin/sh", "-c", "exec node --max-old-space-size=${NODE_MEMORY_MB} dist/src/index.js"]`. In every services/*/package.json, set `main` to `dist/src/index.js` or remove it. In docker/README.md, make the requirement 'entry point compiled to dist/src/index.js'. Do not switch to rootDir: src, which is a larger change and breaks the dev entrypoint and the start scripts.

**Tests to add.**

Run `APP_ENV=prod docker compose -f services/stocker/docker/compose.yml build`, then `docker run --rm <img> ls dist/src/index.js`, and check that a prod container stays up. Add a cheap guard (a CI step or test) that asserts services/<s>/dist/src/index.js exists after `pnpm build` and that the path in the prod CMD matches it.

**Verifier notes.**

Both verifiers confirmed it at high. The reviewer filed it as a docs finding, but it is a code defect.

## DPLT-02: Every .env.example puts comments after empty values, and docker compose reads the comment text as the value

- **Severity:** high
- **Category:** config
- **Decision:** IMPLEMENT
- **Locations:** `.env.example:15`, `.env.example:23`, `.env.example:33-34`, `.env.example:45`, `modules/collect/archives/.env.example:42`, `modules/collect/archives/.env.example:48-49`, `modules/store/warehouse/.env.example:11`, `modules/store/warehouse/.env.example:14-15`, `dx/utils/docker.js:152-176`

**Problem.**

Lines of the form `KEY=<spaces># text` do not give an empty value under docker compose's --env-file parser (the mechanism dx uses); the value is the literal string `# text`. Copying an example unedited breaks things. QUEUE_USER, QUEUE_PASS and CACHE_PASS become '# (required)'. DATA_DIR becomes '# Host data root', so the derived bind mounts are invalid and compose aborts with a cryptic 'undefined volume'. PROSPECTOR_VENUES, HAULER_VENUES and STOCKER_VENUES carry comment text, and prospector throws 'unknown venue' (services/prospector/src/config.ts:66). HAULER_LENS, STOCKER_LENS and CATALOG_TOKEN get bogus values.

**Evidence.**

The first verifier found this while checking DPLT-09 (F10). The consolidator reproduced it with Docker Compose v5.7.1: an env file containing `QUEUE_USER=        # (required)` makes `docker compose config` show `A: '# (required)'`, while a bare `DATA_DIR=` gives `""`. `grep -nE '^[A-Z_]+=\s+#'` finds the 11 lines listed.

**Fix.**

In the root, archives and warehouse .env.example files, move every comment that follows an empty value onto its own line above the variable, and leave the value truly empty (`KEY=`). Fix any comment content in the same pass (see DPLT-09 and DPLT-10). Check dev/tooling/.env.example for the same pattern; the grep found none there.

**Tests to add.**

For each module, run `docker compose -f <compose> --env-file .env.example config` and confirm the empty variables come out as "". Add a lint step in CI or a tooling check that fails on `^[A-Z_]+=\s+#` in any .env.example.

**Verifier notes.**

This is a new finding. It comes from the F10 verifier's test, not from the reviewer, and the consolidator reproduced it independently. It is rated high because the examples are the documented way to set up, and following them breaks prospector and the queue credentials.

## DPLT-03: DATA_PIPELINE.md says it is outdated, still makes wrong claims, and is full of history and plans

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/DATA_PIPELINE.md:3-11`, `docs/DATA_PIPELINE.md:63-65`, `docs/DATA_PIPELINE.md:80-93`, `docs/DATA_PIPELINE.md:97`, `docs/DATA_PIPELINE.md:106-108`, `docs/DATA_PIPELINE.md:116-125`, `docs/DATA_PIPELINE.md:127-142`, `docs/DATA_PIPELINE.md:144-159`, `README.md:12-20`, `README.md:25`, `README.md:51`

**Problem.**

The doc opens with an 'Outdated, do not use as a reference' banner, which breaks 'only what is true today', yet README.md:25 and :51 still send readers to it. Line 97 says stocker reads every collector's output; line 118 of the same doc and the code say it reads only the archives. 'Where raw lands' presents the vault service as a destination, but no module deploys it. The vault layout says `table=`, while the real key is `dataset=`, with interval, kind, depth and aggregated levels and `<symbol|@>/<YYYYMM>.parquet`. Lines 82, 116-125, 139-142 and 144-159 are history or plans.

**Evidence.**

services/stocker/src/config.ts sets only archivesDir, vaultDir and catalogApi. services/stocker/src/vault.ts:13-14 has the real layout. modules/collect/archives/compose.yml and modules/store/warehouse/compose.yml do not include services/vault. VAULT_URL appears only in .deprecated/scribe and tardy.

**Fix.**

Rewrite docs/DATA_PIPELINE.md in the present tense, about one page, and remove the banner.
1. Keep the two-layer intro (13-28) and Source priority (30-47) as the single home of the bulk -> REST -> WS principle. Reduce README.md:12-16 and planning/REST.md:20-31 to a pointer each.
2. Keep the Collectors table. Replace 63-65 with 'hoarder is not deployed by any module'.
3. Replace 'Where raw lands' (80-93) with two entries. The archives: host directories hauler writes, pointing to HAULER.md. The Parquet vault: stocker's. Mention the vault service only as the layout BitMEX's collected data is in, pointing to bitmex/README.md and services/VAULT.md.
4. Line 97: '[stocker] reads the archives and writes one partitioned Parquet vault'. Partitioning bullet: 'Hive keys venue=, market=, dataset=, then interval=, kind=, depth= or aggregated= where the table has one; one directory per instrument (`@` for venue-wide files), one file per month', pointing to STOCKER.md or STOCKER-PARTITIONS.md.
5. Delete 116-125, 139-142 and 144-159. Reduce Replay to 'Replay is not built', with a pointer to the roadmap. Move any wanted plans to docs/planning/.
6. Fix README.md:18-20 to 'One service, stocker, reads the archives ...'.

**Tests to add.**

Grep the rewritten doc for 'was', 'once', 'will', 'yet', 'table=', 'origin' and 'Outdated'. Rerun the link check over docs/.

**Verifier notes.**

Confirmed. The verifier lowered it from high to medium because the banner already warns readers. The user asked for a fresh start, so implement.

## DPLT-04: ROADMAP lists as open work items that have already landed or that name code that no longer exists

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/ROADMAP.md:90-92`, `docs/ROADMAP.md:135-136`, `docs/ROADMAP.md:184-185`, `docs/ROADMAP.md:222-228`, `docs/ROADMAP.md:230-235`, `docs/ROADMAP.md:243-247`, `docs/ROADMAP.md:266-275`

**Problem.**

Each of these items is landed, gone or stale:
(a) Order-book series are reported unmapped; they are mapped for all seven venues.
(b) The okx and bitget seed rebuilds are reported as in progress; they are done. Only okx's temporary 'drop' remains.
(c) 'Data we do not want' is called unsolved; lenses have grain/bundle `{ prefer }`, and cold pull has --prefer-* flags.
(d) The DATA_VAULT_DIR guard is listed as open; it exists.
(e) `scattered` and `subject` no longer exist.
(f) The 'adapter floor' audit: adapters have no floors; floors live in the seeds.
(g) The `.pNN.tar` naming is wrong; parts are `<venue>-<YYYYMM>.<NNN>.tar`.
(h) The 'week or two' estimate is stale.

**Evidence.**

services/stocker/src/schema/series.ts maps books at :360, :476, :636, :703-734, :828, :851 and :902. planning/CATALOG.md:87-88 says the seeds were rebuilt. shared/lenses/src/rules.ts and docs/modules/CATALOG-LENSES.md:59-79 cover grain/bundle preference. dev/tooling/src/tools/cold/shared/vault/trusted.ts:19-20 is the DATA_VAULT_DIR guard. dev/tooling/src/tools/cold/config.ts has tarName. Grep finds no `scattered` or `subject` in src.

**Fix.**

In docs/ROADMAP.md (or its new path, see DPLT-15):
- Change 135-136 to 'Archives are mapped, order books included; what is left is in planning/STOCKER.md'.
- Replace 222-228 with one line: okx's temporary `'drop'` on 404 (ruleOnFailure in services/prospector/src/adapters/okx.ts) is removed once its backlog is drained, pointing to planning/CATALOG.md#prospector.
- Delete 230-235 and 266-275.
- Delete 243-247, or restate it as 'compare each seeded venue's seed floor (okx, bitget) against min(date) in the catalog'.
- Delete the `.pNN.tar` sentence (184-185) and the estimate (90-92).

**Tests to add.**

Grep the roadmap for `.pNN`, `scattered`, `subject`, 'week or two' and 'adapter's floor'.

**Verifier notes.**

Confirmed. Lowered from high to medium because the change is doc-only, but it matters because the roadmap calls itself the entry point for picking up work.

**Owner question.**

Is a floor audit of the seeded venues (okx, bitget) against the catalog still wanted? If not, delete the section outright.

## DPLT-05: README.md: wrong tooling pointer, incomplete doc index, inaccurate module and env claims

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `README.md:6-8`, `README.md:18-20`, `README.md:22-23`, `README.md:45`, `README.md:49-57`, `README.md:52`, `README.md:55`, `README.md:59-61`

**Problem.**

Line 55 says docs/tooling/ covers `tb`; it covers `./tools cold` (dev/tooling), and `tb` is dx/. ./tools is never mentioned. Line 52 says there is 'one reference per service', but there is no HOARDER.md or PIPE.md. The Documentation table omits ROADMAP, VOCABULARY and REST. Line 45 says every module directory has a .env.example; the infra packs have none. Lines 59-61 (no venue names outside docs/venues/) conflict with docs/bitmex being listed at line 57. The replay wording (6-8, 22-23) and 'every collector's output' (18-20) overstate what exists.

**Evidence.**

./tb execs dx/dx.js. ./tools runs dev/tooling/dist/index.js. Every file in docs/tooling is COLD-*.md. `ls docs/services` lists CATALOG-UI, CATALOG, HAULER, PROSPECTOR, ROUTER, STOCKER-PARTITIONS, STOCKER, UI and VAULT.

**Fix.**

- Line 55: '`docs/tooling/` | `./tools` (dev/tooling): cold storage and other workspace commands; `tb` (compose orchestration) is documented in dx/'.
- Add rows for VOCABULARY.md, REST.md (at its final path, see DPLT-12) and the roadmap (docs/planning/ROADMAP.md, see DPLT-15).
- Line 52: 'one technical reference per documented service; hoarder, pipe and router are not wired into any module', or add short HOARDER.md and PIPE.md.
- Line 45: 'Each app module (modules/collect/archives, modules/store/warehouse) carries a .env.example; the infra packs under modules/infra/ read the root .env'. Verify against how dx loads env.
- Lines 6-8 and 22-23: phrase replay as a goal ('not built yet; see the roadmap').
- Lines 18-20: 'One service, stocker, reads the archives'.
- Lines 59-61: carve out docs/bitmex as a dataset doc (see DPLT-20).

**Tests to add.**

Run a link check over README.md. Diff the Documentation table against `ls docs docs/*/`.

**Verifier notes.**

Confirmed. The verifier judged points 4 and 5 (replay tense, 'every collector') weaker, since line 6 says 'the goal is'. Soften them rather than rewrite.

## DPLT-06: planning/COLD.md lists cold audit and cold pull archives as unbuilt, and points to a missing legacy doc

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/planning/COLD.md:7-11`, `docs/planning/COLD.md:13-18`, `docs/planning/COLD.md:34-35`, `docs/planning/COLD.md:37-39`

**Problem.**

The file tells readers to build `cold audit` and `cold pull archives`, which both exist. It cites legacy/docs/COLD-EVICT.md, which does not exist. It says COLD-AUDIT.md 'still describes audit as designed', but COLD-AUDIT.md now documents the rebuilt audit. The reviewer's line numbers (141-167) were wrong; the file has 41 lines, and the corrected numbers are used here.

**Evidence.**

dev/tooling/src/tools/cold/audit/ has index.ts and checks for disk, mega, record, staging and tars. pull/archives/{index,bring,survey}.ts exist. pull/command.ts offers archives and vault. There is no legacy/docs directory.

**Fix.**

- Rewrite 7-11: push, evict, pull and audit work on both the archives and the vault, with links to docs/tooling/COLD*.md.
- Replace 13-18 with one pointer to dev/tooling/src/tools/cold/legacy/README.md.
- Delete 34-35 and 37-39.
- Keep the open items (first real push, first real vault run, evicting archives against a partly-away vault, withdrawn partitions). Fold in anything legacy/README.md says the rebuilt audit does not yet do.
- Before deleting 'first real push', ask the owner or check whether it has happened.

**Tests to add.**

Grep COLD.md for 'not built' and check each remaining claim against the dev/tooling/src/tools/cold/ tree. Run a link check.

**Verifier notes.**

Confirmed. The verifier corrected the line numbers.

**Owner question.**

Has a first real end-to-end `cold push` (or vault run) happened since 2026-10-07? If so, cut that item too.

## DPLT-07: docker/README.md describes a Dockerfile and an npm build that do not exist

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docker/README.md:7`, `docker/README.md:17`, `docker/README.md:32`, `docker/README.md:46-56`, `docker/README.md:62-68`, `docker/README.md:83`

**Problem.**

The README documents node.Dockerfile, npm ci, a prod-only install and a 'minimal final image'. The real files are dev/prod.node and dev/prod.python Dockerfiles chosen by APP_ENV. The prod build uses pnpm and copies the whole built workspace. The dev image (runs from the /live bind mount through docker/node/entrypoint.sh, with dist built on the host first) is undocumented. The .dockerignore list is wrong.

**Evidence.**

`ls docker` lists dev.node.Dockerfile, prod.node.Dockerfile, dev.python.Dockerfile, prod.python.Dockerfile, node/entrypoint.sh and python/entrypoint.sh. prod.node.Dockerfile does `RUN pnpm install`, then `COPY --from=builder /app .`. .dockerignore lists .env, .env.local, .env.*.local, docs/ and README.md.

**Fix.**

Rewrite the README around what exists:
1. Compose selects `docker/${APP_ENV:-prod}.node.Dockerfile`, and the root .env.example sets APP_ENV=dev.
2. dev: runtime only (node 22-alpine with dumb-init, curl, bash and corepack), runs as `node` from /live through entrypoint.sh, and starts services/$SERVICE_NAME/dist/src/index.js. Build on the host first with `pnpm build`.
3. prod: a builder stage (pnpm install, pnpm run build), then a runtime stage with the whole workspace, starting dist/src/index.js (see DPLT-01).
4. Build args: SERVICE_NAME (required) and NODE_MEMORY_MB (default 2048). Port 3000 is exposed for health.
5. List the real .dockerignore entries.
6. Mention the Python variants (uv sync) in one line.
7. Change the compose snippet to `dockerfile: docker/${APP_ENV:-prod}.node.Dockerfile`.
8. Delete the npm and minimal-image claims.

**Tests to add.**

Grep the README for 'npm' and 'node.Dockerfile' with no prefix. Check each listed file exists.

**Verifier notes.**

Confirmed, lowered to medium because using the old snippet fails loudly at build time.

## DPLT-08: modules/infra/README.md describes packs, hostnames, variables and modules that do not exist

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `modules/infra/README.md:5-10`, `modules/infra/README.md:24`, `modules/infra/README.md:26-36`, `modules/infra/README.md:44-48`, `modules/infra/README.md:62`, `modules/infra/README.md:70`, `modules/infra/README.md:80`, `modules/infra/README.md:86-88`, `modules/infra/local/compose.yml (header comment)`, `modules/infra/shuttle/compose.yml (header comment)`

**Problem.**

The README says the local pack provides `queue`, but that service is commented out. It gives the cache hostname as `redis`, but local names it `cache`. It documents DB_* URLs, and there is no database. It names modules that do not exist (archivist, collector, archeologist, packer, gui, concierge, student, witness). Its in-page anchors are broken. Its replay and REST statements are plans written as fact. 'Start the infra pack before the app modules' is true of no current module, since archives and warehouse need no pack.

**Evidence.**

In modules/infra/local/compose.yml the queue service is commented out, and cache is `container_name: cache`. The market pack includes services/redis/docker/compose.yml (service `redis`). No DB_* variable exists anywhere. The only modules are collect/archives and store/warehouse.

**Fix.**

Rewrite the README to cover only what the compose files provide, as one table of pack -> services (hostnames):
- local: queue-rt, cache
- store: queue, queue-rt
- market: queue, queue-rt, redis
- bootcamp: queue-rt
- shuttle: queue
Then state that the current modules (archives, warehouse) need no infra pack, and that the broker is used only by hoarder, router and pipe (QUEUE_URL -> host `queue`). This README is the consumer-side home of that mapping. Delete the DB_* paragraphs, the nonexistent module names, the replay and REST claims, and the per-pack sections and their anchors. Also fix the stale header comments in local/compose.yml and shuttle/compose.yml. Compose changes are owner decisions (DPLT-23).

**Tests to add.**

Run a link check. Check every hostname in the table with `docker compose -f modules/infra/<p>/compose.yml config --services`.

**Verifier notes.**

Confirmed at medium. The verifier noted that nothing deployed today breaks, because no running module uses QUEUE_URL or CACHE_URL.

## DPLT-09: Root .env.example: dead variables, wrong role notes, and DATA_DIR not guarded

- **Severity:** medium
- **Category:** config
- **Decision:** IMPLEMENT
- **Locations:** `.env.example:4-5`, `.env.example:17-20`, `.env.example:23-25`, `.env.example:27-30`, `.env.example:35`, `.env.example:39-42`, `.env.example:44`, `services/hauler/docker/compose.yml`, `services/stocker/docker/compose.yml`

**Problem.**

REGISTRY_* variables are read by nothing. QUEUE_RT_URL is read by nothing. The VAULT_* variables serve only services/vault, which no module deploys. The role notes are wrong: local has no `queue`, and no pack runs a registry. DATA_DIR is not marked required, and the `:?` guards sit on the derived DATA_ARCHIVES_DIR and DATA_VAULT_DIR. Once DPLT-02 is fixed, a truly empty DATA_DIR yields /archives and /vault, which pass those guards and get bind-mounted at the host root.

**Evidence.**

`grep -rln REGISTRY_` matches only .env.example. QUEUE_RT_URL appears only in .env.example and in modules/infra/README.md:33. The verifier tested this: with a bare `DATA_DIR=`, compose mounts /archives. The containers run as uid 1000 against that root-owned directory, so they get EACCES rather than writing to the root filesystem.

**Fix.**

- Mark DATA_DIR as required in a comment on its own line above the variable.
- Guard DATA_DIR itself in the hauler and stocker compose files (`${DATA_DIR:?DATA_DIR is not defined}`), or require DATA_ARCHIVES_DIR and DATA_VAULT_DIR explicitly instead of deriving them.
- Delete the REGISTRY section and QUEUE_RT_URL.
- Mark the Vault Service section as the settings of services/vault, which no module deploys. Deleting it depends on DPLT-25.
- Correct the role notes: queue -> store, market, shuttle; queue-rt -> local, store, market, bootcamp; cache -> local (as `cache`) and market (as `redis`).

**Tests to add.**

With `DATA_DIR=` empty, `docker compose ... config` for hauler and stocker must fail with 'DATA_DIR is not defined'. `grep -rn REGISTRY_` should return nothing.

**Verifier notes.**

Confirmed. The verifier corrected the failure scenario: as the file stands, the inline comment (DPLT-02) breaks compose before any mount happens. The silent /archives mount is real only once the comment is moved off the line, so both fixes must land together.

## DPLT-10: archives .env.example: CATALOG_DIR default that does not exist, and a venue list missing bitget

- **Severity:** medium
- **Category:** config
- **Decision:** IMPLEMENT
- **Locations:** `modules/collect/archives/.env.example:9-11`, `modules/collect/archives/.env.example:16`, `modules/collect/archives/.env.example:42`, `modules/collect/archives/.env.example:48-49`

**Problem.**

The comment says CATALOG_DIR 'defaults under the shared data root'. Nothing supplies that default, and both the prospector and catalog compose files use `${CATALOG_DIR:?...}`, so compose aborts. The PROSPECTOR_VENUES list omits bitget, which prospector registers.

**Evidence.**

The root .env.example has no CATALOG_DIR. services/prospector/docker/compose.yml:61 and services/catalog/docker/compose.yml:39 both guard it with `:?`. services/prospector/src/venues.ts:32 registers bitget.

**Fix.**

- Replace lines 9-11 with: 'Required: compose refuses to start without it. Any absolute path works; the container path is fixed and private.' Do not mention the cold tooling here; its fallback belongs in dev/tooling/.env.example.
- Alternatively, add `CATALOG_DIR=${DATA_DIR}/catalog` to the root .env.example, and only then say it has a default.
- Line 42: move the comment above the variable (DPLT-02) and list binance,bitget,bybit,gate,htx,kucoin,okx. Do the same for 48-49.

**Tests to add.**

`docker compose --env-file` config with CATALOG_DIR empty should give the documented error. Diff the venue list against VENUE_NAMES in services/prospector/src/venues.ts.

**Verifier notes.**

Confirmed. The verifier adjusted the fix so the provider's doc does not name its consumer, the cold tooling.

## DPLT-11: The host cold tooling falls back to catalog port 9010, but the archives example leaves CATALOG_PORT empty, which means a random port

- **Severity:** medium
- **Category:** config
- **Decision:** IMPLEMENT
- **Locations:** `modules/collect/archives/.env.example:29-33`, `dev/tooling/.env.example:18-21`, `dev/tooling/src/tools/cold/config.ts:84-94`, `dev/tooling/src/tools/cold/config.ts:149-160`, `services/catalog/docker/compose.yml:46`

**Problem.**

tools cold runs on the host. It reads CATALOG_PORT from modules/collect/archives/.env and falls back to 9010. With the empty value the example recommends, docker publishes the catalog on a random port, and every catalog call from cold push, evict, pull and audit fails to connect. The consumer's doc (dev/tooling/.env.example) never says it needs a fixed port.

**Evidence.**

config.ts: `getEnv('CATALOG_URL','') || `http://localhost:${archives['CATALOG_PORT'] || 9010}``. The catalog compose publishes `${CATALOG_PORT:-}:8080`.

**Fix.**

- Fix the consumer side first. In dev/tooling/.env.example above CATALOG_URL, write: 'The tooling runs on the host, outside the docker network, so it needs the catalog on a known host port. Unset, CATALOG_URL is http://localhost:<CATALOG_PORT from modules/collect/archives/.env>, or 9010 when that is empty. Set CATALOG_PORT in the archives module on any host where tools cold runs, or set CATALOG_URL here.' Mirror this in docs/tooling/COLD.md if it covers configuration.
- In the archives .env.example, drop 'which is the right answer', or set `CATALOG_PORT=9010` as the example value, without naming tools cold.
- Optional: make the tooling fail with a clear message instead of guessing 9010.

**Tests to add.**

With CATALOG_PORT empty, a cold command should produce a clear message, if the optional guard is added. With CATALOG_PORT=9010, `tools cold audit` reaches the catalog.

**Verifier notes.**

Confirmed. The verifier located the real gap in the consumer's doc, under the CLAUDE.md dependency rule.

## DPLT-12: REST knowledge is written three times: docs/REST.md, docs/planning/REST.md and each venue doc

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/planning/REST.md:156-644`, `docs/planning/REST.md:11-15`, `docs/planning/REST.md:20-31`, `docs/REST.md:37-203`, `docs/venues/BINANCE.md:334`, `docs/venues/BYBIT.md:348`, `docs/venues/OKX.md:950`, `docs/venues/GATE.md:462`, `docs/venues/HTX.md:455`, `docs/venues/KUCOIN.md:70`, `docs/venues/BITGET.md:729`, `README.md:59-61`, `services/.deprecated/README.md`

**Problem.**

planning/REST.md:156-644 repeats a full per-venue REST section for all seven venues. That is measured venue fact, not plan, and it copies figures from docs/venues/<VENUE>.md#REST. docs/REST.md repeats some of them a third time. The copies will drift apart.

**Evidence.**

Binance's 6,000/2,400/400 weights and the shared fapi/dapi budget appear at planning/REST.md:162-168, docs/REST.md:57-58 and BINANCE.md:365-377. Bitget's `x-mbx-used-remain-limit` appears at planning/REST.md:598, REST.md:185 and BITGET.md:760.

**Fix.**

1. For each venue, diff planning/REST.md (Binance 156-231, Bybit 232-312, OKX 313-392, Gate 393-457, HTX 458-522, KuCoin 523-589, Bitget 590-644) against the venue doc's '## REST' section. Move any missing facts, such as the 'What there is' sizing, into the venue doc in the present tense, without naming services.
2. Delete planning/REST.md:156-644. Keep the intro, Why REST, The answer (33-108), the method note (110-155), Across the venues (645-737) and 'What was not established'. Fix the line-15 pointer.
3. Keep docs/REST.md as the shallow cross-venue summary. Trim figures that only repeat venue limits, so that the 190-203 table is that doc's one place for them. Moving it to docs/venues/README.md is optional.
4. Add it to the README Documentation table. Update services/.deprecated/README.md's pointer if anything moved.

**Tests to add.**

A grep for '2,400' and 'x-mbx-used-remain-limit' should find only the venue doc and, at most, the docs/REST.md summary table.

**Verifier notes.**

Confirmed. The verifier judged docs/REST.md acceptable as a shallow summary that defers to the venue docs; the real breach is in planning/REST.md.

## DPLT-13: VOCABULARY.md describes how services and tools work, and the Partition and Revision entries are false

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/VOCABULARY.md:62-64`, `docs/VOCABULARY.md:69-71`, `docs/VOCABULARY.md:82-83`, `docs/VOCABULARY.md:97-98`, `docs/VOCABULARY.md:103-104`, `modules/collect/archives/.env.example:46`, `services/hauler/docker/compose.yml:3`

**Problem.**

Partition says it is 'downloaded ... whole, or not at all', but hauler fetches file by file and a partition can be half on disk. Revision says it changes with 'how it is stocked', but versions.ts says the opposite. The Run, Snapshot and Catalog entries describe service internals, which CLAUDE.md forbids in VOCABULARY.md.

**Evidence.**

services/hauler/src has no notion of a partition. fetch.ts writes .part and .bak per file. services/stocker/src/versions.ts:6-22 says a revision never moves for a change to the code that produces it. services/catalog/src/api/listings.ts serves 'the catalog as one S3 bucket', so the Catalog line is accurate, though internal. The hauler comments that say 'each venue as a bucket' are the inconsistent ones.

**Fix.**

- Partition: keep the definition. Replace the 'atom' sentence with 'the unit the catalog versions and the vault is stocked in', or drop it.
- Revision: 'What identifies one stocking of a partition in the vault. It changes when the partition's version does, or when what stocking writes for it changes.'
- Run: 'One pass of discovery over a venue's archives.' Move the one-unfinished-run rule to docs/services/PROSPECTOR.md.
- Snapshot: 'The catalog's database as it was at one moment, whole.' Move the incremental mechanics to docs/tooling/COLD-CATALOG.md.
- Catalog: 'The record of every file each venue's archives publish, each under its canonical key.' Move the one-bucket API to docs/services/CATALOG.md.
- Check the hauler 'bucket per venue' comments against the one-bucket listing.

**Tests to add.**

Grep docs/ for anything that relies on the old Partition or Revision wording.

**Verifier notes.**

Confirmed. The verifier weakened point 4 (Catalog): the one-bucket claim is accurate, and the hauler comment is the inconsistent text.

## DPLT-14: services/rabbitmq/README.md gets the version, port variables, hostname and env file wrong

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `services/rabbitmq/README.md:3`, `services/rabbitmq/README.md:15-18`, `services/rabbitmq/README.md:22`, `services/rabbitmq/README.md:29-30`, `services/rabbitmq/README.md:37-40`, `services/rabbitmq/README.md:48`

**Problem.**

The README says version 3.13; the image is 3.12. It documents RABBITMQ_AMQP_PORT and RABBITMQ_MGMT_PORT with fixed defaults; the compose files use QUEUE_PORT and QUEUE_MGMT_PORT, empty by default, so docker assigns the port. Its hoarder example is invented, it places the credentials in the module .env when they are in the root .env, and it tells readers to edit QUEUE_URL in every service when that value is derived once. It also lists consumers, which a provider doc must not do.

**Evidence.**

base.yml: `rabbitmq:3.12-management-alpine`. compose.yml: `"${QUEUE_PORT:-}:5672"`. The RABBITMQ_* variables exist only in the test harness (shared/utils/src/testing/docker/rabbitmq.yml, plus the pipe and router .env.testing files).

**Fix.**

Rewrite the README on the service's own terms:
- RabbitMQ 3.12 with management.
- base.yml is a definition the packs extend under another name and hostname. compose.yml is a standalone `rabbitmq` instance.
- Credentials are QUEUE_USER and QUEUE_PASS (default guest/guest).
- Host ports are QUEUE_PORT (AMQP 5672) and QUEUE_MGMT_PORT (15672). Empty means docker assigns one; `docker compose port` shows which.
- Configuration is rabbitmq.conf and advanced.config.
- Keep the security warning, and say QUEUE_URL is derived in the root .env.
Drop 'Services Using RabbitMQ' and the hoarder example. The pack hostnames belong in modules/infra/README.md.

**Tests to add.**

`grep -n RABBITMQ_ services/rabbitmq/README.md` should return nothing.

**Verifier notes.**

Confirmed at medium. The verifier removed the consumer list, per the provider rule.

## DPLT-15: ROADMAP is a plan outside docs/planning/, repeats other docs, and misuses 'market' and 'origin'

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/ROADMAP.md:1-8`, `docs/ROADMAP.md:12-16`, `docs/ROADMAP.md:29`, `docs/ROADMAP.md:42-63`, `docs/ROADMAP.md:76`, `docs/ROADMAP.md:82`, `docs/ROADMAP.md:98`, `docs/ROADMAP.md:123`, `docs/ROADMAP.md:133`, `docs/ROADMAP.md:178-200`, `docs/VOCABULARY.md:18-19`, `docs/DATA_PIPELINE.md:116-137`, `README.md:6-8`

**Problem.**

CLAUDE.md puts plans in docs/planning/, and ROADMAP.md is entirely a plan. Line 29 defines a market as 'a venue and an instrument', which contradicts VOCABULARY.md (the shape of a contract) and canonical.ts MARKETS. 'Origin' is used for what VOCABULARY calls a source, and the cold tooling already uses `origin` to mean archives or vault. 'The first haul' (12-16) repeats planning/CATALOG.md:50. The cold-storage section (178-200) repeats docs/tooling/COLD*.md.

**Evidence.**

ROADMAP.md:3 'Where the project is going, and in what order'. services/prospector/src/canonical.ts:30 `MARKETS = ['spot','perp','future','option','tradfi']`. docs/tooling/COLD-AUDIT.md:12 uses `[origin]` for archives or vault.

**Fix.**

1. Line 29 and Part 3: 'instrument at a venue' instead of 'market'. The heading becomes 'Categorise the instruments'.
2. Replace 'origin(s)' with 'source(s)' at 76, 82, 98, 123, 133, 195 and 198-200, and in DATA_PIPELINE.md.
3. Delete 12-16 and keep the item in planning/CATALOG.md#hauler.
4. Cut 184-200 to the principle (raw and vault are both backed up, and appending is required), with a pointer to docs/tooling/COLD.md.
5. git mv to docs/planning/ROADMAP.md, fix its relative links and every inbound link (`grep -rn ROADMAP docs README.md`), and add a README row. README currently has no row to update.
6. Keep the simulator-versus-replay explanation (42-63) only here, and reduce DATA_PIPELINE's and README's replay text to one sentence plus a pointer.

**Tests to add.**

Run a link check over docs/ and README.md after the move. Grep the roadmap for 'origin' and for 'market is'.

**Verifier notes.**

Confirmed at low. Do this together with DPLT-04, DPLT-17 and DPLT-21, which edit the same file.

## DPLT-16: VOCABULARY.md does not define 'origin', has an ambiguous 'vault', and leaves out widely used terms

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/VOCABULARY.md:10-12`, `docs/VOCABULARY.md:93-95`, `dev/tooling/src/tools/cold/types.ts:11`, `dev/tooling/src/tools/cold/config.ts:131-141`, `services/vault/package.json:4`

**Problem.**

'Origin' means a source in ROADMAP and DATA_PIPELINE, and archives-or-vault in the cold tooling, and it is undefined. 'Vault' collides with services/vault. Series, seed, tip, floor, era, ledger, canonical key and backfill are used across docs/ with no definition.

**Evidence.**

types.ts:11 `type Origin = 'archives' | 'vault'`. config.ts 'The vault is not a source'. Usage counts across docs/: series in 20 files, floor in 10, backfill in 9, era in 7, ledger in 6, seed and tip in 5 each.

**Fix.**

- Add 'Origin (cold storage): which tree a stored file belongs to, the archives or the vault. Not a source.'
- Add under Vault: 'Not the vault service (services/vault), a separate HTTP store of CSV dumps.'
- Add one-line definitions, with no behaviour, for Series, Canonical key, Seed, Tip, Floor, Era, Ledger and Backfill, taking each meaning from the term's home doc. Skip any term that is local to one service doc.
- The source wording in ROADMAP and DATA_PIPELINE is handled by DPLT-15.

**Tests to add.**

Each new entry should be a definition only, with no service or tool named except to disambiguate.

**Verifier notes.**

Confirmed, lowered to low. Renaming the code type is optional (DPLT-25).

## DPLT-17: ROADMAP has broken links and cites BUGS entries that no longer exist

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/ROADMAP.md:34`, `docs/ROADMAP.md:168`, `docs/ROADMAP.md:214-216`, `docs/ROADMAP.md:235`, `docs/ROADMAP.md:237-241`, `docs/ROADMAP.md:270-272`

**Problem.**

planning/SCOPING.md does not exist. The CATALOG anchor at 235 is missing. The BUGS.md citations at 215-216 and 272 point at entries that are not there. The ../../tradebot-sim links point outside the repository.

**Evidence.**

The links.py output lists MISSING planning/SCOPING.md, BADANCHOR at 235 and MISSING ../../tradebot-sim. BUGS.md has only two entries.

**Fix.**

- Delete the 'survey is decided by its worst partition' paragraph (237-241), unless the owner wants SCOPING.md written.
- 235 and 270-272 go with DPLT-04.
- Drop the BUGS clause at 214-216.
- Replace the tradebot-sim links with plain text: 'the tradebot-sim repository (separate; entry point docs/ai/README.md)'.

**Tests to add.**

Rerun the link checker over docs/.

**Verifier notes.**

Confirmed, lowered to low.

**Owner question.**

Is 'a survey is decided by its worst partition' still planned work, so that planning/SCOPING.md should be written? And is the okx day-major grouping problem real, so that it should get a BUGS entry?

## DPLT-18: The first BUGS.md entry is about a legacy tool and a facts store that no longer exist

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/planning/BUGS.md:12-32`, `services/prospector/src/config.ts:10-11`, `modules/collect/archives/compose.yml:26-28`, `modules/infra/README.md:62`

**Problem.**

The entry describes the `N mo` cell of legacy/audit.ts, which is not built and not running, and its 'How to check' uses @shared/facts/vault.sqlite, which is gone. Archivist and facts-database comments linger in code and in the infra README.

**Evidence.**

legacy/README.md: 'reads a per-file record and a facts store that no longer exist'. `grep -rn shared/facts` finds only BUGS.md:28.

**Fix.**

- Delete BUGS.md lines 12-32, through the '---' separator.
- Drop the archivist and facts sentence from services/prospector/src/config.ts:10-11.
- Delete the commented archivist include and its comment in modules/collect/archives/compose.yml:27-28.
- Remove modules/infra/README.md:62's module list (covered by DPLT-08).

**Tests to add.**

`grep -rn 'archivist\|facts store\|facts database' --exclude-dir=node_modules --exclude-dir=.deprecated --exclude-dir=dist .` should return only legacy/ and the line in planning/COLD.md that describes the store as gone.

**Verifier notes.**

Confirmed, lowered to low. The verifier added modules/infra/README.md:62.

## DPLT-19: BITGET.md says era-1 and era-2 copies are identical, which an open BUGS entry contradicts

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/venues/BITGET.md:203-213`, `docs/planning/BUGS.md:34-110`, `services/prospector/src/database/migrations/seeds/bitget/series.csv:5143`

**Problem.**

BITGET.md:211-212 says 'Where both are served the content is the same'. The open BUGS entry records era-1 kline keys that return 22-byte empty archives where the era-2 key has the full day. The entry also mixes counts taken at different times.

**Evidence.**

The seed's last change was 88df6e4 on 2026-09-18, before the observation. series.csv:5143 still maps ZKUSDT to ZKSYNCUSDT. The verifiers could not re-run the curl checks (no venue network access).

**Fix.**

- In BITGET.md after line 212, add a venue-level sentence that names no service, e.g. 'Except that some era-1 kline keys answer a 22-byte empty zip where the era-2 key holds the full day (e.g. perp ADAUSDT 2022-04-03); the only-copy counts above count absent era-1 keys, not empty ones.'
- In BUGS.md, give one count per case (the 2026-10-08 figures: 125 spot klines, 157 spot quotes), drop the parenthetical earlier counts, and keep both curl checks.

**Tests to add.**

Re-run the BUGS entry's curl checks from a host with network access before editing BITGET.md.

**Verifier notes.**

Confirmed at low. The reviewer's confidence was medium, because the 22-byte fact rests on the entry's own record.

## DPLT-20: docs/bitmex mixes a dataset reference with working logs that cite missing tools

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/bitmex/README.md:16-24`, `docs/bitmex/README.md:42-48`, `docs/bitmex/DEDUP_COMPARISON.md:13-14`, `docs/bitmex/DEDUP_COMPARISON.md:144`, `docs/bitmex/DEDUP_COMPARISON.md:289-291`, `docs/bitmex/DEDUP_COMPARISON.md:343-347`, `docs/bitmex/dedup_validation_2026.md:27`, `README.md:57-61`, `README.md:96-98`

**Problem.**

DEDUP_COMPARISON.md and dedup_validation_2026.md are session logs. They have unfinished '?' rows and plans, and they cite scripts/sanitize-instrument.mjs, Journalist, `data rebucket` and the memory key `project_timestamp_bucketing`, none of which exist. The source suffixes antel and mtav are never named. README.md:59-61 forbids venue docs outside docs/venues/ yet lists docs/bitmex.

**Evidence.**

There is no scripts/ directory. dev/tooling/.deprecated/data/docs holds DEDUP, PREPARE, RECOVER, RESORT, STATUS and SYNC (no rebucket). docs/bitmex/README.md names the vault service, SCRIBE and TARDY, so it is a dataset doc, not a venue doc.

**Fix.**

- Keep docs/bitmex/ where it is. Do not move it under docs/venues/; it names services, which the venue rule forbids.
- Carve it out in README.md:59-61 ('docs/bitmex/ describes a dataset this repo collected, not the venue').
- In docs/bitmex/README.md, name the source suffixes (.s3, .local, .antel, .mtav, .tardis, .prepared, .mongo), one line each.
- Move the two log files next to DATA-DEDUP.md in dev/tooling/.deprecated/data/docs/, or replace them with a short summary in 'What was done to it': ghost-subscription days 04-08, 04-19, 04-20 and 05-14; about 1.6% of about 1.06B messages removed; orderBookL2 at T0; instrument at T500 except 04-19.
- If the files are kept, remove the dead references and the plan sentences.
- Update the README links at 96-98.

**Tests to add.**

Run a link check. Grep docs/bitmex for 'Journalist', 'rebucket', 'sanitize-instrument' and 'project_timestamp_bucketing'.

**Verifier notes.**

CONFLICT RESOLVED. The reviewer proposed moving the folder to docs/venues/BITMEX.md. The verifier showed that this would break the venue rule, and the consolidator agrees: docs/bitmex names repo services. Its antel/mtav claim is softened because the README covers collector suffixes generically.

## DPLT-21: mental-model.html (bot design) sits in live planning, unlinked

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `docs/planning/mental-model.html:1-1291`, `docs/planning/archived/PLAN.md:18`, `docs/ROADMAP.md:285-289`

**Problem.**

A 1,291-line HTML design of the bot layer (Signal, Executor, lazy computation over amq.rabbitmq.event.exchange) sits in live planning/. Nothing links to it, it is the only non-Markdown doc, and its subject is already archived. archived/PLAN.md:18 links EXECUTOR.md, which does not exist. ROADMAP's 'Dormant' wording suggests the work will resume.

**Evidence.**

`grep mental-model` finds no reference to it outside .git/index. links.py reports MISSING EXECUTOR.md.

**Fix.**

- git mv docs/planning/mental-model.html into docs/planning/archived/, or delete it, since git keeps it. Optionally keep a few lines on the actor split and the lazy computation in archived/BOT.md.
- Drop the dead EXECUTOR.md link in archived/PLAN.md:18.
- Reword ROADMAP.md:287-289 to 'The bot app (signal, strategy, execution) is out of scope until replay exists; no current plan.'

**Tests to add.**

`ls docs/planning` should show Markdown files only. Rerun the link check.

**Verifier notes.**

Confirmed, lowered to low. Deleting archived/ is deferred (DPLT-24).

## DPLT-22: services/redis/README.md has wrong commands, defaults and hostname

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:** `services/redis/README.md:7-10`, `services/redis/README.md:38`, `services/redis/README.md:60`, `services/redis/README.md:68`, `services/redis/README.md:74`

**Problem.**

The README says to build the image, but the compose file uses redis:7-alpine and has nothing to build. It gives CACHE_PORT a default of 6379; empty means docker assigns a port. `tb up infra` is not a module. The connection-string section uses host `redis`, while CACHE_URL uses `cache`. No live service uses Redis.

**Evidence.**

services/redis/docker/compose.yml: `image: redis:7-alpine`, `"${CACHE_PORT:-}:6379"`. dx/utils/discovery.js registers only directories that contain a compose.yml, and modules/infra has none. services/stocker/src/service.ts:6 sets `redis: false`.

**Fix.**

Cut the README to the service on its own terms:
- Redis 7 alpine with AOF.
- The password comes from CACHE_PASS; empty leaves auth off.
- Port 6379 is published on CACHE_PORT; empty means docker assigns one.
- Data lives in the `redis-data` volume.
- The service name and hostname in compose.yml are `redis`.
Delete the build block, the `tb up infra` example and the connection section. Do not name packs or consumers; that belongs in modules/infra/README.md.

**Tests to add.**

`grep -n 'tb up infra\|docker build' services/redis/README.md` should return nothing.

**Verifier notes.**

Confirmed at low. The verifier removed the reviewer's consumer mentions, per the provider rule.

## DPLT-23: Infra packs: local's queue is commented out, the cache hostname differs between packs, and no current module uses either

- **Severity:** medium
- **Category:** config
- **Decision:** DEFER
- **Locations:** `modules/infra/local/compose.yml:16-25`, `modules/infra/market/compose.yml`, `services/redis/docker/compose.yml`, `.env.example:35`, `.env.example:44-47`

**Problem.**

The local pack has no `queue`, although QUEUE_URL points at host `queue`. The market pack's redis has no `cache` hostname, so the root CACHE_URL (`@cache:6379`) does not resolve there. Only the parked hoarder, router and pipe would use the broker, and no service config reads CACHE_URL.

**Evidence.**

See DPLT-08 and DPLT-22. The F7 verifier noted that these compose changes are a configuration decision for the owner.

**Fix.**

Once the owner decides: either uncomment `queue` in local and add `hostname: cache` (or a network alias) to the market pack's redis, or remove the queue and cache packs that nothing uses and cut the related .env.example sections and READMEs.

**Tests to add.**

For each pack, `docker compose config` should show hostnames that match QUEUE_URL and CACHE_URL.

**Verifier notes.**

This decision is split out of F7, F9 and F10.

**Owner question.**

Are the queue and cache infra packs still wanted? If so, should local run `queue`, and should the cache be reachable as `cache` in every pack? If not, delete the packs and their docs instead of rewriting them.

## DPLT-24: Delete docs/planning/archived/ (bot plans built on BitMEX and on retired services)

- **Severity:** low
- **Category:** docs
- **Decision:** DEFER
- **Locations:** `docs/planning/archived/README.md:5-11`, `docs/planning/archived/PLAN.md:5`, `docs/planning/archived/PLAN.md:86-91`, `docs/planning/archived/MILESTONES.md:17`, `shared/types/src/bitmex.ts`

**Problem.**

The archived plans assume our own ws and rest services on BitMEX testnet, modules/bot/testnet/, and shared/types that hold only bitmex.ts. archived/README.md keeps them on purpose, 'because a plan records why'.

**Evidence.**

See DPLT-21. Per the F18 verifier, deleting them reverses a stated policy.

**Fix.**

If the owner agrees, `git rm -r docs/planning/archived/` and drop the ROADMAP pointer. Removing shared/types/src/bitmex.ts belongs to another unit; check its importers first.

**Tests to add.**

Rerun the link check afterwards.

**Verifier notes.**

The reviewer suggested deletion; the verifier deferred it to the owner.

**Owner question.**

Should docs/planning/archived/ (PLAN, BOT, MILESTONES) be deleted, given that git history keeps it, or kept under its 'records why' policy?

## DPLT-25: The vault service is deployed by no module and collides with 'the vault' (Parquet)

- **Severity:** low
- **Category:** docs
- **Decision:** DEFER
- **Locations:** `services/vault/package.json:4`, `.env.example:27-30`, `docs/services/VAULT.md`, `docs/VOCABULARY.md:93-95`, `dev/tooling/src/tools/cold/types.ts:11`

**Problem.**

services/vault (an HTTP CSV store) is written only by deprecated services, yet the root .env.example configures it, and its name collides with the Parquet vault. The cold tooling's `Origin` type clashes with the 'source' meaning of origin.

**Evidence.**

See DPLT-03, DPLT-09 and DPLT-16.

**Fix.**

Once the owner decides: retire services/vault (moving it to .deprecated and removing the VAULT_* variables), or rename it. Optionally rename the cold `Origin` type to `Tree`.

**Tests to add.**

`grep -rn VAULT_URL` should match only the deprecated services.

**Verifier notes.**

This is the owner's call, raised by the F10 and F14 verifiers.

**Owner question.**

Retire or rename services/vault? And should the cold tooling's `Origin` type be renamed (e.g. to `Tree`), or 'origin' simply defined in VOCABULARY?

## DPLT-26: The Python Dockerfiles are unused

- **Severity:** low
- **Category:** config
- **Decision:** DEFER
- **Locations:** `docker/dev.python.Dockerfile`, `docker/prod.python.Dockerfile`, `docker/python/entrypoint.sh`

**Problem.**

No service or module references the Python images, but they exist and need documenting, or removing.

**Evidence.**

Per the F6 verifier, no compose file selects *.python.Dockerfile.

**Fix.**

Delete them if they are not planned, or mention them in one line in docker/README.md (DPLT-07 does the latter by default).

**Tests to add.**

`grep -rn python.Dockerfile` across the compose files.

**Verifier notes.**

Raised by the F6 verifier.

**Owner question.**

Keep the Python Dockerfiles (planned use) or delete them?

## Deferred: decisions needed

- **DPLT-23** (Infra packs: local's queue is commented out, the cache hostname differs between packs, and no current module uses either): Are the queue and cache infra packs still wanted? If so, should local run `queue`, and should the cache be reachable as `cache` in every pack? If not, delete the packs and their docs instead of rewriting them.
- **DPLT-24** (Delete docs/planning/archived/ (bot plans built on BitMEX and on retired services)): Should docs/planning/archived/ (PLAN, BOT, MILESTONES) be deleted, given that git history keeps it, or kept under its 'records why' policy?
- **DPLT-25** (The vault service is deployed by no module and collides with 'the vault' (Parquet)): Retire or rename services/vault? And should the cold tooling's `Origin` type be renamed (e.g. to `Tree`), or 'origin' simply defined in VOCABULARY?
- **DPLT-26** (The Python Dockerfiles are unused): Keep the Python Dockerfiles (planned use) or delete them?

Owner questions attached to IMPLEMENT items:

- **DPLT-04**: Is a floor audit of the seeded venues (okx, bitget) against the catalog still wanted? If not, delete the section outright.
- **DPLT-06**: Has a first real end-to-end `cold push` (or vault run) happened since 2026-10-07? If so, cut that item too.
- **DPLT-17**: Is 'a survey is decided by its worst partition' still planned work, so that planning/SCOPING.md should be written? And is the okx day-major grouping problem real, so that it should get a BUGS entry?

## Rejected

None. All 21 findings were confirmed, and the verifiers adjusted some of them:
- DPLT-20: the reviewer wanted to move docs/bitmex into docs/venues/. That was rejected in favour of keeping it as a dataset doc.
- DPLT-09: the reviewer's DATA_DIR failure scenario was corrected.
- DPLT-14 and DPLT-22: the consumer listings were removed from the provider docs.
- DPLT-06: the line numbers were corrected.
