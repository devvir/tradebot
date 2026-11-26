# Docs consistency review (unit: docs-consistency)

## Overall assessment

The deep service docs (STOCKER, HAULER, CATALOG, COLD-*) mostly match the code. The cross-doc frame around them is in poor shape: the entry docs, the planning layer, cross-references and the vocabulary.

- **Contradictions on basic facts.** Five docs give different answers on who writes the `lens` table. The code is unambiguous: catalog.db is opened read-only and prospector writes all 16 tables. Docs also disagree on how a vault month is laid out on disk, and on whether consumers ask the catalog if a partition is settled.
- **Entry docs disown themselves.** The root README sends readers to DATA_PIPELINE.md, which opens by declaring itself outdated.
- **Planning has drifted furthest.** ROADMAP.md sits outside docs/planning and lists landed work as open: scoping, seed rebuilds, book series. It cites code and files that no longer exist. planning/COLD.md, CATALOG.md and BUGS.md hold landed or unverifiable entries.
- **The dependency-direction rule is broken widely.** Venue docs explain prospector adapters, seeds and catalog refusals; BITGET-SEED.md is entirely a prospector artefact. CATALOG-LENSES.md explains lenses by their consumers.
- **Terminology drift.** "origin", "bucket", "slice", "vault" and "shape" each carry two to four meanings. VOCABULARY.md defines none of the overlaps.
- **REST facts have three deep homes.** They are written in depth in docs/REST.md, planning/REST.md and the venue docs.
- **Several READMEs describe a repository that no longer exists:** infra, redis, rabbitmq, docker, dev/tooling and the UI stub.

