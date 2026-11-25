# cold audit

`cold audit [origin]` checks that Mega, the local disk and the record all say the same thing, and
offers to put right what does not. See [COLD.md](COLD.md) for the namespace, origins and the record.

**Everything else in the family trusts the record.** `push` decides what to send from it, `evict`
what may be removed, `pull` what can come back, and none of them looks at the world again on every
run. This is where that trust is earned back: run now and then, or whenever something looks off.

| | |
|---|---|
| `[origin]` | `archives`, `vault`, or `all` |
| `-n`, `--dry-run` | say what was found, and do nothing about it |

`audit` takes no lock, and runs beside any other command ([COLD.md](COLD.md#locks)).

---

## How a finding is handled

**A finding is one kind of thing wrong, however often it was found**: what it is, the first five
places, anything worth knowing before choosing, and what can be done about all of them at once. It
is asked about once.

- **One thing to do** is a yes or a no.
- **Several** are a list, with leaving it as it is at the end.
- **What is offered first is what is done where nobody is asked** — under `--yes` — unless it is
  marked **never unasked** below: then the finding is said and left. Such a fix removes something,
  or gives up the only copy of something, and is never what pressing return picks either.

**What is put right is nearly always the record.** Mega and the disk are how things are; the record
is what was believed, and it is brought round to them. Each such change is one the next `push`,
`evict` or `pull` then acts on in the ordinary way.

**A fix is applied only to what is still as it was found.** An answer can be long in coming, and
another command can start meanwhile: a tar that has changed state or handle since is left as it is,
and a fix in staging or of what a pull left behind does nothing once another command is running.

**Mega not answering leaves out what needs it**, and the run says so. The rest is still checked.

### What is removed, and where it goes

- **Files of the trees** — a vault file or an archives partition taken off the disk again — go to
  the host's trash, as `evict`'s do ([COLD-EVICT.md](COLD-EVICT.md#files-go-to-the-trash)).
- **Cold's own files** — tars in staging, what a pull left behind, a lock whose holder is gone — are
  deleted outright.
- **Objects in Mega** the record has never heard of are removed from Mega.

## What is checked

| | `archives` | `vault` |
|---|---|---|
| [the record against Mega](#the-record-against-mega) | yes | yes |
| [the record against the disk](#the-record-against-the-disk) | yes | yes |
| [the record against itself](#the-record-against-itself) | locks | locks, partitions, `backedup.csv` |
| [what is left in staging](#what-is-left-in-staging) | yes | — |
| [what each stored tar weighs](#what-each-stored-tar-weighs) | yes | — |

### The record against Mega

Mega is asked once for the whole tree, for every object's size and its own handle.

| Found | Offered | |
|---|---|---|
| a tar or vault file written down as stored that is not there | write it down as not stored, so the next push sends it again | **never unasked** where any of it is no longer on disk: for that, cold storage was the only copy |
| one that is not the size that was sent | the same | the same |
| one under another handle than the one written down, at the right size | write down the handle Mega has now | the same object sent again, or moved within Mega |
| a tar or vault file in Mega the record has never heard of | remove it from Mega — **never unasked** | a tar a replanning left behind, an instrument a restocked month no longer has; or what a lost record no longer knows |

Several revisions of a vault file are one path in Mega, so a file there is right where it is any of
the revisions written down as stored.

**Mega answering with nothing at all**, while the record has something stored there, is taken for a
wrong `MEGA_ROOT` or another account rather than a tree that is gone: it is said, and nothing is
offered.

### The record against the disk

`evict` and `pull` go by what the record says of the disk, and one that is wrong about it makes
them offer the wrong things. **What is on disk again is offered for removal only where cold storage
holds it as it is.**

| Found | Offered |
|---|---|
| a vault file of the ledger's current revision, written down as taken off the disk, that is on it at the size stored | write it down as back; or remove it again — **never unasked** |
| a vault file of the ledger's current revision, written down as on the disk, that is not there | write it down as taken off the disk; `cold pull vault` brings it back |
| a partition of the archives written down as taken off the disk that has files on it, where cold storage holds it as `evict --cleanup` would take it | write it down as back; or remove its files again — **never unasked** |
| a partition of the archives written down as taken off the disk that has files on it, any other | write it down as back |

**`evict --cleanup`'s rule** is that the partition is stored at the version the catalog has now,
with no change noted, stocked, needed by no neighbouring month, and was evicted at that same
version ([COLD-EVICT.md](COLD-EVICT.md#what-was-evicted-and-is-on-disk-again)). A partition outside
it may have files newer than cold storage's copy, which the next push needs, so it is only written
down as back. Where the catalog does not answer within 15 seconds, every such partition is taken as
outside it.

Only vault files of the revision the ledger has now are looked at: one of an older revision is the
vault's to have replaced.

### The record against itself

| Found | Offered |
|---|---|
| a lock held by a run that is gone | remove it; a lock taken again since under the same name is left |
| a vault partition written down as whole in cold storage without every file stored | write it down as not whole, so the next push completes it |
| a vault partition of the ledger's current revision with every file stored that is not written down as whole — a push stored its last file and stopped | write it down as whole, add it to `backedup.csv`, and forget the revisions it replaces |
| a vault partition in cold storage at the ledger's current revision that `backedup.csv` does not list | add it ([COLD-VAULT.md](COLD-VAULT.md#backedupcsv)) |

Forgetting the revisions a partition replaces leaves any file only they had in Mega and not in the
record; the next audit finds it there.

### What is left in staging

The archives' tars wait in `<cold>/archives/` between being packed and being stored, and leave it
the moment Mega has them. Nothing here is looked at while another command is running: what is there
then is that command's, half way through.

| Found | Offered |
|---|---|
| a tar packed or queued that does not hold what the record says it was made with — a partition's files or bytes differ, or it holds one the record does not name | remove it, so the next push makes it again: packed from the disk, or, where Mega holds an older one, brought back and corrected |
| a tar still there after it was stored | remove it from staging |
| a tar the record has never heard of | remove it from staging — **never unasked** |
| files a pull of the archives that stopped left in `<cold>/pulling/archives/` | remove them; a pull asks Mega again |

**This is the one place a tar is opened.** A stored tar cannot be read without bringing it back, so
what it holds is checked while it is still here. After that it can only be weighed.

### What each stored tar weighs

**A tar's size follows exactly from the names and sizes of its members**: a header a file, its
content padded to a block, a second header where the name is long, and the whole rounded up. So a
stored tar is weighed against the partitions the record says it holds.

| Found | Offered |
|---|---|
| a tar that is not, to the byte, the size its files make — every partition of it on disk as it was stored | write it down as not stored, so the next push packs and sends it again |
| a tar outside the size its partitions allow — some of them taken off the disk since, so only how many files they were and what they weighed is known | nothing: there is nothing to pack it again from. Bring it back and look |

The second is a range and not a figure, so a tar inside it is not proved right.

### The record's copy in Mega

Every command sets the record against its copy as it starts, except while another command is
running; an audit does it then too, unless `--dry-run`. See
[COLD.md](COLD.md#colds-own-files-are-kept-in-mega-too).

## Adding a check

A check takes what there is to look at — the record, the configuration, the tree, Mega where it
answers — and returns findings. It lives in `audit/checks/` and is listed in `audit/index.ts`.
