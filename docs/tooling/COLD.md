# cold

`tools cold` owns cold storage: packing what a producer has finished into tars, uploading them to Mega, and keeping the record of what went where.

**Cold storage is a DX concern, not a service's job.** Nothing running in a container reads or writes any of it, so it lives in the tooling and holds its own state — a producer writes its tree and stops there, and what happens to that tree afterwards is an operator's decision.

---

## Subcommands

| | |
|---|---|
| [`cold push`](COLD-PUSH.md) | Pack what is not backed up yet and upload it |
| [`cold evict`](COLD-EVICT.md) | Reclaim local disk once cold storage provably holds what is deleted |
| [`cold audit`](COLD-AUDIT.md) | Check cold storage against the record, and say where they differ |
| `cold stats` | What is in cold storage |
| `cold pull` | *(not built)* Fetch back a symbol, a dataset, a month |

`push` and `stats` take an **origin** and prompt for one when it is omitted. `audit` takes one
optionally and checks everything when it is left out — "is cold storage sound" is not a question
you ask per tree. `evict` prompts like the rest: its safety is the confirmation that lists what
would go and defaults to no, not an argument somebody learns to type without reading. It also
takes the vault's `--market`, `--dataset`, `--symbol` and `--period` filters, which are an error
on any other origin rather than a silently wider deletion than was asked for.

**The safe order is collect → normalise → back both up → evict.** Eviction comes last because it
is the one step that cannot be undone; with that order, a mistake anywhere earlier is recoverable
from Mega. `evict` also moves files to the host's trash rather than unlinking them, so a bug in
its own checks is a restore rather than a loss.

---

## Origins

An origin is a tree to back up, **named for the tree rather than for whatever writes it**. `archives` is not `trucker` because a service can be renamed or replaced and the tree's meaning does not change with it — nothing outside that service should have to be renamed alongside it.

| origin | tree | state |
|---|---|---|
| `vault` | stocker's normalised partitions | done — `stocker` accepted as an alias |
| `archives` | the raw venue trees, as the venues published them | done — `trucker` accepted as an alias |
| — | REST and websocket collector buckets | further off |

**Only planning differs.** An origin contributes a way to find what is not backed up yet and a way to divide it into tars; packing, verification, queueing, confirmation, reclaiming, pacing and the resume rules are the same operation whatever produced the files. So the seam is a `Planner` and two constants, and `origin` is a column rather than a fork in the code.

| | `vault` | `archives` |
|---|---|---|
| what is compared | every file, every run | every file, in months that are not settled |
| what gates a month | nothing | the collector's published tip |
| what stays whole in a tar | a `(market, symbol)` | nothing |
| part cap | 2 GB | 5 GB |

---

## Mega is `cold`'s alone

Every Mega call in the repo will end up behind this command. `data sync` still shells out to `mega-*` itself and keeps its own copy of that code until it migrates — at which point that copy is deleted.

**The duplication is resolved by deletion, not by hoisting.** Nothing Mega-shaped goes into `shared/`: cold storage is one concern with one owner, and a shared helper would invite a second caller that reasons about Mega without going through the index that records what is in it.

---

## Where things live

| | |
|---|---|
| `cold.sqlite` | `<cold>/cold.sqlite` — the record of every part and everything inside it |
| local tars | `<cold>/<origin>/<venue>/<yyyymm>.pNN.tar` — staging only, deleted once uploaded |
| lock | `<cold>/cold.<origin>.<command>.lock` — one run of a command per origin |
| remote | `<MEGA_ROOT>/sources/archives/…` and `<MEGA_ROOT>/vault/…` — the vault is not a source |

**The lock is keyed by origin and command, because neither alone is the thing at risk.** Two pushes over one origin would plan the same unpacked files twice and pack them into two sets of tars; two evicts would walk and prompt over the same tree. Neither collision crosses origins — each stages into its own directory, recovers only from that directory, and diffs only its own rows. A push and an evict *do* run together, because the files they touch are disjoint by construction; see [COLD-EVICT.md](COLD-EVICT.md). The upload queue is shared, and is meant to be: pacing reads it globally on purpose, so a second origin's transfers sit in front of ours exactly as an upload started by hand would. There is one link either way.

The database is shared, so it is opened with a busy timeout — WAL lets readers run alongside a writer, and the timeout is what stops two writers colliding over a commit that takes milliseconds.

Everything a run holds sits in **one directory** — the staging tars, the lock, and the index that says what is inside them — so the state is one place to look at, back up, or reason about.

`cold.sqlite` is the **only** thing that knows what a tar holds; a part's name says nothing about its contents. So losing it loses the map, and it belongs in the backup alongside the data it describes.

**The vault sits beside `sources/`, not inside it.** `sources/` holds the trees data arrives in; the vault is the normalised product derived from them. Where each origin lives in Mega is decided in code, not configured — `MEGA_ROOT` says where the project is, and the layout below it is one decision rather than one per deployment.

**Paths default under `DATA_DIR` and remain overridable.** `<cold>` is `SOURCES_COLD_DIR` if set and `<DATA_DIR>/@cold` otherwise, and each origin's tree works the same way. The default is what stops the data root from being a decision taken again in every path — moving it to another partition is one variable, not a search — while the override is still there for a host that needs one tree somewhere else.

Configuration is read from `dev/tooling/.env`; see [COLD-PUSH.md](COLD-PUSH.md) for the variables.

---

## What it deliberately does not do

**`push` never deletes anything a producer wrote.** It removes a tar once Mega confirms it, and nothing else. Reclaiming a producer's tree is [`cold evict`](COLD-EVICT.md)'s job and needs its own proof, so the command that writes to cold storage and the command that acts on that being true stay separate.

**Nothing is reclaimed automatically.** `evict` is always asked for, always names its origin, and always prompts. A backup command that quietly freed space would make the decision to delete a side effect of the decision to back up.

**Emptying the trash is not its business.** `evict` moves files there and stops; the trash holds other things too, and taking them is a file manager's job.

**And it does not decide what is worth keeping.** A month blocked because some of its raw reached no partition stays blocked — that is a question about what the collector fetches or what stocker models, and answering it by deleting the evidence is how the question stops being asked. Those land in [BUGS.md](../planning/BUGS.md) instead.

Related: [COLD-PUSH.md](COLD-PUSH.md), [COLD-EVICT.md](COLD-EVICT.md), [COLD-AUDIT.md](COLD-AUDIT.md), [DATA-SYNC.md](DATA-SYNC.md) for the archive steps that move here, and [STOCKER.md](../services/STOCKER.md) for the tree the `vault` origin backs up.
