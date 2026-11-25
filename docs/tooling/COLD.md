# cold

`./tools cold` owns cold storage: uploading what is finished to Mega, taking off the local disk what
is safely there, bringing it back, and keeping the record of what went where.

**Cold storage runs from the host, and no service calls it**, so it lives in the tooling and holds
its own state. It reads the vault's ledger, and writes one file into the vault, `backedup.csv` (see
[COLD-VAULT.md](COLD-VAULT.md#backedupcsv)).

**It stores partitions.** A partition is one month of one slice of a venue's data. For the archives,
which partitions exist, which are finished and what each holds is the catalog's to say; `cold` asks
it, and records which tar each partition went into and at which version. For the vault, the vault's
own ledger says, and the files are stored as they are.

This page is what every cold command shares. Each tree has a page of its own, covering every command
on it:

| page | what it covers |
|---|---|
| [COLD-ARCHIVES.md](COLD-ARCHIVES.md) | `push`, `evict`, `pull` and `stats` of the archives: tars of whole partitions |
| [COLD-VAULT.md](COLD-VAULT.md) | `push`, `evict`, `pull` and `stats` of the vault, file by file, and `pull needed` |
| [COLD-CATALOG.md](COLD-CATALOG.md) | `push catalog` and `pull catalog`: a copy of the catalog's database |
| [COLD-AUDIT.md](COLD-AUDIT.md) | `audit`: Mega, the disk and the record set against each other |

---

## The command shape

```
./tools cold <command> [origin] [venues…] [options]
```

| command | origins | |
|---|---|---|
| `push` | `archives`, `vault`, `all`; `catalog` | upload what is ready and not stored yet |
| `evict` | `archives`, `vault`, `all` | remove from the local disk what is safely in cold storage |
| `pull` | `archives`, `vault`, `all`; `catalog`, `needed` | bring back part of a venue's data, the catalog's copy, or what the vault waits for |
| `audit` | `archives`, `vault`, `all` | check Mega, the disk and the record against each other |
| `stats` | `archives`, `vault`, `all` | what the record holds, venue by venue |

**The origin comes first, then the venues**: `cold push archives binance bybit`. One argument is
always read as the origin, so `cold push binance` is an unknown origin, not a guess at a tree. With
no origin, the command asks which tree, and `all` is the first answer. `audit` and `stats` take no
venues. `catalog` and `needed` take none either: what follows them is not read.

### Origins

`origin` names the tree a command acts on. Trees are named for what they hold, not for whatever
writes them; `stocker` is accepted for `vault`.

| origin | tree | in Mega |
|---|---|---|
| `archives` | the venues' archive files, as published | `<MEGA_ROOT>/sources/archives` |
| `vault` | the stocked partitions, as Parquet | `<MEGA_ROOT>/vault` |
| `all` | each of the above in turn | |

`sources/` holds the trees data arrives in. The vault, the normalised product, sits beside it.

**With more than one tree, each line says which it is about**, as `(archives)` or `(vault)`.

**`catalog` and `needed` are not trees.** They are named in the origin's place and nowhere else:
`all` and `--all-sources` never include them.

### Options given at the `cold` level

Written once, before the command or after it. Each command that has a use for one reads it; the
others ignore it.

| | read by | |
|---|---|---|
| `-w`, `--watch` | `push archives`, `push vault`, `evict archives`, `evict vault`, `pull needed` | keep running and look again every 30 minutes; see [Watching](#watching) |
| `-a`, `--all-sources` | `push`, `evict`, `pull`, `audit`, `stats` over the trees | every tree, without asking which. There is then no origin on the line, so every argument is a venue |
| `-y`, `--yes` | every command | answer every question a command asks with its own default |

**`--yes` gives each question the answer pressing return would give**: yes where a command asks
whether to do what it was run to do, no where doing it would change nothing or could lose something.
It does not answer for a lock another run is holding: that still stops the run. `--all-sources` and
`--yes` together are what a script or a crontab runs.

**Short options are lower case**, here and on every command.

**Each command's own options are on its tree's page**, with what each tree does with an option that
is not its own. Most are ignored where they mean nothing. `push` refuses outright the options only
the catalog's copy takes (`-n`, `--rebase`, `--keep-snapshot`, `--drop-snapshot`) on a tree, before
it asks or sends anything.

### What a pull is asked for

`pull archives` and `pull vault` are asked for the same way: **a venue, and a dataset or a partition
of it.** A venue alone is everything it ever published, and is refused, as is a pull with no venue.

| | |
|---|---|
| `<venues…>` | after the origin; at least one |
| `--dataset <dataset[,variant]>` | a dataset in every market: every variant of it, or the one named |
| `--partition <market[/dataset[,variant][/YYYY[MM]]]>` | a market, or as much of a partition of it as is given from the left |
| `--date <YYYY\|YYYYMM>` | only that year, or that month; refused where the partition already names one |
| `-n`, `--dry-run` | say how what is asked for stands, and bring nothing |

One of `--dataset` and `--partition` is required, and only one. A month may also be written
`YYYY-MM`.

```
./tools cold pull archives bybit --dataset trades --date 2021
./tools cold pull archives okx --partition perp/books,incremental,400/202309
./tools cold pull vault bybit --partition perp/klines,1m/2023
```

What each tree takes besides: [COLD-ARCHIVES.md](COLD-ARCHIVES.md#cold-pull-archives) and
[COLD-VAULT.md](COLD-VAULT.md#cold-pull-vault).

---

## Configuration

`cold` reads the tooling's environment, loaded in the order
[dev/tooling/README.md](../../dev/tooling/README.md#environment) gives: the root `.env`, the `-m`
module's, `dev/tooling/.env`, the `-e` file, then the shell. An empty value counts as unset.

| variable | default | |
|---|---|---|
| `DATA_DIR` | required | the data root every local default hangs off, set in the root `.env` |
| `MEGA_ROOT` | required | where this project's trees live in Mega |
| `SOURCES_COLD_DIR` | `<DATA_DIR>/@cold` | `<cold>`: cold's own directory, see [Where things live](#where-things-live) |
| `DATA_ARCHIVES_DIR` | `<DATA_DIR>/archives` | the archives tree |
| `DATA_VAULT_DIR` | `<DATA_DIR>/vault` | the vault tree |
| `COLD_QUEUE_TARGET_GB` | `10` | GB: while Mega's upload queue holds more, `push` packs and hands over nothing more |
| `COLD_SETTLED_HOURS` | none | hours a settled partition must also have gone unchanged in the catalog before `push archives` stores it |
| `CATALOG_DIR` | the archives module's `CATALOG_DIR`, else `<DATA_DIR>/catalog` | the directory holding the catalog's database |
| `CATALOG_DB` | `<CATALOG_DIR>/catalog.db` | the catalog's database, which `push catalog` copies |
| `CATALOG_URL` | `http://localhost:<CATALOG_PORT>`, else `http://localhost:9010` | where the catalog's API answers from this host |
| `CATALOG_TOKEN` | the archives module's `CATALOG_TOKEN`, else none | sent to the catalog as `x-catalog-token` |

**The catalog's directory, port and token come from the module that deploys it.** Where the
environment leaves `CATALOG_DIR`, `CATALOG_URL` or `CATALOG_TOKEN` unset, `cold` reads `CATALOG_DIR`,
`CATALOG_PORT` and `CATALOG_TOKEN` from `modules/collect/archives/.env` directly, whether or not `-m`
names that module. `${NAME}` references in its `CATALOG_DIR` are expanded against the environment;
`CATALOG_PORT` and `CATALOG_TOKEN` are taken as written.

**`cold` runs on the host, so it needs the catalog on a known host port.** Where the archives module
does not set `CATALOG_PORT`, the catalog is asked at `http://localhost:9010`. Where it sets it empty,
the catalog is published on a port docker picks, and where it sets anything but a port, nothing says
where the catalog is: every question to the catalog then fails at once, with an error naming the
variable and the file. Set `CATALOG_PORT` in the archives module, or set `CATALOG_URL`.

`push`, `evict`, `pull` and `audit` ask the catalog's API; `push catalog` reads the database file.

---

## Where things live

| | |
|---|---|
| the record | `<cold>/cold.sqlite`; see [The record](#the-record) |
| local tars | `<cold>/archives/<venue>/<venue>-<YYYYMM>.<NNN>.tar`: staging only, deleted once stored |
| tars coming back | `<cold>/pulling/archives/…`, `<cold>/pulling/needed/…` for `pull needed`: each tar deleted once what is wanted is taken out of it |
| older versions pulled | `<cold>/pulled/archives/…`: partitions of a version the catalog has moved on from, for looking at |
| the catalog's copy | `<cold>/catalog/` while it is sent, and the snapshot kept there with `--keep-snapshot`; `<cold>/pulling/catalog/` while it comes back; `<cold>/pulled/catalog/catalog.db` unless `--output` says otherwise |
| copies of cold's own files | `<cold>/backup/`, with `sent.json`; see [below](#colds-own-files-are-kept-in-mega-too) |
| locks | `<cold>/cold.<origin>.<command>.lock`; see [Locks](#locks) |
| remote, archives | `<MEGA_ROOT>/sources/archives/<venue>/<YYYY>/<venue>-<YYYYMM>.<NNN>.tar` |
| remote, vault | `<MEGA_ROOT>/vault/<venue>/<market>/<dataset>[,<variant>…]/<@ or instrument>/<YYYYMM>[.pre\|.post].parquet` |
| remote, catalog | `<MEGA_ROOT>/@cold/catalog/`: `catalog.db`, `tables.db`, `partitions/<venue>/<YYYY>/…` |
| remote, cold's own files | `<MEGA_ROOT>/@cold/cold.sqlite`; `<MEGA_ROOT>/@cold/vault/ledger.csv` and `<MEGA_ROOT>/@cold/vault/backedup.csv` |

Vault files come back straight to their place in the vault.

**The record holds no roots.** A tar's path is stored relative to the tree's place in Mega and to its
staging directory, and the roots come from the environment on every use, so moving to another Mega
account or another disk is an `.env` edit.

### Locks

**One run of each command per origin at a time**, held by a file `<cold>/cold.<origin>.<command>.lock`,
with `catalog` and `needed` in the origin's place where they are asked for:

| | |
|---|---|
| `push` | `cold.archives.push.lock`, `cold.vault.push.lock`, `cold.catalog.push.lock` |
| `evict` | `cold.archives.evict.lock`, `cold.vault.evict.lock` |
| `pull` | `cold.archives.pull.lock`, `cold.vault.pull.lock`, `cold.catalog.pull.lock`, `cold.needed.pull.lock` |

Different commands do not lock each other out: a push and an evict of the same tree run side by side,
and an explicit pull runs beside `pull needed`. All of them write the record, and SQLite keeps those
writes apart.

**A lock whose holder is gone is cleared**: the file names the process and the boot it was taken in.
One still held is asked about, no unless told otherwise; with `--yes` the run stops.

**`audit` and `stats` take no lock**, and run beside any command. `audit` writes its fixes to the
record without one: a fix looks again at what it changes as it is applied, and leaves alone what has
moved since it was found.

---

## The record

`<cold>/cold.sqlite`, SQLite. For the archives it records partitions, not files: the catalog's
version of a partition stands for every file in it, so a tar is recorded as the partitions it holds,
the version of each, and Mega's handle for the stored object. For the vault it records files, since
the vault is stored as it is.

| table | one row per |
|---|---|
| `tar` | tar of the archives, planned, on its way or stored: venue, month, sequence number, its path below the tree's place in Mega and below its staging directory, size, state, Mega's handle |
| `held` | partition in a tar, at the version cold storage holds of it; the version the catalog has now where it is newer, and what the tar on disk holds until Mega confirms it |
| `eviction` | time a partition of the archives was taken off the local disk: the version stored, what was removed, and when it was brought back, if it was |
| `pulled` | partition of the archives a pull brought back into the archives and not taken off the disk since: the version brought, and when |
| `vault_file` | file of the vault in cold storage or on its way: partition, revision, instrument, side, path, size, state, Mega's handle, and since when it is away from the disk |
| `vault_partition` | vault partition every file of which is stored, at that revision |
| `vault_move` | time a vault file was taken off the disk or brought back |
| `catalog_copy` | piece of the catalog's copy: the base snapshot, and every partition of the catalog at the version the copy holds, with a file of its own once it has changed since the base; Mega's handle for what was sent |

**A tar's name says which venue-month it belongs to and nothing about what is inside.** Only the
record knows which partitions a tar holds. What each state of a tar means is in
[COLD-ARCHIVES.md](COLD-ARCHIVES.md#a-tars-way-into-cold-storage).

### Cold's own files are kept in Mega too

**The record is the only thing that knows what a tar holds, and the vault's ledgers the only thing
that knows what its files are.** Neither is versioned anywhere else, so each has a copy in Mega:
`<MEGA_ROOT>/@cold/cold.sqlite` for the record, `<MEGA_ROOT>/@cold/vault/ledger.csv` and
`backedup.csv` for the ledgers.

- **As a command starts**, the record is set against its copy. Nothing is said where they agree.
  Where they do not, a run before this one changed the record and did not get to send it: it is sent
  without asking where that run died and left its lock behind, and asked about otherwise, yes unless
  told otherwise.
- **Not while another command holds a lock.** That one is changing the record, and sends it itself.
  `audit` is the exception: where another command is running it sets the record against its copy
  anyway, unless `--dry-run`.
- **After each tree a command works on**, the record is sent if it changed, and after the vault the
  ledgers too. `push catalog`, `pull catalog` and `pull needed` count as one tree of the archives:
  the record is checked before them and sent after them, the ledgers are not. A command that keeps
  running under `--watch` also sends the record each time it has done everything it found, and
  `push vault` the ledgers with it.
- **Sent as a copy taken whole**, in `<cold>/backup`, since both are written while they are read.
  What was last sent, a digest and a size for each, is in `<cold>/backup/sent.json`, and a file goes
  again only when its digest has changed, or, as a command starts, when Mega no longer holds the
  record at the size sent.
- **Each is in Mega's queue once at most.** Sending one first cancels whatever of it is still
  queued, since that is an older state of the same file. Where the queue cannot be read, it is sent
  all the same.
- **A file that has shrunk is not passed on.** A ledger is only appended to, so any shrinking
  counts; the record dips a little in the ordinary way, so for it the sign is losing more than a
  tenth of what its copy weighs. As a command starts, a shrunk record is asked about, no unless told
  otherwise; as a command ends, a shrunk record or ledger is warned about and not sent.
- **Mega is given twenty seconds, as a command starts, to say what it holds.** Where it does not
  answer, the command goes by what was last sent.

---

## How Mega is trusted

**A file is in Mega when Mega lists it, and for no other reason**: not an exit code, and not having
left Mega's queue, which is as true of a file that was dropped. Mega lists a file only once it is
complete, and keeps the file's own modification time to the second. So a file listed at its path at
the size and the modification time of the one on disk is that file, and Mega's handle for it is
recorded with it. A listing gives its time without a zone, so two times a whole number of quarter
hours apart, up to fourteen hours, count as the same moment.

**Where a file replaces another at the same path**, as a vault file of a new revision or a new
snapshot of the catalog does, it is not taken as stored before this run has handed it over: what
Mega holds there beforehand may be the one it replaces.

**The queue is asked only whether a transfer is still on its way**, to know whether to hand a file
over again, and how much is waiting to upload. It is read whole, not filtered to one run's
transfers, since there is one link. A queue that could not be read is never taken for an empty one,
and is warned about once.

**A file can be handed over twice.** Mega is slow to show a transfer it has accepted, and for a moment
after one finishes the file is in neither the queue nor the listing. Sent twice, it is stored twice,
and the second replaces the first under another handle after the first was recorded. So `push`, on
the archives and the vault:

- **begins each round by taking second transfers of the same file out of the queue**, below its own
  tree's directory. The one being sent is kept, else the first asked for;
- **once it has sent everything it found, lists again what was stored since it last looked.** Another
  handle at the size sent is recorded. Another size, or nothing there, is recorded as not stored, and
  the run sends it again before it rests; a tar is packed again from disk, where the disk still has
  its partitions.

### A service that does not answer

**Mega and the catalog are both waited for, with or without `--watch`.** A run left going for days is
not ended by a service restarting.

- **The catalog**: a connection that fails, a `5xx`, or an answer not in full within two minutes is
  asked again after 5 seconds, then twice as long each time up to a minute, for as long as it takes.
  The wait is said once, with the address asked. Any other answer is the catalog's own. A look taken
  in the middle of other work, such as a push asking again while its tars upload, is given 15
  seconds and then skipped, and the work goes on. A catalog whose address is not known (see
  [Configuration](#configuration)) is not waited for.
- **Mega, when a command fails**: Mega is asked who is logged in, which changes nothing. Where it
  answers, the failure is the command's own: a path that is not there is an empty one, and anything
  else is a failure. Where it does not, the run waits, with the same widening wait, and sends the
  command again once Mega is back.
- **Mega, when a command gets no answer in the time it was given**: Mega works through one thing at
  a time, and something long holds everything behind it. The command is ended and is not sent again
  until Mega says who is logged in. A command whose effect came about meanwhile is not sent twice.

A few looks that are taken again shortly anyway, such as the twenty seconds given to the copies of
cold's own files, are not waited for: they fail as they are.

---

## Watching

**`-w` is read by `push archives`, `push vault`, `evict archives`, `evict vault` and `pull needed`.**
Each keeps running once its work is done, and looks again every 30 minutes. `evict --cleanup`
refuses to run with it. Every other command runs once, whatever is given.

**Watching several trees** (`all` or `--all-sources`), each tree is seen through before the next
begins, and the whole round comes again after 30 minutes. What a command asks, it asks in the first
round only.

**A command left watching keeps going through what goes wrong.** A command run with `-w` that fails
says why and is run again, after 5 seconds, then twice as long each time up to a minute. Every
command picks up where it was, so running one again repeats nothing, and what it asked the first
time is not asked again. What goes wrong in a command's first minute ends it, as it would without
`-w`: whoever ran it is still there, and a lock somebody holds or a wrong setting is theirs to put
right. After that, only being told to stop ends it.

---

## What it does not do

**`push` never deletes anything from the tree it backs up.** It removes its own staging tars once
Mega holds them. In Mega it removes two things: a file that an earlier revision of a vault partition
had and the revision replacing it has not, once that revision is stored; and, with
`push catalog --rebase`, the catalog's partition files sent since the snapshot before.

**It does not decide what is worth keeping.** What is stored is what the catalog says is finished,
through a lens where one is asked for, and what the vault's ledger says is stocked.

**Mega is `cold`'s alone.** Every Mega call that `./tools` or a service makes is in
`dev/tooling/src/tools/cold`.

---

## The code

`dev/tooling/src/tools/cold/`, registered on the command line by `dev/tooling/src/commands/cold.ts`.
Each subcommand's directory holds its `command.ts`, its place on the command line, and what it needs:

| | |
|---|---|
| `push/` | `archives/`, `vault/`, `catalog/`; `confirm.ts`, the second look at what was stored; `progress.ts` |
| `evict/` | `archives/`, `vault.ts`; `discard.ts`, removal to the trash or outright, which `audit` uses too |
| `pull/` | `archives/`, `vault/`, `catalog/`, `needed/`; `filter.ts`, what a pull is narrowed to |
| `audit/` | `checks/`, one module per check; `again.ts`, what a fix looks at again; `finding.ts` |
| `stats/` | `index.ts`, both trees |
| `shared/` | what two subcommands or more use: `record/`, `mega/`, `vault/` (ledger, layout, what the vault waits for), the catalog's API, the archives on disk, tars, the backup of cold's own files, the progress display |
| the directory itself | `config.ts`, `options.ts` (the options given at the `cold` level), `cli.ts` (how a line is read into trees and venues, and running a command over each), `lock.ts`, `cleanup.ts` (what is given back however the process ends), `order.ts` (sorting by key) |

Types sit in a `types.ts` at the level that uses them.

**Progress is drawn in one place and fed from others.** `shared/progress.ts` is the block at the foot
of the terminal, and what is logged instead where there is no terminal; it knows nothing of what it
shows. `shared/progress-mega.ts` feeds it from Mega's queues. A command that counts its own work hands
its numbers to the block directly.
