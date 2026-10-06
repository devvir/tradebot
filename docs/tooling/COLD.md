# cold

`tools cold` owns cold storage: uploading what is finished to Mega, taking off the local disk what
is safely there, bringing it back, and keeping the record of what went where.

**Cold storage is a DX concern, not a service's job.** Nothing running in a container reads or
writes any of it, so it lives in the tooling and holds its own state.

**It stores partitions.** A partition is one month of one slice of a venue's data, and it is stored
and replaced whole. For the archives, which partitions exist, which are finished and what each holds
is the catalog's to say; `cold` asks it, and keeps its own record of which tar each partition went
into and at which version. For the vault it is the vault's own ledger that says, and the files are
stored as they are — see [COLD-VAULT.md](COLD-VAULT.md).

---

## Subcommands

| | |
|---|---|
| `cold push` | Upload what is ready and not backed up yet — [archives](COLD-PUSH.md), [vault](COLD-VAULT.md#cold-push-vault) |
| `cold evict` | Remove from local disk what is safely in cold storage — [archives](COLD-EVICT.md), [vault](COLD-VAULT.md#cold-evict-vault) |
| [`cold pull`](COLD-VAULT.md#cold-pull-vault) | Bring back what was evicted — the vault; the archives are not built |
| `cold stats` | What the record holds, venue by venue |
| [`cold audit`](COLD-AUDIT.md) | Check cold storage against the record — **not running**, see its page |

Each takes an **origin**: `archives`, `vault`, or `all` for every tree the command is built for, one
after the other. With none given it asks, and `all` is the first answer.

**With `all`, every line says which tree it is about** — `(archives)`, `(vault)` — and nothing else
tells them apart. A command that is not built for one of the trees says so on that tree's turn and
carries on with the rest: `pull` brings back the vault, and not yet the archives.

**Options given at the `cold` level are every command's.** They are written once, before the command
or after it, and each command that has a use for one reads it:

| | |
|---|---|
| `-W`, `--watch` | keep running once the work is done, and look again every 30 minutes — `push` and `evict` |
| `-A`, `--all-sources` | every tree, without asking which. With it there is no origin on the line, so every argument is a venue |
| `-Y`, `--yes` | answer yes to what a command asks before it acts |

`--all-sources` and `--yes` together are what a script or a crontab runs: nothing is asked.

**`--yes` answers what a command asks about its own work, and nothing else.** A lock another run is
holding still stops the run.

**Watching every tree, each is seen through before the next begins**, and the whole round comes
again after the wait. A command watching one tree looks again in the middle of its own work; over
several that would never hand over to the next. What a command asks, it asks in the first round only.

---

## Origins

An origin is a tree to back up, **named for the tree rather than for whatever writes it**.

| origin | tree | in Mega |
|---|---|---|
| `archives` | the venues' archive files, as published | `<MEGA_ROOT>/sources/archives` |
| `vault` | the stocked partitions, as Parquet | `<MEGA_ROOT>/vault` |

`sources/` holds the trees data arrives in, one folder per way of obtaining it. The vault — the
normalised product, whatever it was made from — sits beside `sources/`, not inside it.

---

## Mega is `cold`'s alone

Every Mega call in the repo will end up behind this command. `data sync` still shells out to
`mega-*` itself and keeps its own copy of that code until it migrates — at which point that copy is
deleted.

**The duplication is resolved by deletion, not by hoisting.** Nothing Mega-shaped goes into
`shared/`: cold storage is one concern with one owner, and a shared helper would invite a second
caller that reasons about Mega without going through the record of what is in it.

---

## Where things live

| | |
|---|---|
| the record | `<cold>/cold.sqlite` — every tar and the partitions each holds, and every vault file |
| local tars | `<cold>/<origin>/<venue>/<venue>-<YYYYMM>.<NNN>.tar` — staging only, deleted once stored |
| lock | `<cold>/cold.<origin>.<command>.lock` — one run of a command per origin |
| remote, archives | `<MEGA_ROOT>/sources/archives/<venue>/<YYYY>/<venue>-<YYYYMM>.<NNN>.tar` |
| remote, vault | `<MEGA_ROOT>/vault/<venue>/<market>/<dataset>[,<variant>…]/<@ or instrument>/<YYYYMM>[.pre|.post].parquet` |

**The record is the only thing that knows what a tar holds.** A tar's name says which venue-month
it belongs to and nothing about what is inside. So losing the record loses the map, and it belongs
in the backup beside the data it describes.

**It records partitions, not files.** The catalog's version of a partition stands for every file in
it, so a tar is recorded as the partitions it holds, the version of each, and Mega's own handle for
the stored object — which is what lets a later check prove the record and Mega still mean the same
object.

**The record holds no roots.** A tar's path is stored relative to the origin's place in Mega and to
its staging directory; the roots come from the environment on every use, so moving to another Mega
account or another disk is an `.env` edit.

Everything a run holds sits in **one directory**, `<cold>`: the staging tars, the lock and the
record. It is `SOURCES_COLD_DIR` if set and `<DATA_DIR>/@cold` otherwise.

Configuration is read from `dev/tooling/.env`; see [COLD-PUSH.md](COLD-PUSH.md) for the variables.

---

## What it deliberately does not do

**`push` never deletes anything from the tree it backs up.** It removes its own staging tar once
Mega confirms it, and nothing else. In Mega it removes one thing: a file a vault partition's
earlier revision had and the revision that replaces it has not, once that one is confirmed.

**And it does not decide what is worth keeping.** What is stored is what the catalog says is
finished — through a lens, where one is asked for.

Related: [COLD-PUSH.md](COLD-PUSH.md), [COLD-EVICT.md](COLD-EVICT.md), [COLD-VAULT.md](COLD-VAULT.md), and [DATA-SYNC.md](DATA-SYNC.md) for the Mega steps that have
not moved here yet.
