# cold evict

`cold evict [origin] [venues…]` removes from the local disk what no longer has to be there. See
[COLD.md](COLD.md) for the namespace and origins, and [COLD-PUSH.md](COLD-PUSH.md) for how things
got into cold storage.

This page is the **archives**. The vault is evicted on request, by a selection, and brought back
again as a matter of routine: [COLD-VAULT.md](COLD-VAULT.md).

**This is the only command in the family that removes anything.** It says what it would remove,
venue by venue, and asks before removing anything; the answer defaults to no. What it removes goes to
the trash. `--dry-run` stops after saying.

## What can go

**A partition of the archives can go once two things hold it: cold storage, and the vault.** The
archives exist to be stocked and to be kept. Once both are done, the copy on disk is a third.

The candidates are the partitions the catalog says are downloaded and settled. Each is asked three
things, and stays unless all three hold:

| | |
|---|---|
| **It is in cold storage at the catalog's version** | a tar that is stored holds it, at the version the catalog has now |
| **It is stocked** | the vault's ledger has it — or another rendering of the same data — at versions that are still the catalog's, and what was stocked is still held: in cold storage, or on disk in the vault |
| **No neighbouring month still needs it** | where its files hold the first or last hours of the month next door, that month has them in the vault |

What is left is removed, unless the record says it already was at the version it has now.

**Nothing of the archives is looked at to decide.** Whatever they hold of a partition that passes —
the same files, older ones, or only some — goes, so no answer their disk could give would change
anything. Deciding is two requests to the catalog per venue, the record and the vault's ledger — and,
for a vault partition that is not in cold storage, a look for its files in the vault. The file and
byte counts shown are the catalog's.

### In cold storage

That a partition was checked against the disk and proven inside its tar is what storing it meant
([COLD-PUSH.md](COLD-PUSH.md)), so nothing is compared again here: the record says which version a
stored tar holds, and that version is the catalog's or it is not. A partition in a tar that is
planned, packed or on its way is not in cold storage yet. Neither is one whose tar is waiting to be
corrected.

### Stocked

The vault keeps a ledger of what it holds, a line per partition, saying which partition of the
archives it was stocked from and at which catalog version — and, for each side a neighbouring month
holds of it, that month's version, or `missing` where that month was not there to be read. A line
counts while every version it names is still the catalog's.

**A month stocked without a neighbour's hours is stocked.** Its own files have given the vault
everything they hold; what it lacks is in the neighbour's files. A partition whose ledger line says
`updating` is having its files changed and is not stocked; one that says `outdated` is waiting to be
stocked again from these very archives, and is not stocked either.

**Any rendering will do.** The same data is often published at more than one grain, or per
instrument and as a market's bundle, and the vault is built from one of them. Which one is the
vault's business. What matters here is that none of them is needed any more, so once a month of a
dataset is stocked from any rendering, every rendering of it is taken as stocked.

**What was stocked has to be held somewhere still.** The record is asked first: a vault partition it
has stored, at the revision the ledger names, is held. Only one it does not have stored is looked for
on disk in the vault, where its files have to be. A ledger line whose partition is neither is not
taken as stocked, and what it was stocked from stays.

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
  can be settled 15 days after it ends, so until then the venue has simply not published it. One
  whose following month has had its time and never came is the last month of a dataset the venue
  stopped publishing, and goes.

## A vault that reports a loss stops everything

The vault writes `ERROR.log` when it finds that its ledger says something its disk does not bear
out. Eviction trusts the ledger, so while that file exists nothing is evicted: the command says what
the file holds and ends. It runs again once the cause is understood and the file removed.

Without a ledger at all, nothing can be said to be stocked, and the command ends the same way.

## What it does

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

**It lands on the same filesystem**, which is what makes it viable at this size:
`<volume>/.Trash-$uid/` for a file on that volume, so it is a rename and not a copy of the tree into
`$HOME`. `gio` selects that per-volume trash itself and writes the record holding where each file
came from, which is what makes putting one back possible — so the trash is only ever handled
through `gio`, never by moving files into `.Trash-*` by hand.

**It frees no space until the trash is emptied**, and the command says so. Emptying is the chance to
look at what was taken before it goes, and belongs to a file manager: the trash holds other things
too.

**A failed trash is never retried as a delete.** If `gio` is unavailable or the volume refuses, the
run stops at that partition, which is not written down as evicted.

`--purge` deletes outright, for when that is what is wanted.

**The catalog goes on saying the files are downloaded**, which is what keeps them from being
downloaded again. If a partition changes after it was evicted, only the files that changed are
downloaded, and the partition is on disk in part until the rest is brought back from cold storage.

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

It is a look taken on purpose and once. With `--watch` it is refused: a run left going would take
files as they are pulled. It honours `--dry-run` and `--purge`, and is for the archives only — asked
of the vault, it changes nothing.

## Watching

`--watch`, one of the options every `cold` command shares ([COLD.md](COLD.md)), keeps the run going
and looks again every 30 minutes. What can go changes as partitions are stored and stocked, so a run
left going removes each as it becomes removable.

It asks before the first removal of the run and not again. A later look says only what it is about
to remove; one that finds nothing says once that it is waiting, and is then quiet until there is
something. The vault's `ERROR.log` is read on every look, and ends the run when it appears. A catalog
that does not answer costs that look and nothing else.

Left watching without `--purge`, what is removed gathers in the trash: nothing is freed until that is
emptied.

## Running it alongside a push

`evict` and `push` hold separate locks and can run at once. They do not meet: `push` reads the
archives for partitions that are not stored yet, or whose version changed, and `evict` removes only
what is stored at the catalog's version.

## Environment

As [COLD-PUSH.md](COLD-PUSH.md), and:

| | | |
|---|---|---|
| `DATA_VAULT_DIR` | `<DATA_DIR>/vault` | the vault whose ledger says what is stocked |
