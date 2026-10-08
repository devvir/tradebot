# cold, before partitions

What is left of the cold commands as they were before they moved onto partitions. **Kept, not
running**: it reads a per-file record and a facts store that no longer exist, so this folder is left
out of the build and its tests (`tests/tools/cold/legacy/`) out of the test run.

It is here for what it knows, and for nothing else:

| | |
|---|---|
| `audit.ts` | `cold audit`, the one command not rebuilt — [docs/tooling/COLD-AUDIT.md](../../../../../../docs/tooling/COLD-AUDIT.md). The ways it found the record and Mega can disagree: objects the record does not know, tars left in staging, months with a gap, a tar that does not weigh what the record says. |
| `evict/reclaim.ts` | taking back tars left in staging by a run that stopped, which nothing does now |
| `types.ts`, `config.ts` | the vocabulary the two above are written in |

The modules these import that are not here are gone with the record they read; the code is to be
read, not run. A file leaves this folder when what it knows has been rebuilt.
