# cold and the archives

How `./tools cold` stores the archives, takes them off the local disk and brings them back. What every
cold command shares — the command shape, configuration, where things live, locks, the record, how
Mega is trusted, watching — is in [COLD.md](COLD.md).

**The archives are packed.** A partition of the archives is every file the catalog lists for it, and
cold storage holds it inside a tar, with other partitions of the same venue-month. Which partitions a
tar holds, and at which version, is in [the record](COLD.md#the-record) and nowhere else.

**The link is the constraint.** Uploading is hours per tar while packing one is minutes, so `push`
keeps just enough packed to keep Mega's queue fed, and every step is resumable, because a run
measured in days will be interrupted.

| | |
|---|---|
| [`cold push archives`](#cold-push-archives) | store every partition that is ready and not in cold storage yet |
| [`cold evict archives`](#cold-evict-archives) | remove from the disk what cold storage and the vault both hold |
| [`cold pull archives`](#cold-pull-archives) | bring back a venue's dataset, or a partition of it |
| [`cold stats archives`](#cold-stats-archives) | what the record holds, venue by venue |

---

## `cold push archives`

`cold push archives [venues…]` stores every partition of the archives that is ready and not in cold
storage yet: it packs them into tars, uploads the tars to Mega, and records which partitions each
tar holds.

| | |
|---|---|
| `-l`, `--lens [slug]` | only what that lens of the catalog lets through; with no slug, the catalog's lenses are listed to pick one |
| `-n`, `--rebase`, `--keep-snapshot`, `--drop-snapshot` | refused: they are [`push catalog`](COLD-CATALOG.md#cold-push-catalog)'s |
| `-w`, `-y`, `-a` | see [COLD.md](COLD.md#options-given-at-the-cold-level) |

Under `cold push all`, or `--all-sources`, a lens narrows the archives only, and the run warns that
the vault is pushed whole.

### What is ready

**A partition is ready when the catalog says nothing of it is left to download and that it is
settled.** That is asked of the catalog directly, venue by venue — the partitions endpoint, with
`downloaded=true` and `settled=true` — so nothing here decides what finished means. A partition a
run is still adding to can be complete at every moment and still be a fraction of itself, and only
the catalog knows which; what it takes as settled is in
[CATALOG-API.md](../services/CATALOG-API.md#partitions).

`COLD_SETTLED_HOURS`, where set, asks for quiet on top: the request carries `settled-before` that
many hours ago in place of `settled`, and a settled partition that changed since is left for a
later run.

**Every partition the catalog holds, unless a lens is asked for.** `--lens <slug>` reads the catalog
through that lens. A lens only narrows what this run considers: a partition stored on an earlier run
and outside the lens today is left exactly as it is.

**Venues after the origin narrow it further**: `cold push archives gate htx`.

Before anything is packed, the run says what it found and asks to go ahead; the answer defaults to
yes.

### Planning

What the catalog answers is set against the record, one venue at a time:

- **A partition the record does not have** is planned into a new tar of its venue-month.
- **A tar planned and never made is dropped first.** The plan is redrawn on every run from what the
  catalog says is ready now, so a partition that was ready once and no longer is leaves the plan. A
  tar Mega once held keeps its partitions, since the record is the only thing that knows them.
- **One it has at the same version** needs nothing.
- **One it has at another version** has changed since it was stored — see
  [a partition that changed](#a-partition-that-changed).
- **One whose change is noted, where the catalog is back at the version cold storage holds**, has
  the change taken back while its tar has not been brought back yet; once it has, the correction is
  made to the version the catalog holds.
- **A partition the catalog does not answer with** is left exactly as it is: it is outside the lens,
  still downloading or still changing, and none of those is a reason to touch what is stored.

A plan is written before any tar exists, so a run that stops after planning finds the plan and
makes the tars, and one that stops before it plans again.

### Dividing a venue-month into tars

**A tar holds whole partitions and nothing less.** A partition is never cut, by instrument or by
anything else: one that weighs fifty gigabytes is a tar of fifty gigabytes.

The 5 GB cap is where a clean cut is looked for among the rest. Partitions are taken heaviest first,
each into the first tar of the month that still has room for it; one heavier than the cap gets a tar
of its own. That lands near the cap, and nothing downstream needs it to be exact. The cap is
hardcoded rather than configured, because it decides the shape of what lands in cold storage and a
value that drifted between runs would make that shape inconsistent for no benefit.

**A month gains tars as more of it becomes ready.** Partitions that turn up on a later run — a slice
a lens did not let through before, a dataset discovered since — go into new tars numbered after the
month's last. Nothing already stored is repacked to make room.

### A tar's way into cold storage

Each tar is in one state, written to the record as it moves:

| state | what is true |
|---|---|
| `planned` | the record says what it will hold; no tar exists |
| `packed` | the tar is on disk, proved against the files it was made from |
| `queued` | handed to Mega, which has not confirmed it |
| `stored` | Mega holds it, at the size and under the handle recorded |

**Checked against the disk right before packing.** Each partition's files are gathered from the
archives and must agree with the catalog in count and total size. No file is opened and nothing
else is compared: the catalog's version already stands for every file's content. A partition that
is not on disk as the catalog says leaves its tar planned, and the run says which one.

**Proved before it is uploaded, in three steps that each leave their own name.** A tar is written
as `.tar.tmp`, renamed `.tar.unverified` once it is written in full, compared member for member
against the tree with `tar -d`, and renamed `.tar` only once that passes. Nothing but a `.tar` is
ever uploaded.

A run stopped part way picks up at the step it was on:

| Found on disk | Meaning | Next run |
|---|---|---|
| `.tar.tmp` | it was being written | cleared at startup, written again |
| `.tar.unverified` | written in full, not proven | compared, not written again |
| `.tar` | proven | uploaded |

An `.unverified` tar is kept only where it lists exactly the members its plan now holds; the plan is
redrawn every run, so one written for other partitions is written again. One that fails the
comparison is removed. A `packed` tar that is no longer on disk goes back to `planned`, or, where
Mega holds an older one, to being corrected.

**Confirmed by finding it in Mega**, at the size and modification time of the tar on disk, as
[COLD.md](COLD.md#how-mega-is-trusted) sets out. Mega's handle is recorded with it, and the staging
tar is deleted. A queued tar Mega no longer has in its queue and does not list is handed over
again.

**Packing waits on the queue, not on any one upload.** No tar is made while Mega's upload queue
holds more than `COLD_QUEUE_TARGET_GB`, or while the queue cannot be read, and one tar is made at a
time before the queue is asked again. The queue is Mega's whole queue: anything already in it, this
run's or not, is in front of the next tar.

**One tar failing does not end the run.** It keeps its state and its turn comes round on the next
run, or at the next asking of a run left watching; the run ends by saying how many were left
behind.

**What was stored is looked at once more** once everything found has been sent, since a tar can be
handed over twice and stored under another handle. That second look, and taking second transfers
out of the queue at the start of each round, are in [COLD.md](COLD.md#how-mega-is-trusted).

### A partition that changed

A stored partition whose version in the catalog is no longer the one recorded has to be stored
again — and it shares its tar with others that have not changed. So the tar is corrected in place:

| state | what is true |
|---|---|
| `stale` | Mega holds the tar, and a partition in it is out of date |
| `fetching` | Mega is bringing the tar back, at the size Mega lists it at |
| `fetched` | the tar is on disk again |

then the out-of-date partition's files are taken out of the tar and its current files put in, and
the tar is `packed` again and goes the ordinary way: queued, and stored under the same name, where
Mega keeps it as a new version of the same file.

**A tar on its way when one of its partitions changes keeps going.** What it was made with is
written down as stored once Mega confirms it, and the change, still noted, then sends it back to be
corrected.

**The download runs beside everything else.** A tar coming back uses the link's download side, so
other tars go on being packed and uploaded while it does.

**Only what changed is touched.** The rest of the tar is no longer on this disk and is neither read
nor needed. Afterwards the tar must list exactly what it listed before, less what was taken out,
plus what was put in — and what was put in is compared against the tree.

**A partition that is no longer whole on disk is made whole from the two.** One that was evicted
after it was stored comes back only in the files that changed, since only those are downloaded
again. Then what is on disk goes in — replacing any member of the same name — and the rest of what
the tar holds of the partition stays where it is. That is taken as the partition only where the two
add up to exactly what the catalog says, as many files weighing as much. Where they do not — a file
the venue withdrew, a download still on its way — nothing is guessed: the tar stays as it was
brought back, on disk, and the next run tries again without fetching it a second time.

**The record holds both versions until the corrected tar is stored**: the one Mega has, and the one
it is being corrected to. An interrupted correction therefore resumes from whichever step it
reached, and a corrected tar is told from the one it replaces by its handle, since the two can weigh
the same.

A changed partition is expected to weigh about what it did, so partitions are not redistributed
between a month's tars when one changes.

### Watching the catalog

With `-w` the run keeps going once everything ready is stored, and asks the catalog again every 30
minutes. Each asking redraws the plan as a new run would, and whatever is newly ready joins the tars
already in hand. A tar that could not be moved on is tried again at each asking.

| The run was | An asking shows |
|---|---|
| waiting, with nothing to push | the asking, and each venue's answer |
| packing or uploading | nothing, unless it found something: then one line saying how many partitions |

Between askings, a run with nothing to push says once that it is waiting. An asking gives the
catalog 15 seconds; one it does not answer in that time costs that asking and nothing else.

---

## `cold evict archives`

`cold evict archives [venues…]` removes from the local disk what no longer has to be there.

| | |
|---|---|
| `-n`, `--dry-run` | say what would be removed, and remove nothing |
| `--purge` | delete outright, where the default is the trash |
| `--cleanup` | also remove what is on disk again of partitions already evicted; see [below](#what-was-evicted-and-is-on-disk-again). Refused with `-w` |
| `--include-pulled` | also remove partitions a pull brought back; see [below](#what-a-pull-brought-back-stays) |
| `--market`, `--dataset`, `--variant`, `--from`, `--to`, `--instruments` | ignored: they select part of [the vault](COLD-VAULT.md#selecting-part-of-the-vault) |
| `-w`, `-y`, `-a` | see [COLD.md](COLD.md#options-given-at-the-cold-level) |

It says what it would remove, venue by venue, and asks before removing anything; the answer
defaults to yes, since removing is what it was run to do.

### What can go

**A partition of the archives can go once two things hold it: cold storage, and the vault.** The
archives exist to be stocked and to be kept. Once both are done, the copy on disk is a third.

The candidates are the partitions the catalog says are downloaded and settled. Each is asked three
things, and stays unless all three hold:

| | |
|---|---|
| **It is in cold storage at the catalog's version** | a tar that is stored holds it, at the version the catalog has now, with no change noted of it |
| **It is stocked** | the vault's ledger has it — or another rendering of the same data — at versions that are still the catalog's, and what was stocked is still held: in cold storage, or on disk in the vault |
| **No neighbouring month still needs it** | where its files hold the first or last hours of the month next door, that month has them in the vault |

What is left is removed, unless the record says it already was at the version it has now, or that a
pull brought it back.

**Nothing of the archives is looked at to decide.** Whatever they hold of a partition that passes —
the same files, older ones, or only some — goes, so no answer their disk could give would change
anything. A look is two requests to the catalog per venue (the downloaded and settled partitions,
and every partition it holds), the record and the vault's ledger — and, for a vault partition that
is not in cold storage, a look for its files in the vault. The file and byte counts shown are the
catalog's.

#### In cold storage

That a partition was checked against the disk and proven inside its tar is what storing it meant
([above](#a-tars-way-into-cold-storage)), so nothing is compared again here: the record says which
version a stored tar holds, and that version is the catalog's or it is not. A partition in a tar
that is planned, packed or on its way is not in cold storage yet. Neither is one whose tar is
waiting to be corrected, nor one whose change is noted.

#### Stocked

The ledger and what its marks mean are [STOCKER.md](../services/STOCKER.md#the-ledger)'s; what
follows is what cold concludes from it.

**A partition is stocked by the last line the ledger has for it.** A line counts while every version
it names — its own, and a neighbouring month's where it names one — is still the catalog's. A
partition whose last line says `updating`, `updating-sides` or `outdated` is not taken as stocked.

**A month stocked without a neighbour's hours is stocked.** Its own files have given the vault
everything they hold; what it lacks is in the neighbour's files, which stay until it has them (see
[below](#no-neighbouring-month-still-needs-it)).

**What the vault waits for is not brought back here.** Where what it needs to finish a partition is
in cold storage, the first look says so, and
[`cold pull needed`](COLD-VAULT.md#cold-pull-needed) is what brings it.

**Any rendering will do.** The same data is often published at more than one grain, or per
instrument and as the market bundle (`@`). Once a month of a dataset is stocked from any rendering,
every rendering of it is taken as stocked.

**What was stocked has to be held somewhere still.** The record is asked first: a vault partition it
has stored, at the revision the ledger names, is held. Only one it does not have stored is looked for
on disk in the vault. A ledger line whose partition is neither is not taken as stocked, and what it
was stocked from stays.

#### No neighbouring month still needs it

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
  can be settled 15 days after it ends ([CATALOG-API.md](../services/CATALOG-API.md#partitions)), so
  until then the venue has simply not published it. One whose following month has had its time and
  never came is the last month of a dataset the venue stopped publishing, and goes.

### A vault that reports a loss stops everything

The vault writes `ERROR.log` when it finds that its ledger says something its disk does not bear
out. Eviction trusts the ledger, so while that file has anything in it nothing is evicted: the
command says what the file holds and ends, with a failing exit code. It runs again once the cause is
understood and the file removed. The file is read again right before each venue's removal too.

Without a ledger at all, nothing can be said to be stocked, and the command ends the same way.

### What it does

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
partition removed is written to [the record](COLD.md#the-record), in `eviction`: what it was, the
version cold storage holds of it, how many files went, what the catalog says it weighed, and when.
That row is what keeps it from being offered again.

**The catalog goes on saying the files are downloaded**, which is what keeps them from being
downloaded again. If a partition changes after it was evicted, only the files that changed are
downloaded, and the partition is on disk in part until its tar is corrected
([above](#a-partition-that-changed)).

Removal goes a partition at a time, and a line per venue says how far it is.

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

### What a pull brought back stays

**A partition a pull brought into the archives is written down as pulled**, in the record's `pulled`
table, and stays on disk until it is evicted on purpose. It is there because it was asked for, so
`evict` counts it — "pulled back, kept" — and leaves it, though cold storage and the vault hold it.
That holds for what [`cold pull archives`](#cold-pull-archives) brings and for what
[`cold pull needed`](COLD-VAULT.md#cold-pull-needed) brings of the archives.

`--include-pulled` takes such partitions too, by every rule above. Once one is evicted it is no
longer written down as pulled.

### What was evicted and is on disk again

The record says what went, and a partition that went at the version it has now is not offered again.
So files that are back on disk some other way — fetched by hand, or written back by anything but a
pull — stay where they are: nothing looks for them.

`--cleanup` looks. For every partition that went and can still go by every rule above — in cold
storage at the catalog's version, stocked from it, no neighbour needing it — the archives are read,
and whatever of the partition is on disk goes again. Nothing is compared file by file: cold storage
holds the version the catalog has, so what is on disk is spare whatever it is, the same files, older
ones or part of them. A partition whose version has moved on since it went is left alone, like any
other that cold storage does not hold as it is now. A partition written down as pulled is left too,
unless `--include-pulled` is also given.

It is a look taken on purpose and once, so it is refused with `-w`. It honours `--dry-run` and
`--purge`.

### Watching the disk

With `-w` the run keeps going and looks again every 30 minutes. What can go changes as partitions
are stored and stocked, so a run left going removes each as it becomes removable. The archives are
listed afresh at each look.

It asks before the first removal of the run and not again. A later look says only what it is about
to remove; one that finds nothing says once that it is waiting, and is then quiet until there is
something. A look that finds the vault's `ERROR.log`, or no ledger, removes nothing, leaves the exit
code alone, and the next look reads it again. An error from the catalog after the first look costs
that look, or that venue's removal, and nothing else.

Left watching without `--purge`, what is removed gathers in the trash: nothing is freed until that is
emptied.

### Running it alongside a push

`evict` and `push` hold separate locks ([COLD.md](COLD.md#locks)) and run side by side. They act on
different partitions: `push` reads the archives only for partitions the record does not hold at the
catalog's version — new ones, and changed ones whose tar is being corrected — and `evict` removes
only partitions in a stored tar at the catalog's version with no change noted, and looks at the
catalog and the record again right before each venue's removal. Both write the record, and SQLite
keeps those writes apart.

---

## `cold pull archives`

`cold pull archives <venues…>` brings back from cold storage what is asked for, as every pull is
asked ([COLD.md](COLD.md#what-a-pull-is-asked-for)): a venue, and `--dataset` or `--partition`, with
`--date`.

| | |
|---|---|
| `-f`, `--force` | bring back what is on disk already too, over it, without asking |
| `--prefer-monthly`, `--prefer-daily` | which grain, where a month is stored at more than one |
| `--prefer-bundled`, `--prefer-not-bundled` | which bundle, where a month is stored both as a market's file and as a file per instrument |
| `--instruments`, `-o`, `--keep-snapshot`, `--drop-snapshot` | ignored: they are [the vault's](COLD-VAULT.md#cold-pull-vault) and [the catalog's](COLD-CATALOG.md#cold-pull-catalog) |
| `-y`, `-a` | see [COLD.md](COLD.md#options-given-at-the-cold-level); `-w` is not read |

**The same data is often stored in more than one rendering**, and every one of them is meant unless
one is preferred. A preference is not a filter: where the rendering preferred is not stored, what is
stored is taken, so nobody has to look first at how each month was published. One grain and one
bundle may be preferred, never two of a kind.

```
./tools cold pull archives gate --partition spot/klines,1h --date 202003 --dry-run
./tools cold pull archives binance --dataset trades --prefer-monthly
```

### What comes back

**Whatever cold storage holds of what was asked for is what is meant** — whether it was ever taken
off the disk or not. Each stored partition is set against the catalog's version of it and against
the disk, and that decides what is done with it:

| It is | Meaning | What happens |
|---|---|---|
| not on disk | no file of it is there | brought back; nothing is asked |
| on disk, differing | files of it are there, at another count or size than was stored | asked, once for all of them: yes unless told otherwise |
| on disk as stored | the same version, count and size | asked, once for all of them: no unless told otherwise |
| of an older version | cold storage holds a version the catalog has moved on from | brought back beside the archives, never into them; nothing is asked |

**A question is asked once, however many partitions it is about.** `--yes` takes each question's own
answer — over what differs, and not again what is the same. `--force` brings back both, asking
nothing.

**An older version goes to `<cold>/pulled/archives/`**, under the paths it has in the archives, and
the run says so as it ends. It is something to look at: nothing downstream reads there.

### How a partition comes back

1. **Its tar is downloaded whole**, to `<cold>/pulling/archives/`. A tar holds the partitions that
   were packed together, and Mega gives all of it or none.
2. **Only what was asked for is taken out**, into a directory beside the tar.
3. **Each file is moved into the archives**, over whatever is there. Nothing in the archives is
   removed: a file there that the tar does not hold stays where it is.
4. **The tar is dropped**, with everything else it held.

One tar at a time, so no more than one tar and what comes out of it is on disk beside the archives.
A tar already there at its stored size was brought by a run that stopped, and is used. One Mega
drops without delivering is asked for again; each is asked for three times at the most in all, and
the run ends by saying how many did not come back.

**A partition brought back into the archives is written down twice.** The record of its eviction,
where it has one, is marked with when it came back and kept as history; and it is written down as
pulled, so `evict` leaves it on disk until it is asked to take it
([`--include-pulled`](#what-a-pull-brought-back-stays)). An older version brought beside the
archives is neither.

### Space

**Watched, not promised.** What the tars weigh is said against what is free before anything starts,
as a warning and no more — most of a tar is usually dropped, so the sum is the worst case and rarely
the truth. No tar is asked for while less than 25 GB is free on cold's own volume: the run waits
there until there is room. Where the archives are on another volume, it also waits until they have
room for what comes out of the next tar, and 25 GB more.

---

## `cold stats archives`

Venue by venue, from the record alone: the months its tars span, how many of its tars are stored
of how many the record has, how many partitions they hold, and what the stored tars weigh; then the
same summed over every venue.
