# Tools kept for what they know

What is here is not built, not tested and not a command. It was written for BitMEX, which is
gone, and is kept because the next thing of its kind will want to read it first.

| | what it was | kept for |
|---|---|---|
| `data/` | `tools data`: looking after the raw BitMEX files the vault service wrote — merging the pieces of a day into one sorted bucket, removing duplicates, re-sorting, re-bucketing by event time, salvaging broken gzips, and saying what is where | the same care will be owed to whatever REST and websocket collection writes. `docs/` is its documentation as it was, `tests/` its tests |

**It does not run as it is.** `data` read the vault service's column lists from its build
(`services/vault/dist/src/data/headers`). `command.ts` is how it was registered with `tools`.
