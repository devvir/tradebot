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
| [`cold pull`](COLD-PULL.md) | Bring back a venue's dataset, or a partition of it — [archives](COLD-PULL.md#the-archives), [vault](COLD-VAULT.md#cold-pull-vault) |
| [`cold push catalog`, `cold pull catalog`](COLD-CATALOG.md) | A copy of the catalog's database — the database itself, then what changed since — and the way back from it |
| `cold stats` | What the record holds, venue by venue |
| [`cold audit`](COLD-AUDIT.md) | Check Mega, the disk and the record against each other, and offer to put right what disagrees |

Each takes an **origin**: `archives`, `vault`, or `all` for every tree the command is built for, one
after the other. With none given it asks, and `all` is the first answer.

**With `all`, every line says which tree it is about** — `(archives)`, `(vault)` — and nothing else
tells them apart. A command that is not built for one of the trees says so on that tree's turn and
carries on with the rest.

**Options given at the `cold` level are every command's.** They are written once, before the command
or after it, and each command that has a use for one reads it:

| | |
|---|---|
| `-w`, `--watch` | keep running once the work is done, and look again every 30 minutes — `push` and `evict` |
| `-a`, `--all-sources` | every tree, without asking which. With it there is no origin on the line, so every argument is a venue |
| `-y`, `--yes` | answer what a command asks before it acts: each question's own default |

`--all-sources` and `--yes` together are what a script or a crontab runs: nothing is asked.

**`--yes` gives every question its own default** — what pressing return would answer. That is yes
wherever a command asks whether to do what it was run to do, and no where doing it would change
nothing: `pull`, about what is on disk exactly as stored. It answers what a command asks about its
own work and nothing else: a lock another run is holding still stops the run.

**Short options are lower case**, here and on every command.

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

## A command left watching keeps going

**`--watch` is for a run left alone for days.** Whatever goes wrong during one is very likely gone
a minute later, and a run that ended on it is days of nothing done. So:

- **A service that is not answering is waited for** — Mega and the catalog both: asked again after
  5 seconds, then twice as long each time up to a minute, for as long as it takes. This is so
  without `--watch` too. A look at the catalog taken in the middle of other work is the exception:
  that look is skipped, and the work goes on.
- **Anything else that goes wrong under `--watch` is said, and the command is run again**, after the
  same waits. Every command picks up where it was, so running one again repeats nothing. What it
  asked the first time is not asked again: each question takes its own answer.
- **Not as it starts.** What goes wrong in a command's first minute ends it, as it would without
  `--watch`: whoever ran it is still there for its questions and its summary, and a lock somebody
  holds or a setting that is wrong is theirs to put right.
- **After that, only being told to stop ends it.**


**A command sent to Mega that fails is one of two things: Mega said no, or Mega said nothing.** They
are told apart by asking it who is logged in, which changes nothing and is answered at once by a
Mega that is there.

- **It answers**: the failure is the command's own — a path that is not there, a refusal — and the
  run deals with it as such. A tree that is not there is an empty one; no other failure is.
- **It does not**: the run waits. It asks again after 5 seconds, then twice as long each time up to
  a minute, and sends the command again once Mega is back. Nothing moves on meanwhile, so a run left
  going rides out an outage of any length — and silence is never mistaken for Mega holding nothing.

---

## Where things live

| | |
|---|---|
| the record | `<cold>/cold.sqlite` — every tar and the partitions each holds, and every vault file |
| local tars | `<cold>/<origin>/<venue>/<venue>-<YYYYMM>.<NNN>.tar` — staging only, deleted once stored |
| lock | `<cold>/cold.<origin>.<command>.lock` — one run of a command per origin |
| tars coming back | `<cold>/pulling/<origin>/…` — a pull's download and what it takes out of it, deleted as each tar is done |
| older versions pulled | `<cold>/pulled/<origin>/…` — partitions of a version the catalog has moved on from, for looking at |
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

**What Mega brings back is readable by its owner only.** A file downloaded by `mega-get` lands with
mode `600`, whatever it had when it was sent — where a file written into the vault or the archives
in the ordinary way is `644`. Nothing here depends on it, since everything runs as one user; a reader
running as another would be refused the pulled files and not the rest.

### Cold's own files are kept in Mega too

**The record is the only thing that knows what a tar holds, and the vault's ledgers the only thing
that knows what its files are.** Neither is versioned anywhere, and losing either leaves terabytes
in Mega that nothing can name. So each has a copy there:

| | |
|---|---|
| `<MEGA_ROOT>/@cold/cold.sqlite` | the record |
| `<MEGA_ROOT>/@cold/vault/ledger.csv`, `backedup.csv` | the vault's ledgers |

- **As any command starts**, the record is set against its copy. Nothing is said where they agree.
  Where they do not, a run before this one changed the record and did not get to send it: it is
  sent without asking where that run died and left its lock behind, and asked about otherwise — yes
  unless told otherwise.
- **Not while another command is running.** That one is changing the record as this one starts, so
  the two differ as a matter of course; it sends the record itself as it goes and as it ends.
- **As any command ends**, the record is sent if it changed. A command that works on the vault sends
  the ledgers too. One that keeps running under `--watch` does both each time it has sent everything
  it found.
- **Sent as a copy taken whole**, in `<cold>/backup`, since both are written while they are read.
  What was last sent — a digest and a size for each — is noted in `<cold>/backup/sent.json`, and a
  file goes again only when its digest is no longer that one.
- **These files grow, and one that has shrunk is not a change to pass on**: something happened to
  it here, and the copy may be the only good one. A ledger is only ever appended to, so for it any
  shrinking counts. The record dips a little in the ordinary way — a plan redrawn, a replaced
  revision forgotten — so for it the sign is losing more than a tenth of what its copy weighs. Such
  a file is never sent by itself. As a command starts it is asked about, and the answer is no
  unless told otherwise.
- **Mega is given twenty seconds to say what it holds.** Where it does not answer, the command
  carries on by what was last sent.

### The code

`dev/tooling/src/tools/cold/`, a directory for each subcommand and one for what they share:

| | |
|---|---|
| `push/`, `evict/`, `pull/`, `audit/`, `stats/` | everything that is one subcommand's alone: `command.ts` is its place on the command line, and `archives` and `vault` are the two trees it works on |
| `shared/` | what two subcommands or more use: the record, Mega, the catalog, the archives on disk, the vault's ledger and layout, the progress display |
| the directory itself | what every command is run with: configuration, the options given at the `cold` level, the lock, and how a line is read into trees and venues |
| `legacy/` | what is left of the commands as they were before partitions, kept for what it knows |

Types sit in a `types.ts` at the level that uses them: a subcommand's own in its directory, shared
ones in `shared/`, and those the whole command is built on at the top.

---

## What it deliberately does not do

**`push` never deletes anything from the tree it backs up.** It removes its own staging tar once
Mega confirms it, and nothing else. In Mega it removes one thing: a file a vault partition's
earlier revision had and the revision that replaces it has not, once that one is confirmed.

**And it does not decide what is worth keeping.** What is stored is what the catalog says is
finished — through a lens, where one is asked for.

Related: [COLD-PUSH.md](COLD-PUSH.md), [COLD-EVICT.md](COLD-EVICT.md), [COLD-VAULT.md](COLD-VAULT.md), and [DATA-SYNC.md](DATA-SYNC.md) for the Mega steps that have
not moved here yet.
