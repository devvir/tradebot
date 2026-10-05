# cold

`tools cold` owns cold storage: packing what is finished into tars, uploading them to Mega, and
keeping the record of what went where.

**Cold storage is a DX concern, not a service's job.** Nothing running in a container reads or
writes any of it, so it lives in the tooling and holds its own state.

**It stores partitions.** A partition is one month of one slice of a venue's data, and it is stored,
restored and replaced whole. Which partitions exist, which are finished and what each holds is the
catalog's to say; `cold` asks it, and keeps its own record of which tar each partition went into
and at which version.

---

## Subcommands

| | |
|---|---|
| [`cold push`](COLD-PUSH.md) | Pack what is ready and not backed up yet, and upload it |
| `cold stats` | What the record holds, venue by venue |
| [`cold evict`](COLD-EVICT.md) | Reclaim local disk once cold storage provably holds what is deleted — **not running**, see its page |
| [`cold audit`](COLD-AUDIT.md) | Check cold storage against the record — **not running**, see its page |

`push` and `stats` take an **origin** and prompt for one when it is omitted.

---

## Origins

An origin is a tree to back up, **named for the tree rather than for whatever writes it**.

| origin | tree | in Mega |
|---|---|---|
| `archives` | the venues' archive files, as published | `<MEGA_ROOT>/sources/archives` |

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
| the record | `<cold>/cold.sqlite` — every tar, and the partitions each holds |
| local tars | `<cold>/<origin>/<venue>/<venue>-<YYYYMM>.<NNN>.tar` — staging only, deleted once stored |
| lock | `<cold>/cold.<origin>.<command>.lock` — one run of a command per origin |
| remote | `<MEGA_ROOT>/sources/archives/<venue>/<YYYY>/<venue>-<YYYYMM>.<NNN>.tar` |

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
Mega confirms it, and nothing else.

**And it does not decide what is worth keeping.** What is stored is what the catalog says is
finished — through a lens, where one is asked for.

Related: [COLD-PUSH.md](COLD-PUSH.md), and [DATA-SYNC.md](DATA-SYNC.md) for the Mega steps that have
not moved here yet.
