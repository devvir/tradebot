# cold push

`cold push [origin] [venues…] [--lens [slug]]` stores every partition that is ready and not in cold
storage yet: it packs them into tars, uploads the tars to Mega, and records which partitions each
tar holds. See [COLD.md](COLD.md) for the namespace, origins and where things live.

**The link is the constraint.** Uploading is hours per tar while packing one is minutes, so this
does not pack everything and then upload it — that would fill the disk with tars waiting on a week
of bandwidth. It keeps just enough packed to keep Mega's queue fed.

Every step is resumable, because a run measured in days will be interrupted.

---

## What is ready

**A partition is ready when the catalog says nothing of it is left to download and that it is
settled.** That is asked of the catalog directly, venue by venue — the partitions endpoint, with
`downloaded=true` and `settled` — so nothing here decides what finished means. A partition a run is
still adding to can be complete at every moment and still be a fraction of itself, and only the
catalog knows which; what it takes as settled is in [CATALOG.md](../services/CATALOG.md).

`COLD_SETTLED_HOURS`, where set, asks for quiet on top: the request carries `settled-before` that
many hours ago, and a settled partition that changed since is left for a later run.

**Every partition the catalog holds, unless a lens is asked for.** `--lens <slug>` reads the catalog
through that lens; `--lens` with no value lists the catalog's lenses to pick one from. A lens only
narrows what this run considers: a partition stored on an earlier run and outside the lens today is
left exactly as it is.

**Venues after the origin narrow it further**: `cold push archives gate htx`.

---

## Planning

What the catalog answers is set against the record, one venue at a time:

- **A partition the record does not have** is planned into a new tar of its venue-month.
- **A tar planned and never made is dropped first.** The plan is redrawn on every run from what the
  catalog says is ready now, so a partition that was ready once and no longer is leaves the plan.
- **One it has at the same version** needs nothing.
- **One it has at another version** has changed since it was stored — see
  [a partition that changed](#a-partition-that-changed).

A plan is written before any tar exists, so a run that stops after planning finds the plan and
makes the tars, and one that stops before it plans again.

### Dividing a venue-month into tars

**A tar holds whole partitions and nothing less.** A partition is never cut, by instrument or by
anything else: one that weighs fifty gigabytes is a tar of fifty gigabytes.

The 5 GB cap is where a clean cut is looked for among the rest. Partitions are taken heaviest first,
each into the first tar of the month that still has room for it; one heavier than the cap gets a tar
of its own. That lands near the cap, and nothing downstream needs it to be exact.

**A month gains tars as more of it becomes ready.** Partitions that turn up on a later run — a slice
a lens did not let through before, a dataset discovered since — go into new tars numbered after the
month's last. Nothing already stored is repacked to make room.

Measured against the catalog on 2026-10-05: 2,006 ready partitions fell into 180 tars totalling
133 GB, the largest 5.00 GB.

---

## A tar's way into cold storage

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
comparison is removed.

**Confirmed from Mega, never from an exit code.** Mega publishes a file only once it is complete, so
the right size at the tar's path is the proof an upload finished. The handle Mega gives the object
is recorded with it, and the staging tar is deleted.

**Packing waits on the queue, not on any one upload.** No tar is made while Mega's upload queue
holds more than `COLD_QUEUE_TARGET_GB`. The queue is read whole, not filtered to this run's
transfers: there is one link, and anything already queued is in front of the next tar.

**One tar failing does not end the run.** It keeps its state and its turn comes round on the next
one; the run ends by saying how many were left behind.

---

### A second look at what was just stored

**A tar is written down as stored the moment Mega shows it**, with the identifier Mega gave it
then. That can be overtaken. Mega is slow to show a transfer it has accepted, and for a moment after
one finishes it is in neither the queue nor the listing — so a tar can be handed over twice, and
is then stored twice, the second replacing the first under another identifier.

Handing over twice is harmless: Mega recognises the same bytes and sends nothing again. What it
leaves is a record naming an identifier that is no longer the current one. So:

- **Each round begins by taking second transfers of the same tar out of the queue.** The one being
  sent is kept, else the first asked for. Only what this command queued is looked at: the queue is
  shared with whatever else is uploading.
- **Once everything found has been sent, what was stored since the last such look is asked of Mega
  again.** Another identifier at the size sent is written down. Another size, or nothing there, is
  written down as not stored, and the run sends it again before it rests.

## A partition that changed

A stored partition whose version in the catalog is no longer the one recorded has to be stored
again — and it shares its tar with others that have not changed. So the tar is corrected in place:

| state | what is true |
|---|---|
| `stale` | Mega holds the tar, and a partition in it is out of date |
| `fetching` | Mega is bringing the tar back |
| `fetched` | the tar is on disk again |

then the out-of-date partition's files are taken out of the tar and its current files put in, and
the tar is `packed` again and goes the ordinary way: queued, and stored under the same name, where
Mega keeps it as a new version of the same file.

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

---

## Watching

`--watch`, one of the options every `cold` command shares ([COLD.md](COLD.md)), keeps the run going once everything ready is stored, and asks the catalog again every 30
minutes. Each asking redraws the plan as a new run would, and whatever is newly ready joins the tars
already in hand. A tar that could not be moved on is tried again at each asking.

What an asking shows depends on what the run was doing:

| The run was | It shows |
|---|---|
| waiting, with nothing to push | the asking, and each venue's answer |
| packing or uploading | nothing, unless it found something: then one line saying how many partitions |

Between askings, a run with nothing to push says once that it is waiting. A catalog that does not
answer costs that asking and nothing else.

A run ends by saying which way it ended: that everything ready was pushed, or, when it is
interrupted, that it stopped and resumes on the next run.

## Environment

Read from `dev/tooling/.env`.

| variable | default | |
|---|---|---|
| `DATA_DIR` | — | the data root the rest hang off |
| `MEGA_ROOT` | — | where this project's trees live in Mega |
| `SOURCES_COLD_DIR` | `<DATA_DIR>/@cold` | staging tars, the locks, and the record |
| `DATA_ARCHIVES_DIR` | `<DATA_DIR>/archives` | the tree the `archives` origin backs up |
| `COLD_QUEUE_TARGET_GB` | `10` | GB still queued for upload before packing pauses |
| `COLD_SETTLED_HOURS` | _(none)_ | hours a settled partition must also have gone unchanged before it is stored |
| `CATALOG_URL` | `http://localhost:<port>` | where the catalog answers from this host |
| `CATALOG_TOKEN` | the catalog's own | sent to the catalog on every request |

**The catalog's address and token default to its own settings**, read from the module that deploys
it on this host, so neither is said a second time here.

The cap is **hardcoded rather than configured**, because it decides the shape of what lands in cold
storage and a value that drifted between runs would make that shape inconsistent for no benefit.