All 32 findings came from one reviewer lens (docs-consistency:docs) with one verifier. The verifier confirmed 31 and was uncertain on one (F29, mental-model.html), which does not survive. It also refuted one sub-claim (VAULT.md's BitMEX framing is accurate) and narrowed several fixes; those refinements are used below. No second verifier ran, because the verifier lowered every high finding to medium. 30 items are for implementation now and 2 are deferred: REST consolidation, and moving CATALOG-API/CATALOG-LENSES.

**Recommended restructuring (fresh start, one home per subject, providers before consumers):**
- **docs/ARCHITECTURE.md** (one page, current state only) replaces DATA_PIPELINE.md.
- **docs/planning/ROADMAP.md**, moved and pruned. Every plan goes under docs/planning/.
- **docs/VOCABULARY.md** stays definitions-only and gains Shape, Table, the `@` market-bundle spelling, and possibly Series, Pattern and Ledger.
- **docs/venues/** holds venue facts only, with KUCOIN.md as the template. Adapter, seed and catalog material moves to PROSPECTOR.md#venues and to the seeds README. A cross-venue docs/venues/REST.md replaces docs/REST.md and planning/REST.md (deferred).
- **docs/services/** has one deep doc per running service. Service READMEs hold env vars and commands only, and each gets a "Deployed by" line. UI.md becomes docs/planning/UI.md.
- **CATALOG-API.md and CATALOG-LENSES.md** move out of docs/modules (deferred until a home for shared-package docs is chosen).
- **Infra, docker, redis, rabbitmq and tooling READMEs** are rewritten from the compose and Dockerfiles.

**Longer-term recommendations:**
- Split PROSPECTOR.md (3,018 lines) into model/API, survey and storage docs.
- Ban code-line links in docs.
- Run a link and anchor checker in CI.
- Accept dated measurements as evidence, never dated status.

**Order of work matters:**
1. DXC-03 (move ROADMAP into planning) before DXC-02 (move DATA_PIPELINE's plans out).
2. DXC-02 makes the DATA_PIPELINE edits in DXC-04, DXC-10 and DXC-29 moot. Apply those to ARCHITECTURE.md instead, or skip them if the text is gone.
3. DXC-01, DXC-05 and DXC-22 all edit CATALOG-LENSES.md. Do them together.
4. DXC-08, DXC-09, DXC-18 and DXC-20 all touch the venue docs. Do DXC-09 and DXC-18 inside the DXC-08 pass.
5. DXC-20's ROADMAP links depend on DXC-03.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| DXC-01 | medium | docs-contradiction | IMPLEMENT | Who writes the `lens` table is stated five contradictory ways (and the table count is wrong) |
| DXC-02 | medium | docs-structure | IMPLEMENT | Root README's main entry doc (DATA_PIPELINE.md) is self-declared outdated and full of history and plans |
| DXC-03 | medium | docs-staleness | IMPLEMENT | ROADMAP.md is a plan outside docs/planning, full of landed, obsolete or contradicted items |
| DXC-04 | medium | docs-contradiction | IMPLEMENT | How a vault month is laid out on disk contradicts itself across docs |
| DXC-05 | medium | docs-contradiction | IMPLEMENT | CATALOG-LENSES says consumers never ask the catalog whether a month is settled; they do |
| DXC-06 | medium | docs-staleness | IMPLEMENT | planning/COLD.md lists landed work as not built, with a broken reference |
| DXC-07 | medium | docs-staleness | IMPLEMENT | planning/CATALOG.md and planning/BUGS.md hold landed or unverifiable entries |
| DXC-08 | medium | docs-dependency-direction | IMPLEMENT | Venue docs explain this repo's services, which breaks the venues-are-providers rule |
| DXC-09 | medium | docs-staleness | IMPLEMENT | Prospector seeds README is outdated, and the bitget seed's doc lives in docs/venues |
| DXC-10 | medium | docs-terminology | IMPLEMENT | Key terms (origin, bucket, slice, shape, vault, letter folder) carry several meanings; VOCABULARY.md defines none of the overlaps |
| DXC-11 | medium | docs-accuracy | IMPLEMENT | Tooling docs: `cold` missing from the tooling README, env precedence wrong, root README calls the tools `tb` |
| DXC-12 | medium | docs-usability | IMPLEMENT | Docs present an empty CATALOG_PORT as normal, but `tools cold` on the host then waits forever on localhost:9010 |
| DXC-13 | medium | docs-accuracy | IMPLEMENT | Infra pack, redis and rabbitmq READMEs contradict the compose files and each other |
| DXC-14 | medium | docs-accuracy | IMPLEMENT | docker/README.md describes a Dockerfile and build that do not exist |
| DXC-15 | medium | docs-staleness | IMPLEMENT | docs/services/UI.md and the UI stub README describe things that are not there |
| DXC-16 | medium | docs-one-home | IMPLEMENT | CATALOG-UI.md restates lens semantics, with a nonexistent instrument picker and wrong bundle labels |
| DXC-17 | medium | docs-one-home | DEFER | REST knowledge has three deep homes (docs/REST.md, docs/planning/REST.md, each venue doc) |
| DXC-18 | low | docs-contradiction | IMPLEMENT | OKX.md says prospector compares ETags case-sensitively; the code and PROSPECTOR.md say case-blind |
| DXC-19 | low | docs-accuracy | IMPLEMENT | The walk-schedule example (`bitget: 1,10,20`) would stop prospector at startup |
| DXC-20 | low | docs-links | IMPLEMENT | Broken links and anchors across docs |
| DXC-21 | low | docs-tense | IMPLEMENT | History and plans inside current-state docs |
| DXC-22 | low | docs-dependency-direction | IMPLEMENT | Provider docs explain themselves by their consumers (catalog-ui README, infra README, rabbitmq/pipe examples) |
| DXC-23 | low | docs-accuracy | IMPLEMENT | Vault service README misses VAULT_COMPRESSION_LEVEL; no service README says what deploys it |
| DXC-24 | low | docs-accuracy | IMPLEMENT | Hauler README says a refusal pauses the whole venue; only the refusing address is taken out |
| DXC-25 | low | docs-accuracy | IMPLEMENT | Archives .env.example claims a CATALOG_DIR default that does not exist and omits bitget from venues |
| DXC-26 | low | docs-accuracy | IMPLEMENT | CATALOG-API examples contradict its own variant rules |
| DXC-27 | low | docs-contradiction | IMPLEMENT | CATALOG.md says nothing is shared in code with prospector, then names a shared package |
| DXC-28 | low | docs-dependency-direction | IMPLEMENT | Binance's 2025-01 ms→µs timestamp change is documented only in stocker's docs |
| DXC-29 | low | docs-coverage | IMPLEMENT | Kraken has a WS adapter but no venue doc; the WebSocket pointer claims every venue doc has a WS section |
| DXC-30 | low | docs-contradiction | IMPLEMENT | Cold legacy README contradicts COLD-AUDIT.md on what the rebuilt audit checks |
| DXC-31 | low | docs-accuracy | IMPLEMENT | Archives module README points to docs/services for variables that live in service READMEs |
| DXC-32 | low | docs-structure | DEFER | docs/modules/ holds non-module docs (CATALOG-API, CATALOG-LENSES); warehouse module has no doc |

## DXC-01: Who writes the `lens` table is stated five contradictory ways (and the table count is wrong)

- **Severity:** medium
- **Category:** docs-contradiction
- **Decision:** IMPLEMENT
- **Source finding:** F1

**Locations**

- `docs/modules/ARCHIVES.md:33-36`
- `docs/modules/CATALOG-LENSES.md:13-16`
- `docs/modules/CATALOG-LENSES.md:148-149`
- `docs/services/PROSPECTOR.md:2137-2142`
- `docs/services/PROSPECTOR.md:2152-2159`
- `docs/services/CATALOG.md:11-17`
- `services/prospector/README.md:42-44`

**Problem**

The docs give three different answers to who writes the `lens` table:
- ARCHIVES.md says the catalog writes it and nothing else.
- CATALOG-LENSES.md:15 says the catalog writes it ("the one table it writes"), but :148 of the same file says both lens tables are written by prospector.
- PROSPECTOR.md:2137 says prospector writes every row of every table, but :2158 calls lens/lens_member "the two tables the catalog writes".
CATALOG.md and the prospector README say prospector is the only writer. PROSPECTOR.md also says "Seventeen tables"; the schema has 16.

**Evidence**

services/catalog/src/database.ts:26 `new DatabaseSync(path, { readOnly: true })` (re-checked). services/prospector/src/database/schema.ts has 16 CREATE TABLE statements (re-checked). services/prospector/src/api/lenses.ts and src/lenses.ts write lens/lens_member.

**Fix**

Make PROSPECTOR.md#storage (:2134-2159) the one home for who writes what.
- **ARCHIVES.md:33-35:** replace the "Lenses belong to the catalog…" paragraph with one sentence: a lens is a consumer's choice, made and served through the catalog, and is stored by prospector like every other row (see PROSPECTOR.md#storage).
- **CATALOG-LENSES.md:13-16:** drop "So the catalog writes the `lens` table (the one table it writes) and prospector never reads it". Keep "a lens is a consumer's choice of what to read, which collection neither knows nor acts on".
- **CATALOG-LENSES.md:148-149:** reduce to one line pointing to PROSPECTOR.md#storage.
- **PROSPECTOR.md:2152:** "Seventeen tables" becomes "Sixteen tables".
- **PROSPECTOR.md:2158-2159:** "and the two tables the catalog writes" becomes "stored here for the catalog through the private lens API".

**Tests and checks**

`grep -rn "catalog writes" docs services/*/README.md` returns nothing. Count `CREATE TABLE` in schema.ts and confirm it matches the number PROSPECTOR.md states.

**Verifier notes**

Confirmed, with severity lowered from high to medium. Following the wrong version fails loudly, because SQLite refuses writes on the read-only handle, so nothing is corrupted silently. Do this together with DXC-05 and DXC-22, which also edit CATALOG-LENSES.md.

## DXC-02: Root README's main entry doc (DATA_PIPELINE.md) is self-declared outdated and full of history and plans

- **Severity:** medium
- **Category:** docs-structure
- **Decision:** IMPLEMENT
- **Source finding:** F14

**Locations**

- `README.md:25-26`
- `README.md:51`
- `docs/DATA_PIPELINE.md:3-11`
- `docs/DATA_PIPELINE.md:63-65`
- `docs/DATA_PIPELINE.md:82`
- `docs/DATA_PIPELINE.md:100-114`
- `docs/DATA_PIPELINE.md:116-125`
- `docs/DATA_PIPELINE.md:127-142`
- `docs/DATA_PIPELINE.md:144-159`

**Problem**

README.md sends every reader to DATA_PIPELINE.md first. That doc opens with "Outdated — do not use as a reference… not being kept current on purpose". It also breaks several CLAUDE.md rules:
- **History:** the "Retired" section and "both historically called vault".
- **Plans:** the "Origins arrive one at a time" and "Replay… waits on the per-venue APIs" sections, and "WebSocket collection is currently parked".
- **A second home:** :100-114 restates STOCKER.md's schema rules.

**Evidence**

DATA_PIPELINE.md:3-11 (the banner). README.md:25: "→ docs/DATA_PIPELINE.md for how collection and normalisation fit together". README.md is the only file that links DATA_PIPELINE.md (re-checked).

**Fix**

Replace docs/DATA_PIPELINE.md with **docs/ARCHITECTURE.md**: about one page, present tense only.
- One ASCII diagram: prospector → catalog (+ lenses) → hauler → archives → stocker → Parquet vault, with `tools cold` backing up the archives and the vault.
- One paragraph per stage on the boundary it owns, linking to docs/services/<X>.md.
- The modules that deploy them (link docs/modules/ARCHIVES.md and the warehouse module).
- One line on the principle: collection is byte-faithful, and normalisation is a separate pass.
- For source priority, link README.md:12-16, which already holds it. Do not restate it.
- No venue names, no "parked" or "unbuilt" status, and no restatement of STOCKER's schema rules (link to them).

Move or delete the rest:
- **Replay, WS and REST collection status:** to docs/planning/ROADMAP.md (after DXC-03 moves it there) or to a new docs/planning/REPLAY.md.
- **The BitMEX paragraph and the hoarder/vault-service note:** to docs/bitmex/README.md or to those services' docs.
- **"Retired" and the "Where raw lands" history:** delete.

Then point README.md:25-26 and :51 at ARCHITECTURE.md.

**Tests and checks**

`grep -rn DATA_PIPELINE docs services modules README.md` returns nothing. Every relative link in ARCHITECTURE.md resolves. `grep -nE 'used to|historically|parked|not yet|will ' docs/ARCHITECTURE.md` returns nothing.

**Verifier notes**

Confirmed. Two corrections to the reviewer's fix:
- docs/planning/ROADMAP.md did not exist when the review ran; DXC-03 creates it, so do DXC-03 first.
- README.md:12-16 already holds the source-priority principle, so ARCHITECTURE.md should point to it rather than restate it.
The vault-layout fix in DXC-04, the "origin" rename in DXC-10 and the WebSocket pointer in DXC-29 all edit DATA_PIPELINE.md. Fold them into ARCHITECTURE.md where the text survives.

## DXC-03: ROADMAP.md is a plan outside docs/planning, full of landed, obsolete or contradicted items

- **Severity:** medium
- **Category:** docs-staleness
- **Decision:** IMPLEMENT
- **Source finding:** F2

**Locations**

- `docs/ROADMAP.md:12-16`
- `docs/ROADMAP.md:90-92`
- `docs/ROADMAP.md:135-136`
- `docs/ROADMAP.md:185`
- `docs/ROADMAP.md:210-212`
- `docs/ROADMAP.md:222-241`
- `docs/ROADMAP.md:262-281`

**Problem**

CLAUDE.md puts plans in docs/planning/, but ROADMAP.md sits at docs/. It calls itself "read this first", yet lists landed work as open and cites things that do not exist:
- **Landed but listed as open:**
  - Scoping. The work is done (PROSPECTOR.md:807, "Partitions split themselves"), and the SCOPING.md it links does not exist.
  - The okx and bitget seed rebuilds (both done per planning/CATALOG.md:88).
  - Order-book series mappings (stocker has `dataset: 'books'` entries).
  - "Data we do not want" (handled by lens `prefer`, by stocker's rendering choice, and by cold evict).
- **Wrong:**
  - Cold tars are called `.pNN.tar`; the real name is `<venue>-<YYYYMM>.<NNN>.tar`.
  - It cites `scattered`, `subject` and an okx BUGS.md entry, none of which exist.
- **Time-relative text:** "another week or two" and "Iteration 1".
- **Duplication:** the first-haul section repeats planning/CATALOG.md.

**Evidence**

- `ls docs/planning` lists BUGS, CATALOG, COLD, REST, STOCKER, archived and mental-model.html, with no SCOPING.md or ROADMAP.md (re-checked).
- stocker/src/schema/series.ts:360, 476, 636, 703, 727, 828, 851 and 902 are `dataset: 'books'` entries.
- cold/config.ts:97-98 builds tarName as `${venue}-${month}.${String(seq).padStart(3,'0')}.tar`.
- shared/lenses/src/types.ts:188-194 defines `prefer`.
- No *.md file links ROADMAP.md (re-checked; only README.md mentions it by name).

**Fix**

1. `git mv docs/ROADMAP.md docs/planning/ROADMAP.md`. No inbound links exist, so only its own relative links change: `planning/X` becomes `X`, and `services/…`, `modules/…` and `tooling/…` become `../services/…` and so on. If README.md names ROADMAP in its doc table, update that entry.
2. Delete:
   - the first-haul section (:12-16), which stays in planning/CATALOG.md only;
   - "another week or two…" (:90-92);
   - "Archives are done, apart from the order-book datasets…" (:135-136);
   - the "Iteration 1" sentence (:210-212);
   - the seed-rebuild paragraph (:222-228);
   - the "data we do not want" paragraph (:230-235);
   - the SCOPING paragraph (:237-241);
   - the okx `scattered` bullet and the `subject` bullet (:270-275).
3. Replace the `.pNN.tar` sentence (:185) with "One month per venue, as one or more numbered tars (`<venue>-<YYYYMM>.<NNN>.tar`); see ../tooling/COLD.md".
4. Keep "What this is building toward" and "The simulator and the replay engine are different beasts".

**Tests and checks**

A link check over docs/planning/ROADMAP.md: every `](…)` target exists and every anchor matches a heading. `grep -nE 'SCOPING|scattered|subject|\.pNN|week or two|Iteration 1' docs/planning/ROADMAP.md` returns nothing.

**Verifier notes**

Confirmed, medium. The reviewer's "update the links in README.md and the other docs" overstated the work: there are no inbound .md links to update. Whether "data we do not want" is solved is a judgement call, but the evidence supports it well. Do this before DXC-02 and DXC-20.

## DXC-04: How a vault month is laid out on disk contradicts itself across docs

- **Severity:** medium
- **Category:** docs-contradiction
- **Decision:** IMPLEMENT
- **Source finding:** F3

**Locations**

- `docs/DATA_PIPELINE.md:107`
- `docs/services/STOCKER.md:370-371`
- `docs/services/STOCKER.md:63-66`
- `services/stocker/README.md:43-46`
- `docs/tooling/COLD-VAULT.md:15-16`

**Problem**

Two docs say each instrument gets its own file: DATA_PIPELINE.md:107 ("one file per instrument") and STOCKER.md:370 ("The vault holds one file per instrument"). The real layout is different. A month whose archives weigh up to 1 GB is one file under `@`, and only a larger month gets a file per instrument. STOCKER.md:63-66, the stocker README and COLD-VAULT.md all describe the real layout.

**Evidence**

services/stocker/src/vault.ts:13-14 documents both `@/<YYYYMM>.parquet` and `<symbol>/<YYYYMM>.parquet`. STOCKER.md:63-64: "A small one is a single file holding every instrument, under `@`…".

**Fix**

- **STOCKER.md:370:** replace "The vault holds one file per instrument. A file usually holds one instrument — the catalog's symbol." with "An archive file usually holds one instrument — the catalog's symbol."
- **DATA_PIPELINE.md:107:** if the file still exists, replace "a month of a dataset, one file per instrument" with "a month of a dataset — one file under `@`, or a file per instrument for a large month (see services/STOCKER.md#path-convention)". If DXC-02 has replaced the file, make sure ARCHITECTURE.md does not repeat the error.

**Tests and checks**

`grep -rn "one file per instrument" docs services/*/README.md` returns nothing.

**Verifier notes**

Confirmed. The verifier lowered severity from high to medium, because the authoritative path-convention section is correct and easy to find.

## DXC-05: CATALOG-LENSES says consumers never ask the catalog whether a month is settled; they do

- **Severity:** medium
- **Category:** docs-contradiction
- **Decision:** IMPLEMENT
- **Source finding:** F4

**Locations**

- `docs/modules/CATALOG-LENSES.md:8-9`
- `docs/modules/CATALOG-LENSES.md:196-210`

**Problem**

CATALOG-LENSES.md:203-206 says readiness is decided against a complete lens and that "Whether a month is 'closed' is never asked of the catalog". The code does the opposite. Stocker asks the partitions endpoint for `downloaded=true&settled=true` and passes no lens, and cold push does the same.

The section also breaks the dependency-direction rule. A provider concept is explained by naming its consumers (hauler, stocker, cold storage), at :8-9 and in "Who reads through one".

**Evidence**

services/stocker/src/catalog.ts:22-25 `new URLSearchParams({ 'downloaded': 'true', 'settled': 'true', ... })`. CATALOG-API.md:111-118 defines `settled`. COLD-PUSH.md:17-21 describes the same query.

**Fix**

- Delete the "Readiness is decided against a complete lens…" paragraph (:203-206).
- Rewrite :8-9 as "It is how a reader of the catalog says what it wants without the catalog changing, and how a person browses." Keep the CATALOG-API and CATALOG-UI pointers.
- Rename "## Who reads through one" to something neutral, such as "## Lenses and splitting work between readers".
- Keep "Several downloaders split the work by lens" and "A lens never scopes collection", worded as properties of lenses. A pointer to prospector/`PROSPECTOR_VENUES` may stay.
- Check that HAULER.md, STOCKER.md and COLD-PUSH.md each say how they use a lens, if they use one at all. Stocker passes no lens today.

**Tests and checks**

`grep -nE 'hauler|stocker|cold storage' docs/modules/CATALOG-LENSES.md` returns only pointer lines. `grep -n 'never asked of the catalog' docs` returns nothing.

**Verifier notes**

Confirmed. The paragraph is wrong twice: about settled partitions, and about stocker working through a lens. Do this together with DXC-01 and DXC-22.

## DXC-06: planning/COLD.md lists landed work as not built, with a broken reference

- **Severity:** medium
- **Category:** docs-staleness
- **Decision:** IMPLEMENT
- **Source finding:** F10

**Locations**

- `docs/planning/COLD.md:8-11`
- `docs/planning/COLD.md:13-19`
- `docs/planning/COLD.md:31-32`
- `docs/planning/COLD.md:34-35`
- `docs/planning/COLD.md:37-39`

**Problem**

planning/COLD.md lists three pieces of landed work as not built:
- `cold audit`;
- `cold pull archives`;
- `cold evict archives` with a vault that is partly away.

It also cites `legacy/docs/COLD-EVICT.md`, which does not exist, and claims COLD-AUDIT.md describes audit "as designed", which contradicts COLD-AUDIT.md.

**Evidence**

- dev/tooling/src/tools/cold/audit/checks/ holds disk, mega, record, staging and tars.
- pull/archives/ holds bring, index and survey. pull/command.ts:58/78 offers both archives and vault.
- evict/archives/survey.ts:57-71 falls back to files on disk in the vault.
- legacy/ holds README.md, audit.ts, config.ts, evict/ and types.ts, with no docs/ folder.

**Fix**

In docs/planning/COLD.md:
- **:8-11:** replace with "`cold push`, `cold evict`, `cold pull` and `cold audit` work on the archives and the vault: how is COLD.md, COLD-PUSH.md, COLD-EVICT.md, COLD-PULL.md, COLD-AUDIT.md and COLD-VAULT.md."
- **:13-19:** delete the paragraph. If something must stay, keep one sentence pointing at dev/tooling/src/tools/cold/legacy/README.md, with no legacy/docs path and no COLD-AUDIT clause.
- **Delete** the items at :31-32 ("vault that is partly away"), :34-35 (`cold audit`) and :37-39 (`cold pull archives`).
- **Keep** "A first real push", "A first real run of the vault commands" and "A partition the catalog withdraws entirely". Optionally note that pull archives and audit have not run against real Mega either; confirm this with the owner.

**Tests and checks**

`grep -nE 'legacy/docs|as designed|cold audit.*not built|pull archives' docs/planning/COLD.md` returns nothing.

**Verifier notes**

Confirmed. All four stale items verified against the code.

**Owner question**

Have `cold push`, the vault commands, `pull archives` and `audit` run against real Mega yet? The answer decides which "first real run" items stay. This is a sub-question; the decision on the item is still IMPLEMENT.

## DXC-07: planning/CATALOG.md and planning/BUGS.md hold landed or unverifiable entries

- **Severity:** medium
- **Category:** docs-staleness
- **Decision:** IMPLEMENT
- **Source finding:** F11

**Locations**

- `docs/planning/CATALOG.md:11-12`
- `docs/planning/CATALOG.md:50-58`
- `docs/planning/BUGS.md:12-31`

**Problem**

planning/CATALOG.md has three stale passages:
- :11-12 says "Moving stocker onto the catalog is STOCKER.md". Stocker already runs on the catalog, and planning/STOCKER.md is now about instruments.
- Hauler item 4 (cold scripts and stocker on hauler's layout) has landed.
- Item 1 is a dated progress log that duplicates ROADMAP.md.

BUGS.md's first entry cannot be re-checked by its own rule:
- Its check uses a facts store (`@shared/facts/vault.sqlite`) that no longer exists.
- It describes a legacy dashboard cell.
- It defers the fix to a move that has already happened.

**Evidence**

`ls shared` gives lenses, types and utils. legacy/README.md:3-4 says the facts store no longer exists. planning/STOCKER.md:8 opens "Stocker runs on the catalog". services/stocker/src/catalog.ts exists.

**Fix**

- **docs/planning/BUGS.md:** delete :12-31 (the entry and its trailing `---`).
- **docs/planning/CATALOG.md:** delete "Moving stocker onto the catalog is [STOCKER.md](STOCKER.md)." (:11-12) and Hauler item 4 (:58).
- **Hauler item 1 (:50-53):** reduce it to the action ("Finish the first haul through `backfill-20` into /data/tradebot/archives; a clean catalog should produce no `.bak`") and drop the 2026-10-02/10-07 measurements. Delete it if the haul is done.
- **The first-haul pointer in ROADMAP.md:** remove it (DXC-03 does this).
- **Hauler items 2-3 and the :38-44 database note:** leave them unless the owner confirms they are done.

**Tests and checks**

`grep -n 'facts' docs/planning/BUGS.md` and `grep -n 'Moving stocker' docs/planning/CATALOG.md` both return nothing.

**Verifier notes**

Confirmed. The verifier cautions that only the clearly stale lines should be cut without asking the owner.

**Owner question**

Is the first haul through backfill-20 finished, and are Hauler items 2-3 still pending? This is a sub-question; the decision on the item is still IMPLEMENT for the clearly stale lines.

## DXC-08: Venue docs explain this repo's services, which breaks the venues-are-providers rule

- **Severity:** medium
- **Category:** docs-dependency-direction
- **Decision:** IMPLEMENT
- **Source finding:** F5

**Locations**

- `docs/venues/BITGET-SEED.md:1-259`
- `docs/venues/BITGET.md:33`
- `docs/venues/BITGET.md:53-61`
- `docs/venues/BITGET.md:564-715`
- `docs/venues/BYBIT.md:85`
- `docs/venues/BYBIT.md:121`
- `docs/venues/BYBIT.md:155-161`
- `docs/venues/BYBIT.md:233-246`
- `docs/venues/GATE.md:215-266`
- `docs/venues/GATE.md:353`
- `docs/venues/HTX.md:204`
- `docs/venues/HTX.md:243-244`
- `docs/venues/HTX.md:447-453`
- `docs/venues/OKX.md:505`
- `docs/venues/OKX.md:641-647`
- `docs/venues/BINANCE.md:34`
- `docs/venues/BINANCE.md:85`
- `docs/venues/BINANCE.md:120`

**Problem**

CLAUDE.md says docs/venues/** never names a service of this repo. The venue docs do it constantly:
- **BITGET-SEED.md** is entirely about prospector's seed CSVs.
- **BITGET.md** has "Building the seed" and "What this catalog refuses".
- **BYBIT.md** mentions adapter `accepts` and prospector's limiter.
- **GATE.md** has "What the catalog places" and names a source file.
- **HTX.md** says a quirk belongs in stocker's `spill` handling.
- **OKX.md** cites prospector source lines.
- **BINANCE.md** cites `tagOf`.
KUCOIN.md is clean and serves as the template.

**Evidence**

`grep -nciE 'prospector|hauler|stocker|catalog|adapter|seed|lens|vault' docs/venues/*.md` gives BITGET-SEED 33, BITGET 37, GATE 11, BINANCE 10, BYBIT 10, OKX 9, HTX 6 and KUCOIN 0. Some of these hits are a venue's own use of "catalog" or "listing", but the specific examples above were each verified.

**Fix**

1. Move docs/venues/BITGET-SEED.md next to the seed it describes (see DXC-09). Nothing links it, so no links break.
2. In BITGET.md, move "### Building the seed" (:564-~682) and "### What this catalog refuses" (:683-715) out:
   - the seed procedure goes to the seed README;
   - the refusals go to PROSPECTOR.md, under a new "Venues" section with one short subsection per venue, each pointing back to the venue doc.
   Keep the pure venue facts in BITGET.md: what the index offers, 403 meaning absence, and which listings are not crypto.
3. In BYBIT, GATE, HTX, OKX and BINANCE, rewrite every sentence that names any of these: an adapter hook (`accepts`, `tagOf`, `probingLag`), a seed, "the catalog", prospector, stocker, `spill`, or a source file. Keep only the venue fact it rests on. Move how a service handles the fact into that service's doc: PROSPECTOR.md#venues for adapter handling, STOCKER.md for spill handling.
4. Do this one venue at a time. Fold in DXC-18 (OKX ETag paragraph) and DXC-20's OKX link fixes.

**Tests and checks**

Done when `grep -nE 'prospector|hauler|stocker|adapter|seed\.ts|accepts|tagOf|spill|services/' docs/venues/*.md` returns nothing, apart from deliberate pointer lines the doc does not depend on. Every moved section is reachable from PROSPECTOR.md or STOCKER.md.

**Verifier notes**

Confirmed, medium. The work is large (L) but mechanical and safe, and it fits the user's request for a fresh start. It can be split per venue.

## DXC-09: Prospector seeds README is outdated, and the bitget seed's doc lives in docs/venues

- **Severity:** medium
- **Category:** docs-staleness
- **Decision:** IMPLEMENT
- **Source finding:** F13

**Locations**

- `services/prospector/src/database/migrations/seeds/README.md:3-26`
- `services/prospector/src/database/migrations/seeds/README.md:161-163`
- `docs/venues/BITGET-SEED.md:79-85`
- `docs/venues/BITGET.md:564-567`

**Problem**

The seeds README says seeds exist only for okx and bitget, and its Layout lists only those two. The directory also holds binance/, gate/ and htx/ pattern.csv seeds, which migrations 002, 005 and 006 use for retirement dates and shapes.

The bitget seed doc has two problems:
- It sits in docs/venues.
- It carries history and plans: "That rule is gone… Both come back when…" in BITGET-SEED.md, and "This is in progress; the description will change as it does" in BITGET.md:566.

**Evidence**

`ls services/prospector/src/database/migrations/seeds` gives README.md, binance, bitget, gate, htx, okx and seed.ts. 002-htx.ts:26, 005-gate and 006-binance call `seed(db, '<venue>')`.

**Fix**

- **seeds/README.md intro:** reword to "What a walk cannot establish: every pattern and series of a venue with no listing (okx, bitget), and pattern facts a listable venue's archive cannot show, such as the date a shape was retired (htx, gate, binance)."
- **seeds/README.md Layout:** add `binance/`, `gate/` and `htx/`, each `pattern.csv` only.
- **Move docs/venues/BITGET-SEED.md** to services/prospector/src/database/migrations/seeds/bitget/README.md, or into a section of the seeds README. Cut the history and plans at :79-85 and state only the current behaviour, checked against seed.ts (for example, whether `last` is empty and whether SEEDED_AT withholds bitget's entry). Point to docs/venues/BITGET.md for venue facts rather than restating them.
- **docs/venues/BITGET.md:564-660:** keep the venue facts there. Move the seed-building procedure and the "why the seed states shapes" rationale to the seed README. Delete "This is in progress; the description will change as it does."
- **Links:** update them, using `grep -rn 'BITGET-SEED' docs services` to find them.

**Tests and checks**

`ls docs/venues/BITGET-SEED.md` fails (the file has moved). The seeds README Layout matches `ls seeds`. `grep -rn 'BITGET-SEED\|in progress' docs` returns nothing stale.

**Verifier notes**

Confirmed. The verifier's caveat: BITGET.md's "Building the seed" section contains genuine venue facts, and those stay in BITGET.md. Do this inside the DXC-08 pass.

## DXC-10: Key terms (origin, bucket, slice, shape, vault, letter folder) carry several meanings; VOCABULARY.md defines none of the overlaps

- **Severity:** medium
- **Category:** docs-terminology
- **Decision:** IMPLEMENT
- **Source finding:** F9

**Locations**

- `docs/VOCABULARY.md:6-104`
- `docs/ROADMAP.md:75-133`
- `docs/DATA_PIPELINE.md:116-125`
- `docs/tooling/COLD.md:29-31`
- `docs/tooling/COLD.md:60-70`
- `docs/modules/CATALOG-API.md:123`
- `docs/modules/CATALOG-API.md:134`
- `docs/modules/CATALOG-API.md:179`
- `docs/modules/CATALOG-API.md:215-219`
- `docs/services/HAULER.md:29`
- `docs/services/HAULER.md:105-108`
- `docs/services/CATALOG-UI.md:345`
- `docs/services/STOCKER.md:682-726`
- `docs/modules/ARCHIVES.md:19`
- `services/catalog-ui/README.md:25`
- `services/vault/README.md:14`

**Problem**

Six terms carry more than one meaning:
- **origin:** ROADMAP and DATA_PIPELINE use it for what VOCABULARY calls a *source*. COLD.md uses it for a tree to back up.
- **bucket:** three meanings: an S3 bucket, the venue-wide `@` file (which VOCABULARY calls the `market` bundle), and a time period in STOCKER.
- **slice:** lenses are called "named slices", but VOCABULARY defines slice and lens as different things.
- **shape:** used throughout CATALOG-API and never defined.
- **vault:** names both the CSV vault service and the Parquet vault, and both mount `/data/vault`.
- **letter folder:** CATALOG-API uses `F` and HAULER uses `FL`.

The catalog's `books` dataset is stocked as the vault's `orderBook` table, with no defined term for *table*.

**Evidence**

- COLD.md:62: "An origin is a tree to back up".
- ROADMAP.md:98: "Three origins".
- CATALOG-API.md:134 describes the `buckets` field.
- HAULER.md:105: "The bucket is a level shallower".
- stocker/src/schema/tables.ts:254 maps ROOTS to orderBook.
- DATA_PIPELINE.md:82: "both historically called vault".

**Fix**

Changes to **docs/VOCABULARY.md** (definitions only, no venue facts, no service internals):
- Define **Shape**: venue + market + dataset + variant + grain, without bundle. Alternatively, replace "shape" in CATALOG-API with an existing term.
- Under **Bundle**, add: "the `market` bundle is spelled `@` in keys and paths."
- Define **Table** as the vault's canonical name a dataset is stocked into (for example, catalog `books` becomes vault `orderBook`). Leave the mapping itself to STOCKER.md.
- Optionally add **Series**, **Pattern** and **Ledger**, if they are used across several docs.

Changes to the other docs:
- **"origin" in ROADMAP and DATA_PIPELINE:** becomes "source" wherever the text survives DXC-02/DXC-03.
- **COLD.md:** keep `origin` as the CLI argument name, defined once at :60-62 as "the tree a command acts on". Use "tree" in prose elsewhere.
- **HAULER.md:105:** "The market bundle (`@`) is a level shallower".
- **CATALOG-API.md:179/:219:** "bucket" becomes "market-bundle file". Document the `buckets` JSON field (:134) as "count of market-bundle (`@`) files", without renaming the field.
- **CATALOG-UI.md:345:** follow DXC-16. The UI labels are "Market Bundles", and the doc should say so.
- **STOCKER.md:682-726:** "bucket" becomes "period". Update the anchor and the links that use it (e.g. :60, :150).
- **HAULER.md:** `FL` becomes `F`, matching CATALOG-API.md:215.
- **ARCHIVES.md:19 and the catalog-ui README:25:** "named slices" becomes "named selections".
- **services/vault:** call it "the vault service" wherever it could be confused with the Parquet vault.

**Tests and checks**

`grep -rn -i 'named slice\|/FL/' docs services/*/README.md` returns nothing. Every `bucket`/`origin` hit left over from `grep -rn -i 'origin\|bucket' docs` is either the S3 sense or the cold CLI argument. Anchors renamed in STOCKER.md still resolve.

**Verifier notes**

Confirmed. Renaming the UI label or the `buckets` JSON field is a code/API change and is out of scope (see Rejected). The "named slices" hit is at ARCHIVES.md:19, not :171. VOCABULARY.md must stay definitions-only.

## DXC-11: Tooling docs: `cold` missing from the tooling README, env precedence wrong, root README calls the tools `tb`

- **Severity:** medium
- **Category:** docs-accuracy
- **Decision:** IMPLEMENT
- **Source finding:** F18

**Locations**

- `dev/tooling/README.md:1-31`
- `dev/tooling/README.md:199-206`
- `dev/tooling/README.md:248-287`
- `dev/tooling/README.md:382-394`
- `docs/tooling/COLD.md:148`
- `docs/tooling/COLD-PUSH.md:194`
- `README.md:55`

**Problem**

**dev/tooling/README.md:**
- It has no `cold` section and only one passing example.
- Its directory tree omits tools/cold and tests/tools/cold.
- Its numbered env precedence list is wrong: dev/tooling/.env actually overrides `-e`, and the list omits the `-m` module env.
- It has a "Future Enhancements" plan section.

**COLD.md and COLD-PUSH.md** say configuration is "read from dev/tooling/.env". Cold also reads the root .env (DATA_DIR, DATA_*_DIR) and modules/collect/archives/.env (CATALOG_PORT, CATALOG_TOKEN).

**README.md:55** describes docs/tooling as "the `tb` command-line tools". `tb` is the dx compose wrapper; these docs cover `./tools`.

**Evidence**

- dev/tooling/src/shared/utils/env.ts:39-52: `{ ...rootEnv, ...moduleEnv, ...additionalEnv, ...toolingEnv }`, then process.env.
- index.ts registers cold.
- cold/config.ts:148-149 parses modules/collect/archives/.env.

**Fix**

1. **dev/tooling/README.md:**
   - Add a short `cold` section: what it is, its subcommands, and a pointer to docs/tooling/COLD.md.
   - Replace the precedence list with the order in env.ts: root .env → modules/<m>/.env (with -m) → -e file → dev/tooling/.env → process.env, each later one overriding the earlier.
   - Regenerate the directory tree from `find dev/tooling/src dev/tooling/tests`.
   - Delete "Future Enhancements", or move it to docs/planning/ if the owner wants to keep it.
2. **COLD.md:148 and COLD-PUSH.md:194:** replace "Read from dev/tooling/.env" with a sentence naming the layers. Cold reads the tooling's layered env (root .env, which holds DATA_DIR and DATA_*_DIR; dev/tooling/.env; -e/-m), plus modules/collect/archives/.env for the catalog's port and token. Keep the detail in COLD.md and have COLD-PUSH point to it.
3. **README.md:55:** change the row to "`docs/tooling/` | `./tools`, the repo's dev CLI (cold storage)", and add a line saying `tb` is the dx compose wrapper.

**Tests and checks**

The README's precedence list matches env.ts line by line. `grep -n 'tb' README.md` shows `tb` described only as the compose wrapper. The regenerated tree matches `find`.

**Verifier notes**

Confirmed, with nuance. The reviewer said the README "never mentions cold", but :218 has one example. README:21 is true for the root and -m files; the error is only in the numbered list. COLD-PUSH.md:207-208 already says part of this.

**Owner question**

dev/tooling/.env overrides an explicit `-e` file. Is that intended? The docs should describe the code as it is; if it is not intended, changing it is a separate code change.

## DXC-12: Docs present an empty CATALOG_PORT as normal, but `tools cold` on the host then waits forever on localhost:9010

- **Severity:** medium
- **Category:** docs-usability
- **Decision:** IMPLEMENT
- **Source finding:** F19

**Locations**

- `services/catalog/README.md:25`
- `docs/modules/ARCHIVES.md:52`
- `modules/collect/archives/.env.example:30-34`
- `docs/tooling/COLD-PUSH.md:204-208`

**Problem**

The catalog README, ARCHIVES.md and the archives .env.example all present an empty CATALOG_PORT as fine, with docker picking a free port. Cold on the host then breaks:
- It falls back to http://localhost:9010.
- The catalog is published on a random port instead.
- Cold waits for a catalog that is not there, because COLD.md's "a service that is not answering is waited for" applies.

COLD-PUSH.md:207 says the address defaults from the module's settings. That is silently false when the module leaves the port empty.

**Evidence**

cold/config.ts:85: `catalogUrl: getEnv('CATALOG_URL','') || `http://localhost:${archives['CATALOG_PORT'] || 9010}``. services/catalog/docker/compose.yml:46: `${CATALOG_PORT:-}:8080`.

**Fix**

1. **COLD-PUSH.md environment table:** give the `CATALOG_URL` default as "`http://localhost:$CATALOG_PORT` from modules/collect/archives/.env, else `http://localhost:9010`". Add: with CATALOG_PORT empty, docker publishes the catalog on a random port, so set CATALOG_PORT in the archives module or set CATALOG_URL; otherwise cold waits on a catalog that is not there.
2. **ARCHIVES.md:52 and services/catalog/README.md:25:** add "Set it wherever something on the host calls the catalog, e.g. `tools cold`." This names an example consumer under CLAUDE.md's pointer exception, not a reason for the setting.
3. **modules/collect/archives/.env.example:31-33:** reword the same way.

