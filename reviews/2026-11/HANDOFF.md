# Full review of November 2026: handoff

Start here to bring the owner up to speed on the full-repository review and the work that followed it. Everything that came out
of it is in this folder or in the code, so nothing outside the repository is needed.

## State

- Branch `claude/adoring-cannon-wz6r9j`. It is **not merged**. Its base is commit `ac10a6c` ("Catalog-UI: redesign, restyling").
- 270 or so commits, about 800 files changed: fixes with tests, a full docs rewrite and restructure, and the BitMEX path retired.
- Everything passes on the branch head: `pnpm -r build`, `pnpm typecheck` (source and test files), `npx knip`, `pnpm test`
  (about 4,550 tests), and every CI run since #44. Runs #1 to #43 failed only while the work was in progress; CI itself was added
  by this branch.
- Two tests depend on the environment: stocker's xlsx test needs the network to fetch a DuckDB extension, and pipe's integration
  tests need a Docker daemon. Both skip themselves when the dependency is missing.

## How it was done

1. **Review.** 23 units (14 code, 9 docs). Two independent reviewers looked at each code unit, and a skeptical verifier checked
   every finding, two verifiers for high and critical ones. 604 findings survived: 7 critical, 52 high. Each unit's report is in
   `units/<unit>.md` and `.json`, and `INDEX.md` ranks them all.
2. **Implementation.** The 534 findings approved to fix were fixed with tests, one commit per batch. **Every commit message names
   the item ids it addresses**, so `git log --grep PRW-01` finds the change for any item.
3. **Owner triage.** 69 items were held back for a decision. The owner answered four questions: retire the BitMEX path, everything
   runs only on the owner's machine, messaging is best effort but must not throw data away on transient faults, and data must not
   be touched (document data issues, do not fix them). `TRIAGE.md` records what each of the 69 became. `OWNER-QUESTIONS.md` is the
   list as it stood before the triage; it is superseded.
4. **Docs.** Every doc was rewritten against the code under CLAUDE.md's rules, then restructured. `DOCS-PLAN.md` is the plan that
   was followed, and `DOCS-FOLLOWUPS.md` holds what each group's checker reported.
5. **Validation.** After each round, fresh reviewers went over each unit's diff, a verifier tried to refute every finding, and
   fixers repaired what survived. Those commits start with `validate(`.

`REPORT.html` is a one-page summary of all of the above. Open it in a browser.

## Open for the owner

1. **Possible data issues.** These are in `docs/planning/BUGS.md` under "Known data issues (unconfirmed, owner to review)". There
   are seven, each with evidence and a way to check it. Nothing that changes catalogued, archived or stocked data was touched, on
   the owner's instruction.
2. **Fixes in the submodule repos** (`packages/service-kit`, `packages/rabbitmq`, `dx`), which this work could not push to. They
   are listed in `SUBMODULE-LEFTOVERS.md`. One example: the service-kit shutdown plugin should exit 1 on fatal errors.
3. **Smaller open questions** found during validation, left as they are:
   - CAT-V-01. A rename or delete that is resent after a connection reset can come back 404 even though prospector already
     applied it.
   - INFV-03. Pipe's integration tests run in no CI step.
   - INFV-05. The provider READMEs carry "Deployed by" lines, which sits awkwardly with CLAUDE.md's dependency rule.
   - STOC-V2. When upgrading, a month whose side completion an older build was killed in gets fully restocked. That is costly
     but loses nothing.
   - A rare lock race between two `tools cold` runs that start together. The hauler's in-memory record of mismatched files is
     never pruned.
   - MSG-R3. During a publisher outage the router keeps its deliveries unacked; fixing that needs `packages/rabbitmq`.
   - INF-V-02, -03 and -05. The prod image's install layer is still rebuilt on any source change, a few unused infra packs are
     kept, and the jump from RabbitMQ 3.12 to 4.x means an old broker volume cannot be opened. That last one does not matter
     while nothing runs.
4. **Skipped as not worth it yet**, listed in `TRIAGE.md` section H: unmeasured performance work, optimistic locking for lens
   edits, resumable large downloads, and refreshing hauler's venues without a restart.

## Where to look

| Question | Where |
|---|---|
| What was wrong with unit X, and why each fix was made | `units/<unit>.md` |
| Every finding, ranked | `INDEX.md` |
| What the owner decided, and what each deferred item became | `TRIAGE.md` |
| The change for a given item id | `git log --grep <ID>` on the branch |
| What remains for the owner | `docs/planning/BUGS.md`, `SUBMODULE-LEFTOVERS.md` and this file |
| How the docs were reorganised | `DOCS-PLAN.md`, `DOCS-FOLLOWUPS.md` |
