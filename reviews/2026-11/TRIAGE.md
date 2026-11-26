# Triage of the 69 deferred items (2026-11-25)

Owner answers that drive it:
1. **BitMEX path: retire it all.** services/vault, shared/types and the stub UI's BitMEX/digger code go. BitMEX data on disk stays.
2. **Access: only the owner's machine.** No app-level auth; loopback ports; dev-only /live mount; drop unused infra packs.
3. **Delivery: best effort, but robust.** Fix the issues; no data thrown away on transient faults; no submodule changes.
4. **Data: do not touch.** Anything that would change what is catalogued, archived or stocked is DOCUMENTED as a known issue
   in docs/planning/BUGS.md with evidence, not fixed.

## A. Retire the BitMEX path (implement)
VLT-19, VLT-20, VLT-29, VLT-30, DCOL-17, DPLT-25 — services/vault moves to services/.deprecated/vault (its docs with it, per the
repo's retired-service convention); compose/module references removed.
SHR-07, SHR-08 — shared/types deleted; BitMEX table/CSV code in shared/utils removed where it has no remaining consumer.
SUI-11, SUI-23, SUI-24, SUI-25 — stub UI: BitMEX/testnet/digger sources, DiggerClient, ReplayClock and fabricated mock figures removed;
the widgets stay with an explicit "no data source" state. (SUI-23 frame batching skipped: no source.)

## B. Local-only deployment (implement)
CUI-21 — no auth (loopback only). SUI-26 — stub UI port on loopback.
INF-20, PRW-30, CAT-26, CUI-23, HOA-25 — the read-write /live repo mount moves to a dev-only compose override.
INF-21 — slim prod image (pnpm deploy). INF-31 — memory limits with env-overridable defaults. INF-28 — remove nx + Nx Cloud
boilerplate. DPLT-26 — delete unused Python Dockerfiles. DPLT-23 — drop or fix the queue/cache infra packs (keep only what a module uses).
INF-19 — RabbitMQ upgrade to a supported 4.x/3.13 series (nothing runs yet, so no data to migrate). INF-32 — already done.
INF-29 — one env parser and one retry helper in shared/utils, used by services and dev/tooling.

## C. Messaging, best effort but robust (implement)
RTP-15 — while paused for backpressure the router cancels its consumer, so messages wait in RabbitMQ instead of unacked in memory.
RTP-16 — failed messages retried with back-off; after N attempts dead-lettered (declared DLX/queue), never retried forever.
RTP-23 — graceful shutdown: cancel consumers, drain in-flight handlers, close the publisher (router owns its lifecycles).
HOA-17 — hoarder declares a capped durable queue (drop-head overflow), so a consumer restart does not lose frames.
HOA-24 — envelope carries a per-socket connection id; `scale:` replicas removed (they duplicated every stream).
HOA-26 — unused unsubscribeFrame removed.
RTP-03 — DOCUMENTED: a publish fault after ack loses that message (at-most-once on faults); confirms need packages/rabbitmq.

## D. Decided defaults (implement; none changes stored data)
PRW-28 — cap Retry-After at the pace ceiling and latch the pace above it; stop signal through the waits.
PRW-29 — listing requests follow redirects only to https on the same host; per-format body ceiling; log refused redirects.
STK-29 — graceful drain on SIGTERM: finish the current placement (timeout), then close DuckDB; compose stop_grace_period.
CAT-10 — cap failed+mismatched keys per report; reconcile a create whose response was lost with a follow-up GET.
CAT-27, INF-30 — prospector owns the catalog.db schema; shared/lenses and catalog tests import it (test-only).
CAT-28 — warn once per directory per process. CUI-25 — PROSPECTOR_API configurable for host dev runs.
HAU-16 — back off re-fetching a persistently mismatched file (after 3 walks, then every 10th). TCL-15 — pulled archives stay on disk
until the operator evicts them explicitly ('pulled' marker). TOT-21 — escape untrusted text written to the terminal.
DCOL-26 — router/pipe/hoarder are README-only (ROUTER.md folds into the router README).
DXC-32 — shared-package docs live beside the code (shared/lenses/README.md); docs/modules keeps only modules.

## E. Fresh-start refactors (implement; pure moves, no behaviour change)
PRC-26 — split prospector catalog/queries.ts by subject, one per-database state object.
STK-30 — split stocker build.ts, extract the duplicated helpers. CUI-24 — split Lenses.tsx / Surveys.tsx, export and test their logic.

## F. Docs restructure (implement)
DPR2-13 — split PROSPECTOR.md (overview + series model + transport). DXC-17, DVEN-18 — per-venue REST facts live in the venue docs;
docs/REST.md becomes the cross-venue comparison only; planning/REST.md keeps only the plan. DVEN-29 — one section template for the
venue docs. DTL-20 — cold docs per tree. DCAT-23 — planning/CATALOG.md renamed/split by service; the ROADMAP "data we do not want"
paragraph stays (whether it is solved is a data question). DPLT-24 — delete docs/planning/archived (git keeps it).

## G. Documented as known issues, not changed (owner reviews) — docs/planning/BUGS.md
STK-04 withdrawn files on disk; STK-15 no tie-breaker within a timestamp; Gate futures_usdt/trades/202107 (1,468 spot-shaped files,
85 excluded); PRC-04 excluded/refused files withdrawn as if the venue withdrew them; PRC-25 one URL shape may publish two variants;
STK-28 side revisions ignore the neighbour era's series version; RTP-03 at-most-once on publish faults.

## H. Skipped (not worth it now)
PRC-23 (keep indexes), PRC-24, STK-27, CAT-09 (perf, unmeasured); CUI-22 (single operator); HAU-14 (resume large downloads);
HAU-21 (restart picks up venues).
