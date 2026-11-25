# cold evict

`cold evict archives [venues…]` removes from the local disk what no longer has to be there. See
[COLD.md](COLD.md) for the namespace, origins and configuration, and [COLD-PUSH.md](COLD-PUSH.md)
for how things got into cold storage.

This page is the **archives**. The vault is evicted on request, by a selection, and brought back
again as a matter of routine: [COLD-VAULT.md](COLD-VAULT.md#cold-evict-vault).

It says what it would remove, venue by venue, and asks before removing anything; the answer
defaults to yes, since removing is what it was run to do. What it removes goes to the trash unless
`--purge` is given. `--dry-run` stops after saying.

| | |
|---|---|
| `-n`, `--dry-run` | say what would be removed, and remove nothing |
| `--purge` | delete outright, where the default is the trash |
| `--cleanup` | also remove what is on disk again of partitions already evicted; see [below](#what-was-evicted-and-is-on-disk-again) |

## What can go

**A partition of the archives can go once two things hold it: cold storage, and the vault.** The
archives exist to be stocked and to be kept. Once both are done, the copy on disk is a third.

The candidates are the partitions the catalog says are downloaded and settled. Each is asked three
things, and stays unless all three hold:

| | |
|---|---|
| **It is in cold storage at the catalog's version** | a tar that is stored holds it, at the version the catalog has now, with no change noted of it |
| **It is stocked** | the vault's ledger has it — or another rendering of the same data — at versions that are still the catalog's, and what was stocked is still held: in cold storage, or on disk in the vault |
| **No neighbouring month still needs it** | where its files hold the first or last hours of the month next door, that month has them in the vault |

What is left is removed, unless the record says it already was at the version it has now.

**Nothing of the archives is looked at to decide.** Whatever they hold of a partition that passes —
the same files, older ones, or only some — goes, so no answer their disk could give would change
anything. A look is two requests to the catalog per venue (the downloaded and settled partitions,
and every partition it holds), the record and the vault's ledger — and, for a vault partition that
is not in cold storage, a look for its files in the vault. The file and byte counts shown are the
catalog's.

### In cold storage

That a partition was checked against the disk and proven inside its tar is what storing it meant
([COLD-PUSH.md](COLD-PUSH.md)), so nothing is compared again here: the record says which version a
stored tar holds, and that version is the catalog's or it is not. A partition in a tar that is
planned, packed or on its way is not in cold storage yet. Neither is one whose tar is waiting to be
corrected, nor one whose change is noted.

### Stocked

The ledger and what its marks mean are [STOCKER.md](../services/STOCKER.md#the-ledger)'s; what
follows is what cold concludes from it.

**A partition is stocked by the last line the ledger has for it.** A line counts while every version
it names — its own, and a neighbouring month's where it names one — is still the catalog's. A
partition whose last line says `updating` or `outdated` is not taken as stocked.

**A month stocked without a neighbour's hours is stocked.** Its own files have given the vault
everything they hold; what it lacks is in the neighbour's files, which stay until it has them (see
[below](#no-neighbouring-month-still-needs-it)).

**What the vault waits for is not brought back here.** Where what it needs to finish a partition is
in cold storage — its own files for a month that can now be completed, or the archives an outdated
partition is stocked again from — the first look says so, and
[`cold pull needed`](COLD-PULL.md#cold-pull-needed) is what brings them.

**Any rendering will do.** The same data is often published at more than one grain, or per
instrument and as the market bundle (`@`). Once a month of a dataset is stocked from any rendering,
every rendering of it is taken as stocked.

**What was stocked has to be held somewhere still.** The record is asked first: a vault partition it
has stored, at the revision the ledger names, is held. Only one it does not have stored is looked for
on disk in the vault. A ledger line whose partition is neither is not taken as stocked, and what it
was stocked from stays.

### No neighbouring month still needs it

Some venues cut their days away from UTC midnight, so a month's first or last hours sit in a file of
the month next door, and the vault stocks them from there. **A month's own ledger line says whether
its dataset does that, and which way**: a side it names, with a version or as `missing`, is a side a
neighbour's files hold.

| The month's line names | so its own files hold | and they stay until |
|---|---|---|
| neither side | nothing of any other month | — |
| the month after (`postVersion`) | the last hours of the month before | the month before is stocked with a `postVersion` that is a version |
| the month before (`preVersion`) | the first hours of the month after | the month after is stocked with a `preVersion` that is a version |

So a month of a dataset that keeps to UTC midnight waits on nothing, and where a month was stocked
before its neighbour arrived, the neighbour's files stay until they have been read for it.

**Only a month the catalog holds is waited for**, read from everything the catalog holds and never
from what is settled:

- **A month the venue published nothing in** will never need anything, and is not waited for.
- **A month the catalog holds that is not stocked yet** will, and its neighbour's files stay.
- **A month whose files hold the first hours of the month after, where that month is not in the
  catalog**, waits until the month after could have been settled and still is not there. A month
  can be settled 15 days after it ends ([CATALOG-API.md](../modules/CATALOG-API.md#partitions)), so
  until then the venue has simply not published it.
  One whose following month has had its time and never came is the last month of a dataset the
  venue stopped publishing, and goes.

## A vault that reports a loss stops everything

The vault writes `ERROR.log` when it finds that its ledger says something its disk does not bear
out. Eviction trusts the ledger, so while that file exists nothing is evicted: the command says what
the file holds and ends, with a failing exit code. It runs again once the cause is understood and
the file removed. The file is read again right before each venue's removal too.

Without a ledger at all, nothing can be said to be stocked, and the command ends the same way.

## What it does

**Each venue is looked at again just before its files go.** Between the first look and the removal
there is the question, and every venue removed before this one, which can be hours. Only what the
second look still finds ready, at the same version, goes; and only while the record still has it in
a stored tar at that version, with no change noted. The rest is left for the next look, and the run
says how many.

Each evictable partition is moved to the trash, a month's directory at a time. A directory under an
instrument holds every rendering of that month side by side, and each rendering is a partition of
its own, in cold storage or not:

- **Where every file in a directory belongs to a partition being evicted in this run, the directory
  goes whole.** That is one move for everything in it, and it is the ordinary case.
- **Where something in it is staying** — a rendering not stored yet, a file that is nobody's — the
  partition's files are picked out of it by name, and the directory is left.

**Directories left empty are removed**, upward for as long as they are empty: a month's, then the
instrument's, its letter's, the dataset's and the market's — never the venue's own. One that holds
anything is left, and so is everything above it.

This is the only time the disk is read, and only for names: no file is opened or measured. Each
partition removed is written to the record, in `eviction`: what it was, the version cold storage
holds of it, how many files went, what the catalog says it weighed, and when. That row is what keeps
it from being offered again.

### Files go to the trash

Every check above has to be right for a removal to be safe, and the one thing none of them covers is
a mistake in the checks themselves. Moving to the host's trash costs nothing and turns that class of
mistake from permanent into a restore.

**It lands on the same filesystem**, which is what makes it viable at this size. Removal goes
through `gio trash`, which picks the trash of the volume a file is on, so the move is a rename and
not a copy of the tree, and writes the record of where each file came from, which is what makes
putting one back possible. Files are never moved into a `.Trash-*` directory by hand.

**It frees no space until the trash is emptied**, and the command says so. Emptying is the chance to
look at what was taken before it goes, and belongs to a file manager: the trash holds other things
too.

**A failed trash is never retried as a delete.** If `gio` is unavailable or the volume refuses, the
run stops at that partition, which is not written down as evicted.

`--purge` deletes outright, for when that is what is wanted.

**The catalog goes on saying the files are downloaded**, which is what keeps them from being
downloaded again. If a partition changes after it was evicted, only the files that changed are
downloaded, and the partition is on disk in part until its tar is corrected
([COLD-PUSH.md](COLD-PUSH.md#a-partition-that-changed)).

Removal goes a partition at a time, and a line per venue says how far it is.

## What was evicted and is on disk again

The record says what went, and a partition that went at the version it has now is not offered again.
So files brought back afterwards — pulled from cold storage to be read, or fetched some other way —
stay where they are: nothing looks for them.

`--cleanup` looks. For every partition that went and can still go by every rule above — in cold
storage at the catalog's version, stocked from it, no neighbour needing it — the archives are read,
and whatever of the partition is on disk goes again. Nothing is compared file by file: cold storage
holds the version the catalog has, so what is on disk is spare whatever it is, the same files, older
ones or part of them. A partition whose version has moved on since it went is left alone, like any
other that cold storage does not hold as it is now.

It is a look taken on purpose and once, so it is refused with `-w`: a run left going would take
files as they are pulled. It honours `--dry-run` and `--purge`, and is for the archives only —
asked of the vault, it changes nothing.

## Watching

With `-w` ([COLD.md](COLD.md#watching)) the run keeps going and looks again every 30 minutes. What
can go changes as partitions are stored and stocked, so a run left going removes each as it becomes
removable.

It asks before the first removal of the run and not again. A later look says only what it is about
to remove; one that finds nothing says once that it is waiting, and is then quiet until there is
something. A look that finds the vault's `ERROR.log`, or no ledger, removes nothing, and the next
look reads it again. An error from the catalog after the first look costs that look and nothing
else.

Left watching without `--purge`, what is removed gathers in the trash: nothing is freed until that is
emptied.

## Running it alongside a push

`evict` and `push` hold separate locks ([COLD.md](COLD.md#locks)) and run side by side. They act on
different partitions: `push` reads the archives only for partitions the record does not hold at the
catalog's version — new ones, and changed ones whose tar is being corrected — and `evict` removes
only partitions in a stored tar at the catalog's version with no change noted, and looks at the
catalog and the record again right before each venue's removal. Both write the record, and SQLite
keeps those writes apart.
