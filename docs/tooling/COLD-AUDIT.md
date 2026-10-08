# cold audit

`cold audit [origin]` checks that Mega, the local disk and the record all say the same thing, and
offers to put right what does not. See [COLD.md](COLD.md) for the namespace and origins.

**Everything else in the family trusts the record.** `push` decides what to send from it, `evict`
what may be removed, `pull` what can come back, and none of them looks at the world again on every
run. This is where that trust is earned back: run now and then, or whenever something looks off.

| | |
|---|---|
| `[origin]` | `archives`, `vault`, or `all` |
| `-n`, `--dry-run` | say what was found, and do nothing about it |

---

## How a finding is handled

**A finding is one kind of thing wrong, however often it was found**: what it is, the first few
places, anything worth knowing before choosing, and what can be done about all of them at once. It
is asked about once.

- **One thing to do** is a yes or a no.
- **Several** are a list, with leaving it as it is at the end.
- **What is offered first is what is done where nobody is asked** — under `--yes` — unless it removes
  something written down nowhere else. That is never done unasked: under `--yes` such a finding is
  said and left.

**What is put right is nearly always the record.** Mega and the disk are how things are; the record
is what was believed, and it is brought round to them. Each such change is one the next `push`,
`evict` or `pull` then acts on in the ordinary way.

**Mega not answering leaves out what needs it**, and the run says so. The rest is still checked.

## What is checked

### The record against Mega

Mega is asked once for the whole tree, for every object's size and its own identifier.

| Found | Offered | |
|---|---|---|
| a tar or vault file written down as stored that is not there | write it down as not stored, so the next push sends it again | says how many of them are no longer on disk — for those, cold storage was the only copy |
| one that is not the size that was sent | the same | the same |
| one under another identifier than the one written down, at the right size | write down the identifier Mega has now | the same object sent again, or moved within Mega |
| a tar or vault file in Mega the record has never heard of | remove it from Mega — **never unasked** | a tar a replanning left behind, an instrument a restocked month no longer has; or what a lost record no longer knows |

Several revisions of a vault file are one path in Mega, so a file there is right where it is any of
the revisions written down as stored.

### The record against the disk

Nothing here is a loss — cold storage holds all of it either way — but `evict` and `pull` go by what
the record says of the disk.

| Found | Offered |
|---|---|
| a vault file written down as taken off the disk that is on it, at the size stored | write it down as back; or remove it again — **never unasked** |
| a vault file written down as on the disk that is not there | write it down as taken off the disk |
| a partition of the archives written down as taken off the disk that has files on it | write it down as back; or remove its files again — **never unasked** |

Only vault files of the revision the ledger has now are looked at: one of an older revision is the
vault's to have replaced.

### The record against itself

| Found | Offered |
|---|---|
| a lock held by a run that is gone | remove it |
| a vault partition written down as whole in cold storage without every file stored | write it down as not whole, so the next push completes it |
| a vault partition with every file stored that is not written down as whole — a push stored its last file and stopped | write it down as whole, tell the vault it has a copy, and forget the revisions it replaces |
| a vault partition in cold storage that the vault's `backedup.csv` does not list | add it — until then whoever stocks the vault takes a missing file of it for a loss |

### What is left in staging

The archives' tars wait in cold's own directory between being packed and being stored, and leave it
the moment Mega has them. Nothing here is looked at while another command is running: what is there
then is that command's, half way through.

| Found | Offered |
|---|---|
| a tar on its way that does not hold what the record says — a partition's files or bytes differ, or it holds one the record does not name | remove it and write it down as not packed, so the next push packs it again |
| a tar still there after it was stored | remove it from staging |
| a tar the record has never heard of | remove it from staging — **never unasked** |
| files a pull that stopped left behind | remove them |

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

Looked at as every command starts — see [COLD.md](COLD.md#colds-own-files-are-kept-in-mega-too) —
except while another command is running. An audit looks at it then too, and offers to send it.

## Adding a check

A check takes what there is to look at — the record, the configuration, the tree, Mega where it
answers — and returns findings. It lives in `audit/checks/` and is listed in `audit/index.ts`.
Whatever is thought of later that does not belong in another command's own checks goes here.

What the command it replaces looked for, and has not been rebuilt — months with a gap between them
— is in `dev/tooling/src/tools/cold/legacy/audit.ts`.
