# cold, before partitions

The cold commands as they were before `cold push archives` moved onto partitions: `evict`,
`audit`, the vault origin, and the push they were built around. **Kept, not running.** They read a
per-file record (`db.ts`), the facts store (`ledger.ts`) and tree layouts that no longer exist, so
this folder is left out of the build and its tests (`tests/tools/cold/legacy/`) out of the test run.

`docs/` holds how they were described: the push they shared, and `evict` as it was designed.

It is here because of what it knows. The checks `evict` makes before it deletes anything, the ways
`audit` found the record and Mega can disagree, how a replaced tar is told from the one it
replaces — each was a decision taken for a reason, and each command is rebuilt on partitions from
this code and its docs rather than from nothing.

| | |
|---|---|
| `audit.ts` | `cold audit` — [docs/tooling/COLD-AUDIT.md](../../../../../../docs/tooling/COLD-AUDIT.md) |
| `evict/` | `cold evict` — [docs/tooling/COLD-EVICT.md](../../../../../../docs/tooling/COLD-EVICT.md) |
| `push.ts`, `plan.ts`, `planners/` | the push both origins shared, and how each planned its tars |
| `db.ts`, `types.ts`, `config.ts` | the per-file record and what went with it |
| `presence.ts`, `ledger.ts`, `scan.ts` | what the vault holds, what the facts store says, what is on disk |
| `stats.ts` | `cold stats` over the per-file record |
| `docs/` | `COLD.md` and `COLD-PUSH.md` as they described that push |

Files these import that are not here — `mega.ts`, `tar.ts`, `lock.ts`, `cleanup.ts`,
`progress.ts` — are the live ones, one folder up.

A command leaves this folder when it is rebuilt: its code, its tests and its row above go together.