**Tests and checks**

Doc review only. Optionally, as a separate code change outside this docs unit, have cold log the URL it is waiting on.

**Verifier notes**

Confirmed. The archives .env.example already partly mitigates this ("Set it when something outside has to reach the catalog"), but no doc connects it to `tools cold`.

## DXC-13: Infra pack, redis and rabbitmq READMEs contradict the compose files and each other

- **Severity:** medium
- **Category:** docs-accuracy
- **Decision:** IMPLEMENT
- **Source finding:** F16

**Locations**

- `modules/infra/README.md:20-36`
- `modules/infra/README.md:42-48`
- `modules/infra/README.md:62-88`
- `modules/infra/local/compose.yml:11`
- `modules/infra/market/compose.yml:8`
- `services/redis/README.md:7-24`
- `services/redis/README.md:60`
- `services/redis/README.md:66-75`
- `services/rabbitmq/README.md:3`
- `services/rabbitmq/README.md:15-18`
- `services/rabbitmq/README.md:36-41`

**Problem**

**modules/infra/README.md:**
- It marks a local `queue`, but that service is commented out.
- It gives the cache hostname as `redis` for every pack. The real hostname is `cache` on local and `redis` on market.
- It describes `DB_*_URL` values in the root .env; there are none.
- It names modules that do not exist (archivist, collector, packer, gui, …).
- All of its anchors are broken.

