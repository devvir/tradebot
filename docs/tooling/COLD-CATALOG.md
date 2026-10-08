# cold push catalog · cold pull catalog

A copy of the catalog's database in cold storage, and the way back from it. See [COLD.md](COLD.md)
for the namespace.

**The catalog can be rebuilt from the venues, given days — and not at all where a venue has since
withdrawn what it published.** The copy is not there to be pulled and used the next minute: it is so
that losing the catalog costs a restore and not a survey.

**The catalog is not a tree of data.** Both commands are asked for by name; `--all-sources` never
includes them.

---

## What the copy is

```
<MEGA_ROOT>/@cold/catalog/catalog.db
<MEGA_ROOT>/@cold/catalog/tables.db
<MEGA_ROOT>/@cold/catalog/partitions/<venue>/<YYYY>/<venue>|<market>|<dataset>[,<variant>]|<grain>|<bundle>|<YYYYMM>.csv.gz
```

- **The snapshot is `catalog.db` as it was sent, whole**: every table and every index, with nothing
  left to get wrong.
- **`tables.db` is everything but the file rows, as a database of its own**: every table, index and
  trigger declared as the catalog declares it, with the rows of every table but two — the files',
  which go a partition at a time, and `wip`, which is only ever work in progress. Those two are
  there empty. It is small, and is sent whole on every push.
- **A file for each partition that changed since the snapshot**: every file row of that partition,
  in the order of their path, under a header of their columns. Which partition they are of is the
  file's name. Whether each was downloaded is left out: the snapshot knows that of every file it
  has, and of one that came later it is a fact about a disk. `NULL` is written `\N`, so that it is
  not taken for the empty text.

**A partition is one file however often it changes.** Each replaces the one sent before at the same
place, which Mega keeps as an earlier version. What grows over time is how many partitions have
changed since the snapshot, never how much is kept of any one.

**What ties a snapshot to what is sent after it is the files' table.** Every other table comes back
from `tables.db` with whatever schema the catalog had when that was written. The file rows come
back from the snapshot, with the partitions' rows put into them — so the files' table has to be
declared as it was when the snapshot was taken. How it was declared then, the table and its
indexes, is kept in the record beside the snapshot's digest.

## The snapshot on disk

**Cold keeps its own copy of the snapshot while it works, in `<cold>/catalog/catalog.db`.** It
weighs what the catalog weighs, it is cold's own, and nothing else reads it.

**Whether one is there is read off the disk each time, and written down nowhere**: it is anyone's
to delete.

**The record knows it from any other file**: `catalog_copy` holds its SHA-256, what it weighs, and
Mega's own identifier for the object once it is stored. A file there is the snapshot where it has
that digest and that weight, and Mega still holds that very object. Then nothing of the snapshot is
brought back by a pull, whatever is asked of it — the difference between hours and minutes.

**Anything else found there is said, and the command asks whether to delete it**; yes is the
answer. It is as large as the catalog and of no use. A push tells by its weight; a pull, which reads
it, by its digest.

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
| `--rebase` | take a new snapshot: send the whole database again, and drop the partitions' files sent since the last |
| `--keep-snapshot`, `--drop-snapshot` | see above |
| `-n`, `--dry-run` | say what would be sent, and send nothing |

1. **Prospector has to be stopped, and the catalog's service with it.** What is read is read at one
   moment, and a database somebody has open cannot be made one file. Where either is running the
   command says how to stop it — `tb down archives` — and waits until both are
   gone.
2. **The database is made one file.** A write-ahead log beside it is the sign of a connection that
   did not close last, and `catalog.db` alone is then not all of the catalog. It is opened and
   closed, which folds the log in and removes it; three seconds later the log is looked for again,
   and one that is still there is somebody else with the database open — the catalog's own service,
   usually — and nothing is copied.
3. **The first time, or with `--rebase`, a snapshot is taken**: `catalog.db` is copied into cold's
   working directory, its digest taken as it is read, with the catalog's version of every partition
   as it then is.
4. **Every time, `tables.db` is written.** On a run that takes no snapshot the files' table is
   first held to how it was declared when the snapshot was taken. Where it is declared otherwise,
   what changed since cannot be put into that snapshot: the command says so and asks whether to
   take a new snapshot instead. No is the answer, and nothing is sent.
5. **Every time after the first, each partition whose version in the catalog is no longer the one
   in the record is written to its file.** The version moves exactly when a file of the partition
   is added, withdrawn or changed, so nothing is read to find out which.
6. **The catalog is free, and the command says so**: everything that is sent has been read out of
   it. Prospector and the catalog's service can be started, long before Mega has it all.
7. **What was written is sent.** A snapshot is read back first and held to the digest taken in step
   3, then sent, which takes as long as it weighs. As Mega confirms it, its identifier and the
   partitions' versions are written into the record. Every other file leaves cold's working
   directory as Mega confirms it.

A run that stops while the snapshot is being sent is taken up by the next, which sends the same copy
and reads nothing again.

**`--rebase` is needed when the files' table is declared otherwise than the snapshot has it**, and
at no other time: the copy is whole without it. It is worth doing now and then all the same, since
it leaves a copy with nothing to put into it, and it is the one time everything is looked at again.

**Rows that change without their partition's version moving are not seen.** The version follows the
files' ETags, so a row edited by hand has to move it.

## `cold pull catalog`

| | |
|---|---|
| `-o`, `--output <path>` | where the database is left: a directory, or the file itself. `catalog.db` unless a file is named |
| `--keep-snapshot`, `--drop-snapshot` | see above |
| `-n`, `--dry-run` | say what would be brought back and where to, and bring nothing |

**Never over the catalog in use.** What comes back is put together at
`<cold>/pulled/catalog/catalog.db`, or where `--output` says, and its path is said. Whether and when
it takes the place of the one in use is for whoever ran it. **A path that is already something is
refused.**

1. The snapshot is brought back — unless it is on disk already, which is found out by reading it —
   and one that comes back is held to the digest in the record. `tables.db` and the partitions'
   files are brought to `<cold>/pulling/catalog`.
2. The snapshot becomes the database that was asked for: copied there where a snapshot is left on
   disk, moved there where none is.
3. Every table but the files' is dropped from it and put back from `tables.db`, schema and rows,
   with every index and trigger `tables.db` declares. The files' table and its indexes stay as the
   snapshot has them; a snapshot whose files' table is not declared as `tables.db` declares it is
   refused.
4. Each partition that has a file of its own has its rows put into the files' table: a row that is
   there is written over, one that is not is added, and none is taken out — the catalog never takes
   a file row out. A row that is the same file as the snapshot had — the same path and checksum —
   keeps what the snapshot said of whether it was downloaded; a new or a changed one was not, as far
   as the copy knows.

## Not built: files that only just arrived

A partition of the running month changes every day, and so is sent every day. That could be left
out: the copy would be of the catalog as it was some days back, and a restore would set each series'
tip back to match, so that the next update finds the newest files again by asking the venue. The
copy would then change only where history does.
