# Tradebot full review — index

Review of the whole monorepo (code + docs), 2026-11-24. Each unit was reviewed by independent deep reviewers, every finding was
checked by a skeptical verifier (high/critical by two), then consolidated. Decisions: **IMPLEMENT** (safe, bounded — will be done),
**DEFER** (needs an owner decision — see OWNER-QUESTIONS.md), **SKIP**. Per-unit reports: `<unit>.md` (human) and `<unit>.json` (machine).

Submodules (packages/*, dx) and `.deprecated/` were out of scope.

## Status

- Units reviewed: 23 of 23
- Surviving items: 604 (critical 7, high 52, medium 278, low 267)
- Decisions: IMPLEMENT 534, DEFER 69, SKIP 1

| Kind | Unit | Crit | High | Med | Low | Implement | Defer | Rejected |
|---|---|---|---|---|---|---|---|---|
| Code | [prospector-catalog](units/prospector-catalog.md) | 0 | 1 | 11 | 14 | 21 | 5 | 4 |
| Code | [prospector-walk](units/prospector-walk.md) | 0 | 4 | 14 | 12 | 27 | 3 | 8 |
| Code | [stocker](units/stocker.md) | 0 | 4 | 11 | 16 | 24 | 6 | 10 |
| Code | [catalog](units/catalog.md) | 0 | 1 | 9 | 18 | 23 | 5 | 5 |
| Code | [catalog-ui](units/catalog-ui.md) | 1 | 3 | 8 | 13 | 20 | 5 | 6 |
| Code | [hauler](units/hauler.md) | 0 | 3 | 11 | 10 | 21 | 3 | 3 |
| Code | [hoarder](units/hoarder.md) | 1 | 4 | 12 | 9 | 22 | 4 | 1 |
| Code | [vault](units/vault.md) | 1 | 3 | 16 | 10 | 26 | 4 | 6 |
| Code | [router-pipe](units/router-pipe.md) | 1 | 7 | 8 | 7 | 19 | 4 | 1 |
| Code | [shared](units/shared.md) | 0 | 2 | 8 | 8 | 16 | 2 | 9 |
| Code | [stub-ui](units/stub-ui.md) | 0 | 1 | 10 | 15 | 21 | 5 | 4 |
| Code | [tooling-cold](units/tooling-cold.md) | 1 | 5 | 12 | 11 | 28 | 1 | 2 |
| Code | [tooling-other](units/tooling-other.md) | 1 | 3 | 7 | 10 | 20 | 1 | 4 |
| Code | [infra](units/infra.md) | 1 | 3 | 17 | 11 | 24 | 8 | 9 |
| Docs | [docs-prospector-1](units/docs-prospector-1.md) | 0 | 0 | 17 | 9 | 26 | 0 | 0 |
| Docs | [docs-prospector-2](units/docs-prospector-2.md) | 0 | 2 | 11 | 12 | 24 | 1 | 0 |
| Docs | [docs-stocker](units/docs-stocker.md) | 0 | 0 | 14 | 14 | 28 | 0 | 0 |
| Docs | [docs-catalog](units/docs-catalog.md) | 0 | 1 | 10 | 12 | 22 | 1 | 6 |
| Docs | [docs-collect](units/docs-collect.md) | 0 | 2 | 15 | 9 | 24 | 2 | 4 |
| Docs | [docs-venues](units/docs-venues.md) | 0 | 0 | 18 | 11 | 27 | 2 | 0 |
| Docs | [docs-platform](units/docs-platform.md) | 0 | 2 | 13 | 11 | 22 | 4 | 0 |
| Docs | [docs-tooling](units/docs-tooling.md) | 0 | 1 | 9 | 10 | 19 | 1 | 0 |
| Docs | [docs-consistency](units/docs-consistency.md) | 0 | 0 | 17 | 15 | 30 | 2 | 4 |

## Critical and high items

| Sev | Id | Decision | Title |
|---|---|---|---|
| critical | [CUI-01](units/catalog-ui.md) | IMPLEMENT | Proxy is an open relay: every method and path is forwarded to the catalog and prospector's private API with the token attached |
| critical | [HOA-01](units/hoarder.md) | IMPLEMENT | Reconnect resubscribes only the first Kraken channel; the other Kraken streams stop silently after every reconnect |
| critical | [INF-01](units/infra.md) | IMPLEMENT | Prod Node image CMD runs dist/index.js, but every service compiles to dist/src/index.js, so every prod container crash-loops |
| critical | [RTP-01](units/router-pipe.md) | IMPLEMENT | Destination `queue@exchange` is bound with its own queue name as the routing key; republished messages are unroutable and dropped, and the source is still acked |
| critical | [TCL-01](units/tooling-cold.md) | IMPLEMENT | A partition that changes while its tar is packed or queued is written down as stored at the new version, though the tar holds the old bytes |
| critical | [TOT-01](units/tooling-other.md) | IMPLEMENT | `tools rabbit <queue>` permanently consumes (deletes) the messages it 'fetches' |
| critical | [VLT-01](units/vault.md) | IMPLEMENT | Graceful shutdown loses acknowledged rows: only writers with leftover buffered lines are drained, seals in flight are not awaited, and the drain runs concurrently with server close |
| high | [CAT-01](units/catalog.md) | IMPLEMENT | Contents through a lens with a hole list and date series whose files all sit in the hole |
| high | [CUI-02](units/catalog-ui.md) | IMPLEMENT | Cross-site simple POSTs become authenticated JSON writes (CSRF): any page an operator visits can start or pause every survey |
| high | [CUI-03](units/catalog-ui.md) | IMPLEMENT | Default prod image cannot start: prod.node.Dockerfile runs dist/index.js, but every service builds to dist/src/index.js |
| high | [CUI-21](units/catalog-ui.md) | DEFER | catalog-ui port published on all interfaces with no auth of its own |
| high | [DCAT-01](units/docs-catalog.md) | IMPLEMENT | Docs say the catalog writes the lens table and prospector never reads it; prospector is the only writer |
| high | [DCOL-01](units/docs-collect.md) | IMPLEMENT | Hoarder publishes re-serialised JSON, but its docs (and its design) promise a byte-faithful relay |
| high | [DCOL-02](units/docs-collect.md) | IMPLEMENT | ROUTER.md examples that put a queue on an explicit exchange deliver nothing to that queue |
| high | [DPLT-01](units/docs-platform.md) | IMPLEMENT | Prod Node Dockerfile starts dist/index.js, but every service builds to dist/src/index.js |
| high | [DPLT-02](units/docs-platform.md) | IMPLEMENT | Every .env.example puts comments after empty values, and docker compose reads the comment text as the value |
| high | [DPR2-01](units/docs-prospector-2.md) | IMPLEMENT | Reconciliation ("What a completed update pass is worth") describes the wrong algorithm and contradicts the doc's other description |
| high | [DPR2-02](units/docs-prospector-2.md) | IMPLEMENT | The preamble and "series life" sections describe a removed model (probing for ends, an `end` bound, constructed-key venues only, runs inside getContext) |
| high | [DTL-01](units/docs-tooling.md) | IMPLEMENT | Rabbit README says the command fetches recent messages; it actually removes the oldest ones from the queue |
| high | [HAU-01](units/hauler.md) | IMPLEMENT | An exception escaping haul() rejects the walk while its workers and lister keep running; the page is never reported and walks overlap on the same keys |
| high | [HAU-02](units/hauler.md) | IMPLEMENT | A fetch waiting for an out-of-rotation address (or in backoff) holds its global concurrency turn, so one rate-limited venue stalls every venue |
| high | [HAU-03](units/hauler.md) | IMPLEMENT | No fsync of the partial or the directory before the rename and the report, so a power loss can leave a truncated file the catalog records as downloaded forever |
| high | [HOA-02](units/hoarder.md) | IMPLEMENT | The relay is not byte-faithful: every frame is JSON.parse'd and re-serialised before publishing, and the test cannot see it |
| high | [HOA-03](units/hoarder.md) | IMPLEMENT | A failed startup connect, subscribe or ack drops the channel for good: the reconnected socket subscribes nothing and the failure is debug-only |
| high | [HOA-04](units/hoarder.md) | IMPLEMENT | The prod container runs dist/index.js, but every service builds to dist/src/index.js, so the default compose crash-loops |
| high | [HOA-05](units/hoarder.md) | IMPLEMENT | No liveness detection: hung handshakes, half-open and silent sockets go unnoticed while health stays green |
| high | [INF-02](units/infra.md) | IMPLEMENT | Inline comments after empty values in .env.example files become literal values in compose: broken project name, paths, credentials, venue lists, lenses and token |
| high | [INF-03](units/infra.md) | IMPLEMENT | The shared external network name never matches what `tb` creates, and the only workaround (COMPOSE_PROJECT_NAME) merges every module into one compose project |
| high | [INF-04](units/infra.md) | IMPLEMENT | catalog-ui (an unauthenticated proxy that adds CATALOG_TOKEN), the catalog, Redis, RabbitMQ, vault and every :3000 health port are published on all host interfaces |
| high | [PRC-01](units/prospector-catalog.md) | IMPLEMENT | reconcile deletes series that still have file/wip rows: FOREIGN KEY constraint failed wedges the venue's pass |
| high | [PRW-01](units/prospector-walk.md) | IMPLEMENT | A 200 response that is not a listing is read as a complete final page, which closes the partition and withdraws every catalogued file in its range |
| high | [PRW-02](units/prospector-walk.md) | IMPLEMENT | A failed split rejects surveyVenue while its other lanes keep walking, so the retry walks the same partitions twice |
| high | [PRW-03](units/prospector-walk.md) | IMPLEMENT | Any throw outside tend() ends the venue's sync loop silently until the process restarts |
| high | [PRW-04](units/prospector-walk.md) | IMPLEMENT | begin() race: a pause sent during a refresh or forced update is undone, and a duplicate request stays parked, later lifts a pause and resets runs |
| high | [RTP-02](units/router-pipe.md) | IMPLEMENT | The router consumer never recovers from channel or connection loss or a broker cancel, and /health stays 200, so it silently stops routing for good |
| high | [RTP-03](units/router-pipe.md) | DEFER | The source is acked before the broker confirms the republish (no confirm channel, no mandatory flag, publisher never flushed or closed): messages are lost on a broker or connection fault |
| high | [RTP-04](units/router-pipe.md) | IMPLEMENT | Backpressure poller: an unhandled rejection crashes the process, the passive checkQueue 404 kills the consumer channel, and one failed poll while paused wedges the gate forever |
| high | [RTP-05](units/router-pipe.md) | IMPLEMENT | Prefetch is unbounded unless backpressure is enabled; after downtime the whole backlog is pulled into router memory (OOM crash loop) |
| high | [RTP-06](units/router-pipe.md) | IMPLEMENT | Cached Exchange objects go stale after the second publisher recovery (hot nack loop), and bare-queue targets publish on the consumer channel |
| high | [RTP-07](units/router-pipe.md) | IMPLEMENT | Rules sharing a source queue overwrite each other's binding keys, and every destination of the queue receives every message |
| high | [RTP-08](units/router-pipe.md) | IMPLEMENT | Pipe exits with code 0 on fatal errors, so `restart: on-failure` never retries it and the bindings are never declared |
| high | [SHR-01](units/shared.md) | IMPLEMENT | redactUrl/sanitizeUrl log the plaintext AMQP credential URL on parse failure; sanitizeUrl's output is never used to connect |
| high | [SHR-02](units/shared.md) | IMPLEMENT | problemsWith checks almost no structure: stored lenses lose rules silently, mis-match, disagree between evaluators, or throw and stall lens upkeep / partition creation |
| high | [STK-01](units/stocker.md) | IMPLEMENT | A single failure while deciding (corrupt archive, catalog 404/500 for one venue) aborts the whole sweep, on every sweep |
| high | [STK-02](units/stocker.md) | IMPLEMENT | Prod Docker image starts dist/index.js, which the build does not emit; every node service built from it crash-loops |
| high | [STK-03](units/stocker.md) | IMPLEMENT | Completing a split month that is partly moved out of the vault skips the moved-out instruments' sides and records the month complete |
| high | [STK-04](units/stocker.md) | DEFER | Withdrawn files stay on disk under canonical names, so a partition holding one never matches the catalog again |
| high | [SUI-01](units/stub-ui.md) | IMPLEMENT | Browsing history: each new live tradeBin insert is treated as a gap and wipes the whole candle buffer |
| high | [TCL-02](units/tooling-cold.md) | IMPLEMENT | When Mega fails fast, megaCmd waits on an unref'd timer and the process exits with code 0 mid-operation, ending --watch runs |
| high | [TCL-03](units/tooling-cold.md) | IMPLEMENT | Once-stored tars moved back to 'planned' are deleted with their partition map by the next plan(); audit applies this unasked, even on an empty listing |
| high | [TCL-04](units/tooling-cold.md) | IMPLEMENT | The audit's staging check flags every corrected tar as wrong, and its default fix erases that tar's record |
| high | [TCL-05](units/tooling-cold.md) | IMPLEMENT | The audit's 'remove their files again' permanently deletes archive files cold storage may not hold, while docs call it safe |
| high | [TCL-06](units/tooling-cold.md) | IMPLEMENT | The Archives instrument list is cached for the life of the process: watching pushes never pack tars of new instruments, evict leaves their files |
| high | [TOT-02](units/tooling-other.md) | IMPLEMENT | `rabbit --watch` competes with real consumers and requeue-loops the head message instead of tapping the queue |
| high | [TOT-03](units/tooling-other.md) | IMPLEMENT | RabbitMQ discovery picks an arbitrary port and guesses the management port; QUEUE_USER/PASS ignored in default URL; RABBITMQ_MGMT_URL documented but unread |
| high | [TOT-04](units/tooling-other.md) | IMPLEMENT | Monitor shows unhealthy containers as '✓ healthy' |
| high | [VLT-02](units/vault.md) | IMPLEMENT | Path traversal and no date/suffix validation: :table, :date and ?suffix= build filesystem paths unchecked (create/read *.csv.gz, unlink *.csv.gz.tmp, mkdir, directory probing outside /data/vault) |
| high | [VLT-03](units/vault.md) | IMPLEMENT | A corrupt or non-gzip file in a free-text table crashes the process (unhandled gunzip 'error' event in csvRecords) |
| high | [VLT-04](units/vault.md) | IMPLEMENT | DELETE and PUT-over-open drop the zipper writer without aborting it: queued members resurrect the deleted file without its header, or are spliced into the uploaded file |

## Other files

- `OWNER-QUESTIONS.md` — every decision that needs the owner, grouped by unit.
- `RESUME.md` — workflow run state (internal).