**services/redis/README.md:**
- It tells the reader to "build" a stock image.
- It uses `tb up infra`, and there is no such target.
- It uses host `@redis`.

**services/rabbitmq/README.md:**
- It says version 3.13; the image is 3.12.
- It documents RABBITMQ_*_PORT, which no production compose reads.
- It quotes a hoarder compose snippet that does not exist.

**Evidence**

- local/compose.yml:16-26: `# queue:`, which is commented out. Its cache service is named `cache`.
- market/compose.yml includes services/redis/docker/compose.yml, whose service is `redis`.
- .env.example:47: `CACHE_URL=…@cache:6379`.
- rabbitmq/docker/base.yml: `rabbitmq:3.12-management-alpine`.
- hoarder/docker/compose.yml:19: `QUEUE_URL: ${QUEUE_URL}`.
- RABBITMQ_AMQP_PORT is read only by shared/utils/src/testing/docker/rabbitmq.yml and the pipe/router test envs.

**Fix**

1. **Rewrite modules/infra/README.md from the five compose files.** Use one table of pack × {queue, queue-rt, cache}, giving the actual hostname for each:
   - local: queue-rt, cache (no queue);
   - store: queue, queue-rt;
   - market: queue, queue-rt, redis;
   - bootcamp: queue-rt;
   - shuttle: queue.
   List the root .env.example variables: QUEUE_USER, QUEUE_PASS, QUEUE_PORT, QUEUE_MGMT_PORT, QUEUE_URL, QUEUE_RT_PORT, QUEUE_RT_MGMT_PORT, QUEUE_RT_URL, CACHE_PASS, CACHE_PORT and CACHE_URL.
