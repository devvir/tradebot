# cold and the catalog

A copy of the catalog's database in cold storage, and the way back from it. What every cold command
shares — the command shape, configuration (`CATALOG_DIR`, `CATALOG_DB`), where things live, locks and
the record — is in [COLD.md](COLD.md).

**The catalog can be rebuilt from the venues, given days — and not at all where a venue has since
withdrawn what it published.** The copy is there so that losing the catalog costs a restore and not
a survey.

**The catalog is not a tree of data.** Both commands are asked for by name, `catalog` in the
origin's place; `all` and `--all-sources` never include them, and they take no venues. Each holds a
lock of its own, `cold.catalog.push.lock` and `cold.catalog.pull.lock`, and neither reads `-w`.

**Around either, the record is looked after as around any other command**
([COLD.md](COLD.md#colds-own-files-are-kept-in-mega-too)): set against its copy in Mega as the command
starts, and sent as it ends where it changed, so what `push catalog` writes into the record reaches
the record's copy with it.

---

## What the copy is

**The copy is incremental: a snapshot, and what has changed since.** The snapshot is the database
as it was at one moment, sent whole. Every push after it sends only the partitions whose files
changed, a file each, and the rest of the database, which is small. Pulling the copy puts the two
back together.

```
<MEGA_ROOT>/@cold/catalog/catalog.db
<MEGA_ROOT>/@cold/catalog/tables.db
<MEGA_ROOT>/@cold/catalog/partitions/<venue>/<YYYY>/<venue>|<market>|<dataset>[,<variant>]|<grain>|<bundle>|<YYYYMM>.csv.gz
```

- **`catalog.db` is the snapshot**: every table and every index, as they were when it was taken.
- **`tables.db` is everything but the file rows, as a database of its own**: every table, index and
  trigger declared as the catalog declares it, with the rows of every table but two — `file`, whose
  rows go a partition at a time, and `wip`, which is only ever work in progress. Those two are there
  empty. It is sent whole on every push.
- **A file for each partition that changed since the snapshot**: every file row of that partition,
  in the order of their path, as gzipped CSV under a header of its columns (`venue_id`, `path`,
  `date`, `size`, `etag`, `modified`, `series_id`, `existence`, `seen_at`). The partition is the
  file's name. Whether each file was downloaded is left out: the snapshot knows that of every file
  it has, and of one that came later it is a fact about a disk. `NULL` is written `\N`, unquoted, so
  that it is not taken for the empty text. The same rows always give the same bytes.

**A partition is one file however often it changes.** Each replaces the one sent before at the same
path, which Mega keeps as an earlier version. What grows over time is how many partitions have
changed since the snapshot, never how much is kept of any one.

**What ties a snapshot to what is sent after it is the `file` table.** Every other table comes back
from `tables.db`, with whatever schema the catalog had when that was written. The file rows come
back from the snapshot, with the partitions' rows put into them, so the `file` table has to be
declared as it was when the snapshot was taken. How it was declared then, the table and its
indexes, is kept in the record beside the snapshot's digest.

**A partition's version is what says it changed.** It moves when a file of the partition is added,
withdrawn or changed, so nothing is read to find out which partitions to send. A row edited without
its partition's version moving is not seen.

## The snapshot on disk

**Cold keeps its own copy of the snapshot while it works, in `<cold>/catalog/catalog.db`.** It
weighs what the catalog weighs, and nothing but `cold` reads it. Whether one is there is read off the
disk each time, and written down nowhere: it is anyone's to delete.

**The record tells it from any other file**: `catalog_copy` ([COLD.md](COLD.md#the-record)) holds
its SHA-256, what it weighs, and Mega's handle for the object once it is stored. A file there is the
snapshot where it has that weight and that digest, and Mega still lists that very object. Then a
pull brings nothing of the snapshot back, whatever is asked of it.

**Anything else found there is said, and the command asks whether to delete it**; yes is the
answer. A push tells by its weight alone; a pull, which reads it, by its digest.

What becomes of the snapshot depends on what the command does:

| | nothing said | `--keep-snapshot` | `--drop-snapshot` |
|---|---|---|---|
| a push that takes a snapshot | removed once Mega has it | kept | removed once Mega has it |
| a push that takes none | whatever is there is left | nothing, and a warning saying whether one is there | one that is there is removed |
| a pull | left as it was found: one that was there stays, one that had to be brought back does not | one is left, even where it had to be brought back | none is left |

A pull that leaves a snapshot hands over a copy of it; one that leaves none hands over the snapshot
itself, and nothing is copied.

## `cold push catalog`

| | |
|---|---|
| `--rebase` | take a new snapshot: send the whole database again, and remove from Mega the partitions' files sent since the last |
| `--keep-snapshot`, `--drop-snapshot` | see [above](#the-snapshot-on-disk) |
| `-n`, `--dry-run` | say what would be sent, and send nothing |
| `-l`, `--lens` | refused: the copy is always of the whole catalog |
| `-y` | see [COLD.md](COLD.md#options-given-at-the-cold-level) |

`-n`, `--rebase` and the snapshot options are this command's alone: `cold push archives` and
`cold push vault` refuse them.

It reads the database file at `CATALOG_DB`, never the catalog's API, and refuses to run where there
is no file there.

1. **The `prospector` and `catalog` containers have to be stopped.** What is read is read at one
   moment, and a database somebody has open cannot be made one file. Where either is running, the
   command says to stop them with `tb down archives` and waits until both are gone. Where Docker
   cannot say whether they are running, nothing is copied.
2. **The database is made one file.** A write-ahead log beside it is the sign of a connection that
   did not close, and `catalog.db` alone is then not all of the catalog. It is opened and closed,
   which folds the log in and removes it; three seconds later the log is looked for again, and one
   that is still there means something else has the database open: nothing is copied.
3. **Until a snapshot is stored, or with `--rebase`, a snapshot is taken**: `catalog.db` is copied
   into `<cold>/catalog/`, its digest taken as it is read, with the catalog's version of every
   partition as it then is.
4. **Every time, `tables.db` is written.** On a run that takes no snapshot, the `file` table is
   first held to how it was declared when the snapshot was taken. Where it is declared otherwise,
   what changed since cannot be put into that snapshot: the command says so and asks whether to
   take a new snapshot instead. No is the answer, and nothing is sent.
5. **On a run that takes no snapshot, each partition whose version in the catalog is not the one in
   the record**, or whose file Mega has not confirmed, is written to its file.
6. **What was read is held to one moment.** Once everything is read, the database must have the
   size and modification time it had before, with nothing in a write-ahead log, and `prospector`
   must not be running. Otherwise what was read is not a snapshot of anything, and nothing is sent.
7. **The catalog is free, and the command says so**: everything that is sent has been read out of
   it. Prospector and the catalog can be started, long before Mega has it all.
8. **What was written is sent.** A snapshot is read back first and held to the digest taken in step
   3, then sent, which takes as long as it weighs. Once Mega lists it, its handle and the partitions'
   versions are written into the record; with `--rebase`, the partitions' files sent since the
   snapshot before are then removed from Mega. Every other file leaves `<cold>/catalog/` as Mega
   confirms it. What confirms a file is in [COLD.md](COLD.md#how-mega-is-trusted).

**Before anything is copied or written**, the run says what it will send — a snapshot, or how many
partitions changed — and asks to go ahead; yes is the answer. A dry run waits for the containers
like any other, folds nothing in, says what would be sent and stops there.

A run that stops while the snapshot is being sent is taken up by the next, which sends the same copy
and reads nothing of the catalog again.

**`--rebase` is needed when the `file` table is declared otherwise than the snapshot has it**, and at
no other time: the copy is whole without it. It is worth doing now and then all the same, since it
leaves a copy with nothing to put into its snapshot.

## `cold pull catalog`

| | |
|---|---|
| `-o`, `--output <path>` | where the database is left: a directory, or the file itself. `catalog.db` in that directory unless a file is named |
| `--keep-snapshot`, `--drop-snapshot` | see [above](#the-snapshot-on-disk) |
| `-n`, `--dry-run` | say what would be brought back and where to, and bring nothing |
| `-y` | see [COLD.md](COLD.md#options-given-at-the-cold-level) |

What narrows a pull of a tree — `--dataset`, `--partition`, `--date`, `--instruments`, `-f` and the
preferences — is not read.

**Never over the catalog in use.** What comes back is put together at
`<cold>/pulled/catalog/catalog.db`, or where `--output` says, and its path is said. Whether and when
it takes the place of the one in use is for whoever ran it. **A path that is already something is
refused.**

It is refused where Mega holds no `catalog.db` or no `tables.db` at `<MEGA_ROOT>/@cold/catalog/`.
What it would bring back, and what that weighs, is said first and then asked; yes is the answer.

1. **The snapshot is brought back**, unless it is on disk already, with `tables.db` and the
   partitions' files, to `<cold>/pulling/catalog/`. A file already there at the size Mega has it was
   brought by a run that stopped, and is not asked for again. A snapshot that comes back is held to
   the digest in the record, where the record has sent that very object.
2. **The snapshot becomes the database that was asked for**: copied there where a snapshot is left on
   disk, moved there where none is.
3. **Every table but `file` is dropped from it and put back from `tables.db`**, schema and rows, with
   every index, trigger and view `tables.db` declares. The `file` table and its indexes stay as the
   snapshot has them; a snapshot whose `file` table is not declared as `tables.db` declares it is
   refused.
4. **Each partition that has a file of its own has its rows put into `file`**: a row that is there is
   written over, one that is not is added, and none is taken out, since the catalog never takes a
   file row out. A row with the same path and ETag as the snapshot had keeps what the snapshot said
   of when it was downloaded; a new or changed one was not, as far as the copy knows.