2. **In the same file, drop:**
   - the DB_* text;
   - the names of modules that do not exist;
   - the broken anchors (or change them to #infra-pack-local and so on).
3. **Comments:** fix the header comments in local/compose.yml:11 and market/compose.yml:8 that say `redis`. Remove the module names in store/compose.yml:6 and shuttle/compose.yml:3. These are comment-only edits.
4. **services/redis/README.md:** trim it to:
   - the image (redis:7-alpine, no build);
   - CACHE_PASS and CACHE_PORT;
   - the URL form from .env.example;
   - a pointer to the infra README for hostnames.
   Delete `tb up infra` and "Build the image".
5. **services/rabbitmq/README.md:** trim it to:
   - the image 3.12-management-alpine;
   - QUEUE_USER and QUEUE_PASS;
   - the ports the packs publish (QUEUE_PORT/QUEUE_MGMT_PORT, or QUEUE_RT_*);
   - the URL form `amqp://${QUEUE_USER}:${QUEUE_PASS}@queue:5672`.
   Replace the fictitious hoarder snippet with the real `QUEUE_URL: ${QUEUE_URL}`. Mention RABBITMQ_AMQP_PORT/MGMT_PORT only as the test-harness ports, or drop them.

**Tests and checks**

Each hostname in the infra table matches a `services:` key, or a hostname override, in the corresponding compose.yml. `grep -rn 'archivist\|tb up infra\|3.13\|DB_.*_URL' modules/infra services/redis services/rabbitmq` returns nothing.

**Verifier notes**

Confirmed, with two corrections. RABBITMQ_*_PORT is read by the test harness. The cache hostname differs between the packs themselves, so the README's `redis` is right for market and wrong for local. The practical impact is small, because only deprecated services consume CACHE_URL.

**Owner question**

Should the market pack name its cache `cache`, extending services/redis the way local does, so that CACHE_URL works on every pack? If not, the infra README documents the difference between packs.

## DXC-14: docker/README.md describes a Dockerfile and build that do not exist

- **Severity:** medium
- **Category:** docs-accuracy
- **Decision:** IMPLEMENT
- **Source finding:** F17

**Locations**

- `docker/README.md:7`
- `docker/README.md:32`
- `docker/README.md:44-56`

**Problem**

The README documents `docker/node.Dockerfile`, built with `npm ci`/`npm run build` per service, and says the image copies only what is needed. The reality is different:
- There are four files: dev/prod × node/python. Each compose chooses one with `${APP_ENV:-prod}`.
- The build is pnpm with corepack, for the whole workspace.
- The prod runtime stage copies the whole built /app.
- The dev image and the python images are not mentioned at all.

**Evidence**

`ls docker` gives dev.node, dev.python, prod.node and prod.python Dockerfiles, plus node/ and python/ entrypoints. prod.node.Dockerfile runs `corepack enable`, `pnpm install` and `pnpm run build`, then `COPY --from=builder /app .`. services/*/docker/compose.yml uses `dockerfile: docker/${APP_ENV:-prod}.node.Dockerfile`.

**Fix**

Rewrite docker/README.md from the four Dockerfiles and the two entrypoints. Cover:
- **Selection:** APP_ENV (default prod) chooses `docker/${APP_ENV}.node.Dockerfile`, and the python pair works the same way.
- **Build args:** SERVICE_NAME (required; the folder under services/) and NODE_MEMORY_MB (default 2048, passed as --max-old-space-size).
- **Prod image:** the builder stage runs `COPY . .`, corepack, `pnpm install` and `pnpm run build` for the whole workspace. The runtime stage copies the whole built /app, sets WORKDIR /app/services/$SERVICE_NAME, and runs dumb-init then `node dist/index.js`.
- **Dev image:** what dev.node.Dockerfile and node/entrypoint.sh actually do. Read them first; WORKDIR /live and CI=true point to a bind-mounted tree.

Also:
- Remove all npm text and the claim that the image holds only the service's dependencies.
- Keep EXPOSE 3000. Describe the health endpoint as what the compose healthchecks expect, not as a Dockerfile feature.
- Check the .dockerignore bullets against the actual file.

**Tests and checks**

Every command and file the README names appears in docker/*.Dockerfile or docker/*/entrypoint.sh. `grep -n npm docker/README.md` returns nothing.

**Verifier notes**

Confirmed. EXPOSE 3000, dumb-init and NODE_MEMORY_MB=2048 are accurate. The rest is a pure doc rewrite.

## DXC-15: docs/services/UI.md and the UI stub README describe things that are not there

- **Severity:** medium
- **Category:** docs-staleness
- **Decision:** IMPLEMENT
- **Source finding:** F15

**Locations**

- `docs/services/UI.md:21`
- `docs/services/UI.md:45-66`
- `docs/services/UI.md:70`
- `docs/services/UI.md:123-127`
- `services/_stub/ui/README.md:9-21`

**Problem**

**UI.md** does not match the stub:
- It has a dated "Current State (as of April 2026)" section that says the data layer does not exist yet. data/DataProvider, EnvProvider, WsClient, BitmexClient and DiggerClient all exist.
- Its documented tree (src/hooks/, data/channels/, LiveClient, ReplayClient) does not match the source.
- It is shaped around BitMEX channels, though BitMEX is closed and the README forbids venue-named platform docs.
- It uses future tense.
- DiggerClient targets the retired `digger`.

**The stub README** has two problems:
- It uses `tb up gui/bitmex`, and no such module exists.
- It defaults to live bitmex.com URLs.

**Evidence**

`find services/_stub/ui/src -type f` shows data/{BitmexClient,WsClient,DiggerClient,DataProvider,EnvProvider,…} and no hooks/ directory; the hooks sit beside the widgets. modules/ holds only collect, infra and store.

**Fix**

1. Move UI.md's forward-looking design to **docs/planning/UI.md** and make it venue-neutral. That covers the time-machine modes, the "widgets are pure consumers" rule, the hook/channel contract and the replay switch. Drop "matches the BitMEX WebSocket channel" (:70) and the dated "Current State" section. Then delete docs/services/UI.md, since no running service backs it.
2. Rewrite **services/_stub/ui/README.md** to say what is true today:
   - it is an unbuilt React/Vite stub, wired against BitMEX REST/WS and the retired `digger`;
   - no module deploys it;
   - docs/planning/UI.md holds the intended design.
   Remove the `tb up/down/logs gui/bitmex` block. Keep the env table only if it is labelled as the stub's hardcoded BitMEX defaults.
3. Update the "Technical reference" link in the stub README.

**Tests and checks**

`grep -rn 'services/UI.md\|gui/bitmex' --include=*.md .` returns nothing, excluding node_modules and submodules.

**Verifier notes**

Confirmed, with the fix adjusted. Rather than deleting UI.md outright, keep its design intent as a plan under docs/planning/, because the owner may want it for the functionality they plan to build.

**Owner question**

Should services/_stub/ui stay where it is or move to services/.deprecated/? The doc fixes are the same either way.

## DXC-16: CATALOG-UI.md restates lens semantics, with a nonexistent instrument picker and wrong bundle labels

- **Severity:** medium
- **Category:** docs-one-home
- **Decision:** IMPLEMENT
- **Source finding:** F20

**Locations**

- `docs/services/CATALOG-UI.md:287-305`
- `docs/services/CATALOG-UI.md:345-352`

**Problem**

The Lenses section re-explains lens semantics that CATALOG-LENSES.md owns, which makes two homes for one subject. Two of its statements are also wrong:
- It describes an instrument picker ("Instruments are searched, not browsed… badges"). None exists; a rule never names an instrument.
- It gives the bundle choices as "*Both*, *Per instrument* or *Buckets*".

**Evidence**

- services/catalog-ui/web/views/Lenses.tsx:958-959: "A rule never names an instrument".
- :1063-1066: BUNDLES = 'per Instrument' and 'Market Bundles'.
- `choices()` at :1072-1076 renders Any, Only <form>, and, for includes only (:834), Prefer <form>.

**Fix**

1. Delete the "Instruments are searched, not browsed" paragraph.
2. Replace the "A rule picks a bundle" paragraph with one line: each rule's Grain and Bundle selects offer Any, Only <form> and (for includes only) Prefer <form>, where the bundle forms are per Instrument and Market Bundles; what these mean is in CATALOG-LENSES.md.
3. Cut the semantic restatements ("Includes minus excludes", the meaning half of "A rule states only what it constrains") and point to CATALOG-LENSES.md instead.
4. Keep only what the editor does:
   - the per-venue blocks and the `every` display;
   - drafts and Confirm/Drop/Discard/Revert;
   - New Lens;
   - server refusals shown on the rule;
   - the size bar and its 30 s refresh;
   - localStorage drafts and Reload as saved.

**Tests and checks**

Every UI label quoted in CATALOG-UI.md appears as a literal string in Lenses.tsx.

**Verifier notes**

Confirmed. The reviewer's proposed labels ("any / per Instrument / Market Bundles") were themselves imprecise, because the select also offers Only and Prefer variants. The refined fix above lists them correctly.

## DXC-17: REST knowledge has three deep homes (docs/REST.md, docs/planning/REST.md, each venue doc)

- **Severity:** medium
- **Category:** docs-one-home
- **Decision:** DEFER
- **Source finding:** F12

**Locations**

- `docs/REST.md:1-203`
- `docs/planning/REST.md:1-749`
- `docs/venues/BYBIT.md:348-496`
- `docs/venues/OKX.md:950-1118`
- `docs/venues/GATE.md:462-607`
- `README.md:59-61`

**Problem**

The same per-venue REST facts (endpoints, page sizes, limits) are written in depth three times. For example, bybit's 600 calls per 5 s appears in all three places.
- **planning/REST.md** is not a plan. It is a finished, dated survey ("Done twice over, on 2026-10-09 and 10").
- **docs/REST.md** names venues outside docs/venues, which README.md:59-61 calls a bug.

**Evidence**

planning/REST.md:12-16 describes this three-layer arrangement itself. `grep -n 600 docs/REST.md docs/planning/REST.md docs/venues/BYBIT.md` matches in all three files.

**Fix**

Do this as a dedicated pass, one venue at a time.
1. For each venue, diff the planning/REST.md section and the docs/REST.md section against docs/venues/<VENUE>.md#REST. Move any fact found only in the first two into the venue doc, keeping its seen/documented/not-known marking.
2. Create docs/venues/REST.md holding only the cross-venue comparison:
   - the summary table and limits-side-by-side from docs/REST.md;
   - planning/REST.md's limits table, "The answer" and "Across the venues".
   Each row links to its venue doc, and the file names no services of this repo.
3. Delete docs/REST.md.
4. Reduce planning/REST.md to a short, undated plan of what a REST collector must cope with, or delete it.
5. Update the links (DATA_PIPELINE/ARCHITECTURE, README.md; find them with `grep -rn 'REST.md' docs services`).

**Tests and checks**

No REST fact appears in more than one venue-level place. A link check passes. `grep -rn 'REST.md'` resolves to existing files only.

**Verifier notes**

Confirmed but deferred. This is an M-L merge in which survey findings can be lost, and it includes a structural choice about the doc's home.

**Owner question**

Where should the cross-venue REST comparison live: docs/venues/REST.md, or docs/REST.md kept but made venue-agnostic? And should planning/REST.md survive as a short REST-collector plan, or be deleted? The merge also needs fact-by-fact care across about 950 lines, so it should be its own pass.

## DXC-18: OKX.md says prospector compares ETags case-sensitively; the code and PROSPECTOR.md say case-blind

- **Severity:** low
- **Category:** docs-contradiction
- **Decision:** IMPLEMENT
- **Source finding:** F6

**Locations**

- `docs/venues/OKX.md:640-647`
- `docs/services/PROSPECTOR.md:2116-2121`

**Problem**

OKX.md:641-647 says two prospector comparisons are case-sensitive "today" and that ETags want normalising. Both claims are false: the code lower-cases every ETag. The paragraph also links a routes.ts that does not exist, and cites a queries.ts line that is now unrelated. On top of that, it breaks the venues-are-providers rule.

**Evidence**

services/prospector/src/etag.ts: `etagOf = raw => raw?.replace(...).toLowerCase()`. `ls services/prospector/src/api` gives collector.ts, index.ts, lenses.ts and reports.ts. queries.ts:1035 is `UPDATE run SET cursor`.

**Fix**

Replace OKX.md:640-647 with the venue fact alone: "**The ETag case differs by origin** — OSS answers uppercase, S3 lowercase — for byte-identical objects (same length, same md5)." PROSPECTOR.md needs no change.

**Tests and checks**

`grep -n 'routes.ts\|queries.ts\|case-sensitive' docs/venues/OKX.md` returns nothing.

**Verifier notes**

Confirmed, lowered to low severity: the worst outcome is someone re-investigating a bug that is already fixed. Do it as part of the DXC-08 pass.

## DXC-19: The walk-schedule example (`bitget: 1,10,20`) would stop prospector at startup

- **Severity:** low
- **Category:** docs-accuracy
- **Decision:** IMPLEMENT
- **Source finding:** F7

**Locations**

- `services/prospector/README.md:115-117`
- `docs/services/PROSPECTOR.md:1230-1233`

**Problem**

Both docs show `bitget: 1,10,20` as an example line of walk-schedule.yaml. Bitget cannot be listed, so the schedule is rejected and the service exits cleanly, and nothing restarts it. PROSPECTOR.md:1237 itself says only listable venues may be named. The shipped example file uses kucoin.

**Evidence**

adapters/bitget.ts:18 sets `listable: false`. schedule.ts:58-60 throws "cannot be listed". index.ts:99-103 logs and calls process.exit(0). walk-schedule.example.yaml uses `# kucoin: 1,10,20`.

**Fix**

Replace `bitget: 1,10,20` with `kucoin: 1,10,20` in services/prospector/README.md:116 and in docs/services/PROSPECTOR.md:1231. In the README, add: "Only a venue that can be listed may be named — not okx or bitget."

**Tests and checks**

`grep -rn 'bitget: 1,10,20' docs services` returns nothing.

**Verifier notes**

Confirmed, lowered to low severity: the failure is loud and immediate, and its message names the problem.

## DXC-20: Broken links and anchors across docs

- **Severity:** low
- **Category:** docs-links
- **Decision:** IMPLEMENT
- **Source finding:** F23

**Locations**

- `docs/services/PROSPECTOR.md:955`
- `docs/services/PROSPECTOR.md:960`
- `docs/services/PROSPECTOR.md:975`
- `docs/venues/OKX.md:643`
- `docs/venues/OKX.md:711`
- `docs/ROADMAP.md:235`
- `docs/ROADMAP.md:240`
- `docs/planning/archived/PLAN.md:18`
- `modules/infra/README.md:44-48`
- `.github/copilot-instructions.md:7`
- `.github/copilot-instructions.md:37`

**Problem**

Several links point at renamed headings or missing files:
- **PROSPECTOR.md:** three anchors into GATE.md that no longer exist.
- **OKX.md:** a renamed anchor, and a link to the missing routes.ts.
- **ROADMAP.md:** a missing planning/CATALOG anchor and the missing SCOPING.md.
- **archived/PLAN.md:** the missing EXECUTOR.md.
- **modules/infra/README.md:** every anchor.
- **.github/copilot-instructions.md:** a link to a missing docs/ai/README.md, and a description of a `src/mongodb.ts` service module.

**Evidence**

A link and anchor checker (scratchpad/reviews/scratch/links.py) reported exactly these. `grep -n '^#' docs/venues/GATE.md` shows the renamed headings at :47, :68 and :393. The OKX heading is at :762.

**Fix**

- **PROSPECTOR.md :955/:960/:975:** change the anchors to #keys-filed-at-the-wrong-depth, #the-trees-and-which-are-dead and #2021-07-spot-data-at-the-futures-url.
- **OKX.md:711:** change to #ranges-and-why-the-monthly-sweep-is-how-to-get-them.
- **OKX.md:643:** remove the routes.ts#L433 link. DXC-18 deletes the paragraph anyway.
- **ROADMAP links:** these go away with DXC-03.
- **archived/PLAN.md:18:** unlink EXECUTOR.md and leave the plain text "(never written)".
- **modules/infra/README.md:** change the anchors to #infra-pack-local, #infra-pack-store, #infra-pack-market, #infra-pack-bootcamp and #infra-pack-shuttle, or follow DXC-13's rewrite.
- **.github/copilot-instructions.md:** point :7 at ../CLAUDE.md and ../README.md, and delete the `src/mongodb.ts` bullet at :37.
- **Rule from now on:** do not deep-link code lines (`file.ts#L123`) in docs.

**Tests and checks**

Re-run scratchpad/reviews/scratch/links.py over all in-scope .md files. It should report zero broken links, apart from the external ../tradebot-sim links.

Optionally, add a markdown link and anchor check to CI (lychee or markdown-link-check, with anchors on). Exclude node_modules, the submodules, .deprecated and the external ../tradebot-sim links.

**Verifier notes**

Confirmed. archived/PLAN.md is history by design, so the link there matters least.

## DXC-21: History and plans inside current-state docs

- **Severity:** low
- **Category:** docs-tense
- **Decision:** IMPLEMENT
- **Source finding:** F24

**Locations**

- `docs/services/PROSPECTOR.md:639`
- `docs/services/PROSPECTOR.md:1860-1862`
- `docs/services/PROSPECTOR.md:2228-2231`
- `docs/services/PROSPECTOR.md:2521`
- `docs/services/PROSPECTOR.md:2645`
- `docs/services/PROSPECTOR.md:2906`
- `docs/services/HAULER.md:261-263`
- `docs/modules/CATALOG-LENSES.md:81-83`
- `docs/modules/CATALOG-LENSES.md:162-164`
- `docs/tooling/COLD-CATALOG.md:147-152`
- `docs/services/STOCKER.md:8-15`
- `docs/services/STOCKER.md:626-627`
- `services/stocker/README.md:7-10`

**Problem**

These passages break "Only what is true today":
- **History:** "used to…" and "no longer" in PROSPECTOR.md, HAULER.md's "Reporting them as failures had prospector asking…", and CATALOG-LENSES' "was rejected" and "what this replaced".
- **Plans:**
  - COLD-CATALOG.md's "Not built" section;
  - PROSPECTOR's migration-policy "until a second developer… from then on frozen";
  - STOCKER's "only archives is under development today… further sources may join";
  - STOCKER's "a stopgap until instrument metadata says it".

**Evidence**

`grep -nE 'used to|no longer|not yet|stopgap|Not built' docs` lists these lines. The verifier corrected two line numbers: the migration policy is at :2228-2231, and COLD-CATALOG's "Not built" is at :147.

**Fix**

- **PROSPECTOR.md "used to" passages:** restate each as the present rule plus its reason, without "used to", "no longer" or "the old rules":
  - :639 becomes "Descent does not stop at a wide prefix: …";
  - :2521 becomes "`last` does not bound generation, because…";
  - do the same at :2645, :2906 and :1860-1862 ("Probing is not paced separately: a probe and a listing are the same thing to a host…").
- **HAULER.md:261-263:** "They are not failures: the file is fine, only the way to it is not, and reporting them would have prospector re-ask the venue about files it serves."
- **CATALOG-LENSES.md:**
  - :81-83 becomes "A rule names only what it constrains, not `markets: 'all'`, because…";
  - :162-164 becomes "Sizing is exact rather than sampled because trade volume is too uneven: six series of two thousand put bybit 2021–2025 perpetual trades at 4.4 TB where they are 1.9."
- **COLD-CATALOG.md:147-152:** move the "Not built" section to docs/planning/COLD.md.
- **PROSPECTOR.md:2230-2231:** keep "a change edits the migration it belongs to", and move the "until a second developer… frozen" clause to docs/planning/CATALOG.md.
- **STOCKER.md:8-15 and the stocker README:7-10:** remove "only archives is under development today" and "Further sources may join". Keep "REST and WS files are raw too… more formats to it".
- **STOCKER.md:627:** drop "— a stopgap until instrument metadata says it". planning/STOCKER.md already holds that plan.
- **legacy README:16:** may stay; optionally rephrase it as "A file is here only while what it knows has not been rebuilt."

**Tests and checks**

`grep -rnE 'used to|no longer|stopgap|Not built|under development today' docs services/*/README.md` returns only deliberate uses, for example in docs/planning.

**Verifier notes**

Confirmed. The migration-policy clause is the weakest case, but its "from then on" half is a plan. The legacy README's line is acceptable as a statement of the folder's rule.

## DXC-22: Provider docs explain themselves by their consumers (catalog-ui README, infra README, rabbitmq/pipe examples)

- **Severity:** low
- **Category:** docs-dependency-direction
- **Decision:** IMPLEMENT
- **Source finding:** F8

**Locations**

- `docs/modules/CATALOG-LENSES.md:8-9`
- `services/catalog-ui/README.md:25-26`
- `modules/infra/README.md:62-88`
- `services/pipe/README.md:95-98`
- `services/rabbitmq/README.md:36-41`
- `docs/modules/CATALOG-API.md:189-190`

**Problem**

Several provider docs justify what they offer by who uses it:
- **CATALOG-LENSES.md:8-9** lists hauler, stocker and cold as the reasons lenses exist (fixed by DXC-05).
- **The catalog-ui README** says "such as the one hauler downloads".
- **The infra README** describes each pack by modules that do not exist.
- **The rabbitmq README** quotes a fabricated hoarder snippet.
- **The pipe README** makes a nonexistent `journalist` service read as real.

**Evidence**

modules/infra/README.md:62: "Runs history modules (archivist, collector, archeologist, packer)". `ls modules` gives collect, infra and store. hoarder/docker/compose.yml:19 has `QUEUE_URL: ${QUEUE_URL}`.

**Fix**

- **CATALOG-LENSES.md:8-9:** apply DXC-05's rewrite.
- **The catalog-ui README:25-26:** "lenses — named selections of the catalog (sets of whole partitions), each edited as rules per venue…". Drop "such as the one hauler downloads".
- **modules/infra/README.md:** describe each pack only by the brokers and cache it defines (DXC-13).
- **services/rabbitmq/README.md:36-41:** quote the real `QUEUE_URL: ${QUEUE_URL}` (DXC-13).
- **services/pipe/README.md:95-98:** use neutral names (`topic:broadcast > sink@topic:sink`, "a consumer can then read queue `sink`").
- **Optional:** CATALOG-API.md:189 "This is what a downloader walks" becomes "A client walks the listing and writes each object at its key". This one is cosmetic.
- **Do not change VAULT.md's BitMEX framing** (see Rejected).

**Tests and checks**

`grep -rn 'archivist\|journalist\|hauler downloads' docs services/*/README.md modules` returns nothing.

**Verifier notes**

Confirmed in part. The verifier refuted the VAULT.md sub-item: services/vault really is BitMEX-specific in code. It rated CATALOG-API:189 as weak. The infra and rabbitmq parts overlap with DXC-13, so do them there.

## DXC-23: Vault service README misses VAULT_COMPRESSION_LEVEL; no service README says what deploys it

- **Severity:** low
- **Category:** docs-accuracy
- **Decision:** IMPLEMENT
- **Source finding:** F26

**Locations**

- `services/vault/README.md:26`
- `docs/services/VAULT.md`
- `README.md:52`
- `.env.example:28-31`

**Problem**

The vault service README says "No environment variables", but config.ts reads VAULT_COMPRESSION_LEVEL. VAULT.md does not mention it either.

No module includes vault, hoarder, router or pipe, yet they are documented as if they run. Readers cannot tell which services are deployed.

**Evidence**

services/vault/src/config.ts:6 calls parseCompressionLevel(VAULT_COMPRESSION_LEVEL), with default 6 and range 1-9. The compose `path:` includes cover only prospector, catalog, catalog-ui, hauler, stocker and redis.

**Fix**

- **services/vault/README.md Configuration:** list `VAULT_COMPRESSION_LEVEL`: gzip level, integer 1-9, default 6; startup fails outside that range. Keep the note that the data directory is fixed at /data/vault.
- **docs/services/VAULT.md:** add the same variable where it describes flushing and compression.
- **Each services/*/README.md:** add one "Deployed by" line, such as "archives module", "warehouse module", "infra market pack", or "Not deployed by any module" for vault, router, pipe, hoarder and the UI stub.

**Tests and checks**

Every `process.env.X` read in services/vault/src appears in the README. `grep -L 'Deployed by' services/*/README.md` returns nothing.

**Verifier notes**

Confirmed. There is no runtime clash on /data/vault (the containers are separate), only a naming confusion, which DXC-10 covers.

**Owner question**

Should vault, router, pipe and hoarder move to services/.deprecated/? The doc fixes stand either way.

## DXC-24: Hauler README says a refusal pauses the whole venue; only the refusing address is taken out

- **Severity:** low
- **Category:** docs-accuracy
- **Decision:** IMPLEMENT
- **Source finding:** F27

**Locations**

- `services/hauler/README.md:38`
- `docs/services/HAULER.md:225-229`

**Problem**

The README says "A refusal also pauses every fetch from that venue for a while." In fact only the refusing address goes out of rotation, which is what HAULER.md says.

**Evidence**

services/hauler/src/hosts.ts:91-113 sets `outUntil` on one Host. :52 filters out only hosts whose `outUntil > now`. There is no venue-wide pause.

**Fix**

Replace README.md:38 with: "A refusal — a `429`, any answer saying how long to wait, or five `403`s running with nothing delivered between — takes that address out of rotation for a while (see HAULER.md); a server with only one address waits."

**Tests and checks**

Doc review against hosts.ts.

**Verifier notes**

Confirmed.

## DXC-25: Archives .env.example claims a CATALOG_DIR default that does not exist and omits bitget from venues

- **Severity:** low
- **Category:** docs-accuracy
- **Decision:** IMPLEMENT
- **Source finding:** F30

**Locations**

- `modules/collect/archives/.env.example:9-16`
- `modules/collect/archives/.env.example:41-42`

**Problem**

The comment says CATALOG_DIR "Defaults under the shared data root". Both compose files require it with `:?`, and the root .env.example has no CATALOG_DIR. The PROSPECTOR_VENUES comment omits bitget.

**Evidence**

services/prospector/docker/compose.yml:61 and services/catalog/docker/compose.yml:39 use `${CATALOG_DIR:?…}`. prospector/src/venues.ts builds VENUE_NAMES from ADAPTERS, which include bitget.

**Fix**

- **Line 9:** replace with "Required: compose refuses to start without it. Any absolute host path works, e.g. /storage/tradebot/catalog; the container path is fixed and private." Do not add a default to the root .env.example, which would change behaviour.
- **Line 42:** replace with "CSV of venue names (binance, bitget, bybit, gate, htx, kucoin, okx); unknown names fail at startup with the valid list."

**Tests and checks**

Doc review. The venue list matches VENUE_NAMES.

**Verifier notes**

Confirmed.

## DXC-26: CATALOG-API examples contradict its own variant rules

- **Severity:** low
- **Category:** docs-accuracy
- **Decision:** IMPLEMENT
- **Source finding:** F21

**Locations**

- `docs/modules/CATALOG-API.md:36`
- `docs/modules/CATALOG-API.md:144-147`
- `docs/modules/CATALOG-API.md:209`

**Problem**

The books variant example uses `mode`/depth, but the defined order is `kind`, then `depth`. The gate key example has no variant, though gate's books carry `incremental,full`.

**Evidence**

services/catalog/src/vocabulary.ts:65 `books: ['kind', 'depth']`. prospector/src/adapters/gate.ts:161 `variant: 'incremental,full'`.

**Fix**

1. **:144-147:** change the variants to `{ "kind": "incremental", "depth": "500" }` and `{ "kind": "incremental", "depth": "200" }`.
2. **:209:** use a key gate actually produces: `gate/spot/books,incremental,full/B/BTC_USDT/202107/gate|spot|books,incremental,full|BTC_USDT|20210726.part03.csv.gz`.
3. **Other names:** grep the doc for any other `mode` level name.

**Tests and checks**

Optional: align the catalog test fixtures (keys.test.ts:37, listings.test.ts:65-66, 308) to the variant-carrying form. That is a test change, outside the docs pass.

**Verifier notes**

Confirmed. The variant-less key is also a test fixture, which is why it parses.

## DXC-27: CATALOG.md says nothing is shared in code with prospector, then names a shared package

- **Severity:** low
- **Category:** docs-contradiction
- **Decision:** IMPLEMENT
- **Source finding:** F22

**Locations**

- `docs/services/CATALOG.md:46-49`
- `docs/services/CATALOG.md:136-141`

**Problem**

Line 46 says "Nothing is shared in code with prospector." Lines 136-141 say both services import `@tradebot/lenses`.

**Evidence**

`grep -rln @tradebot/lenses services/*/src` matches files in both catalog and prospector.

**Fix**

Replace the bold sentence at :46 with: "**Nothing of the catalog's queries is shared in code with prospector.** What a lens is comes from `@tradebot/lenses`, which both import (see below). The queries are this service's own…" Keep the rest of the paragraph.

**Tests and checks**

Doc review.

**Verifier notes**

Confirmed.

## DXC-28: Binance's 2025-01 ms→µs timestamp change is documented only in stocker's docs

- **Severity:** low
- **Category:** docs-dependency-direction
- **Decision:** IMPLEMENT
- **Source finding:** F31

**Locations**

- `docs/venues/BINANCE.md`
- `docs/services/STOCKER.md:639-645`
- `docs/services/STOCKER-PARTITIONS.md:34`
- `docs/services/STOCKER-PARTITIONS.md:180`

**Problem**

Binance spot trades and klines switch from millisecond to microsecond timestamps in 2025-01. That is a venue fact, but only stocker's docs record it, and BINANCE.md does not mention it.

**Evidence**

`grep -niE 'µs|micro' docs/venues/BINANCE.md` returns nothing. STOCKER-PARTITIONS.md:180: "ms through 2024-12, µs from 2025-01". stocker/src/schema/tables.ts:76 calls it a venue fact.

**Fix**

- Add "### Spot timestamps change unit in 2025-01" under BINANCE.md "## Archives". State that spot trades and klines carry integer epoch milliseconds through the 2024-12 files and microseconds from 2025-01, with no change of filename or header. Name no service.
- Include aggTrades only after checking a file.
- In STOCKER.md and STOCKER-PARTITIONS.md, keep only the handling (unit inferred per value) and link to the new BINANCE.md anchor.

**Tests and checks**

The new anchor resolves from the STOCKER docs.

**Verifier notes**

Confirmed.

## DXC-29: Kraken has a WS adapter but no venue doc; the WebSocket pointer claims every venue doc has a WS section

- **Severity:** low
- **Category:** docs-coverage
- **Decision:** IMPLEMENT
- **Source finding:** F32

**Locations**

- `services/hoarder/README.md:24-37`
- `docs/DATA_PIPELINE.md:47`
- `README.md:56`

**Problem**

Hoarder implements a kraken WS adapter and states Kraken venue facts in its own README, but there is no docs/venues/KRAKEN.md. DATA_PIPELINE.md:47 points to "each venue doc's WebSocket section", but only BINANCE, BYBIT and OKX have one.

**Evidence**

services/hoarder/src/venues/kraken.ts exists. `grep '^## ' docs/venues/*.md` shows WebSocket sections only at BINANCE.md:566, BYBIT.md:497 and OKX.md:1119.

**Fix**

- Create docs/venues/KRAKEN.md with only a "## WebSocket" section, written from the captured frames in services/hoarder/tests/venues-protocols.test.ts and the adapter. Cover:
  - the v2 public endpoint;
  - the subscribe/ack frame shape;
  - rejection of unknown channels;
  - the `BTC/USD` symbol syntax.
  Describe the venue, never hoarder. Add a one-line scope note that only the WebSocket API has been examined, and make no claim about archives.
- Change the pointer, in ARCHITECTURE.md if DXC-02 has landed and otherwise in DATA_PIPELINE.md:47, to "the WebSocket section of each venue doc that has one (BINANCE, BYBIT, OKX, KRAKEN)".
- Have the hoarder README point to KRAKEN.md instead of stating the venue facts.

**Tests and checks**

A link check passes. KRAKEN.md names no service of this repo.

**Verifier notes**

Confirmed. The reviewer's claim that kraken "has no archive" was rejected as an unverified venue claim (see Rejected).

## DXC-30: Cold legacy README contradicts COLD-AUDIT.md on what the rebuilt audit checks

- **Severity:** low
- **Category:** docs-contradiction
- **Decision:** IMPLEMENT
- **Source finding:** F25

**Locations**

- `dev/tooling/src/tools/cold/legacy/README.md:11`
- `docs/tooling/COLD-AUDIT.md:74-101`
- `docs/tooling/COLD-AUDIT.md:114-115`

**Problem**

The legacy README says the rebuilt audit does not yet check staging tars or a tar's contents against the record. COLD-AUDIT.md and the code show both checks exist. The legacy evict/reclaim.ts row ("nothing does now") may also be stale.

**Evidence**

audit/checks/ holds staging.ts and tars.ts. COLD-AUDIT.md:74-88 says staging is the one place a tar is opened and checked against the record.

**Fix**

- **Legacy README:11:** "`cold audit` as it was. What it looked for that the rebuilt one does not: months with a gap between them, and its one-page report."
- **COLD-AUDIT.md:114:** also name the one-page report as not rebuilt, so both docs list the same gap. Confirm first that no report code exists.
- **reclaim.ts row:** compare legacy/evict/reclaim.ts with audit/checks/staging.ts. If staging.ts covers it, delete reclaim.ts per the folder's own rule. Otherwise, say exactly what reclaim did that staging.ts does not.

**Tests and checks**

Doc review against audit/checks/*.ts.

**Verifier notes**

Confirmed (reviewer confidence: medium). The reclaim.ts row was flagged by the verifier and has not been verified.

## DXC-31: Archives module README points to docs/services for variables that live in service READMEs

- **Severity:** low
- **Category:** docs-accuracy
- **Decision:** IMPLEMENT
- **Source finding:** F28 (part)

**Locations**

- `modules/collect/archives/README.md:48-49`

**Problem**

The archives module README sends readers to each service's doc under docs/services/ for its variables. Those variables are in services/<name>/README.md; docs/services/CATALOG.md has no CATALOG_* variables.

**Evidence**

services/catalog/README.md lists the CATALOG_* variables. docs/services/CATALOG.md does not.

**Fix**

Change "each service's doc under `docs/services/` for its variables" to "each service's README (`services/<name>/README.md`) for its variables".

**Tests and checks**

Doc review.

**Verifier notes**

This is the bounded half of F28. The file moves are deferred as DXC-32.

## DXC-32: docs/modules/ holds non-module docs (CATALOG-API, CATALOG-LENSES); warehouse module has no doc

- **Severity:** low
- **Category:** docs-structure
- **Decision:** DEFER
- **Source finding:** F28 (part)

**Locations**

- `README.md:53`
- `docs/modules/CATALOG-API.md`
- `docs/modules/CATALOG-LENSES.md`
- `modules/store/warehouse/README.md`

**Problem**

README.md:53 defines docs/modules/ as how services are wired into a deployable pipeline. Two of its three files do not fit:
- CATALOG-API.md is the catalog service's API.
- CATALOG-LENSES.md documents the `@tradebot/lenses` package, which has no README of its own.
The warehouse module has no docs/modules doc.

**Evidence**

`ls docs/modules` gives ARCHIVES.md, CATALOG-API.md and CATALOG-LENSES.md. shared/lenses has no README. `grep -rn 'CATALOG-API\|CATALOG-LENSES' --include=*.md` finds 19 inbound links.

**Fix**

Once the owner picks a home for shared-package docs:
- Move docs/modules/CATALOG-API.md to docs/services/CATALOG-API.md.
- Move CATALOG-LENSES.md to that home, as the one article on lenses.
- Update all 19 links.
- Either add docs/modules/WAREHOUSE.md, or reword the README.md:53 row.
Do the moves after DXC-01, DXC-05, DXC-16 and DXC-22 have edited CATALOG-LENSES.md, so those edits land on one file.

**Tests and checks**

A link check passes after the moves.

**Verifier notes**

Confirmed. The moves are deferred because they touch about 19 links and involve a structural choice.

**Owner question**

Where should docs for shared packages live: a new docs/shared/ (e.g. docs/shared/LENSES.md), or alongside the code as shared/lenses/README.md? And should the warehouse module get its own docs/modules/WAREHOUSE.md?

## Deferred: decisions needed

- **DXC-17** (REST knowledge has three deep homes (docs/REST.md, docs/planning/REST.md, each venue doc)): Where should the cross-venue REST comparison live: docs/venues/REST.md, or docs/REST.md kept but made venue-agnostic? And should planning/REST.md survive as a short REST-collector plan, or be deleted? The merge also needs fact-by-fact care across about 950 lines, so it should be its own pass.
- **DXC-32** (docs/modules/ holds non-module docs (CATALOG-API, CATALOG-LENSES); warehouse module has no doc): Where should docs for shared packages live: a new docs/shared/ (e.g. docs/shared/LENSES.md), or alongside the code as shared/lenses/README.md? And should the warehouse module get its own docs/modules/WAREHOUSE.md?

Other owner questions attached to IMPLEMENT items (the doc fixes go ahead either way):

- **DXC-06:** Have `cold push`, the vault commands, `pull archives` and `audit` run against real Mega yet? The answer decides which "first real run" items stay. This is a sub-question; the decision on the item is still IMPLEMENT.
- **DXC-07:** Is the first haul through backfill-20 finished, and are Hauler items 2-3 still pending? This is a sub-question; the decision on the item is still IMPLEMENT for the clearly stale lines.
- **DXC-11:** dev/tooling/.env overrides an explicit `-e` file. Is that intended? The docs should describe the code as it is; if it is not intended, changing it is a separate code change.
- **DXC-13:** Should the market pack name its cache `cache`, extending services/redis the way local does, so that CACHE_URL works on every pack? If not, the infra README documents the difference between packs.
- **DXC-15:** Should services/_stub/ui stay where it is or move to services/.deprecated/? The doc fixes are the same either way.
- **DXC-23:** Should vault, router, pipe and hoarder move to services/.deprecated/? The doc fixes stand either way.

## Rejected

- **F29: Move docs/planning/mental-model.html to planning/archived/:** The verifier was uncertain, which counts as half a refutation against zero confirmations, so the finding does not survive. Git history (commit 65b05db) shows the owner reviewed this file in the same commit that archived PLAN/BOT/MILESTONES, and chose to leave it in live planning. Its actor model also differs from the archived design. It may be the current bot design. Owner question: is mental-model.html the current bot design? If yes, link it from ROADMAP's dormant bot-app entry. If no, `git mv` it to archived/.
- **F8 sub-item: Strip BitMEX framing from docs/services/VAULT.md:** Refuted by the verifier. services/vault really is BitMEX-specific in code (data/headers.ts holds BitMEX table column lists), so a venue-neutral description would be wrong. Whether to keep the service is the retirement decision under DXC-23.
- **F9 sub-item: Rename the catalog-ui 'Buckets' label and the `buckets` JSON field:** This is a code/API change, not documentation, and is out of scope for this docs pass. The docs explain what the field means instead. The UI already labels the bundle as 'Market Bundles'.
- **F32 sub-item: State that kraken has no archive:** This is an unverified venue claim, which Kraken's published trade-history downloads may contradict. KRAKEN.md states only that its WebSocket API was examined.
