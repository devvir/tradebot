# cold pull

`cold pull [origin] <venues…>` brings back from cold storage. See [COLD.md](COLD.md) for the
namespace and origins, and [COLD-PUSH.md](COLD-PUSH.md) for how things got there.

This page is how a pull is asked for, and the **archives**. What the vault does with the same
request is in [COLD-VAULT.md](COLD-VAULT.md#cold-pull-vault).

---

## What is asked for

**A venue, and a dataset or a partition of it.** A venue alone is everything it ever published, and
is refused.

| | |
|---|---|
| `<venues…>` | after the origin, as everywhere in `cold`; at least one |
| `--dataset <dataset[,variant]>` | a dataset in every market: every variant of it, or the one named |
| `--partition <market[/dataset[,variant][/YYYY[MM]]]>` | a market, or as much of a partition of it as is given from the left |
| `--date <YYYY\|YYYYMM>` | only that year, or that month — not where the partition already names one |
| `-f`, `--force` | archives: bring back what is on disk already too, over it, without asking |
| `-n`, `--dry-run` | say how what is asked for stands, and bring nothing |
| `--prefer-monthly`, `--prefer-daily` | archives: which grain, where a month is stored at more than one |
| `--prefer-bundled`, `--prefer-not-bundled` | archives: which bundle, where a month is stored both as a market's file and as a file per instrument |

One of `--dataset` and `--partition` is required, and only one.

**The same data is often stored in more than one rendering**, and every one of them is meant unless
one is preferred. A preference is not a filter: where the rendering preferred is not stored, what is
stored is taken, so nobody has to look first at how each month was published. One grain and one
bundle may be preferred, never two of a kind. They are the archives' alone: the vault holds each
month one way, so they are an error with `pull vault`, and say nothing to the vault under
`--all-sources`.

```
tools cold pull archives bybit --dataset trades --date 2021
tools cold pull archives okx --partition perp/books,incremental,400/202309
tools cold pull archives gate --partition spot/klines,1h --date 202003 --dry-run
```

## The archives

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
drops without delivering is asked for again, three times at the most.

A partition brought back into the archives is no longer one that was evicted: the record of its
eviction is marked with when it came back and kept as history, and [`cold evict`](COLD-EVICT.md)
weighs the partition again like any other.

### Space

**Watched, not promised.** What the tars weigh is said against what is free before anything starts,
as a warning and no more — most of a tar is usually dropped, so the sum is the worst case and rarely
the truth. No tar is asked for while less than 25 GB is free: the run waits there until there is
room.

---

## `cold pull needed`

Brings back whatever the vault waits for. No venue, no dataset: what comes back is what a partition
is stuck without.

**Everything is meant to leave the disk in the end, and it leaves once it is stocked.** A partition
that cannot be stocked because what it is built from has left already is stuck, and holds its
neighbours on disk with it. Two things leave a partition so:

| the partition | what it waits for |
|---|---|
| is **outdated**: stocked, at a revision that is no longer what would be stocked | the archives it is stocked again from — its own, and those of a neighbouring month it read the edge of |
| **can be completed**: stocked without a neighbouring month's hours, whose archives are on disk now | its own vault files, which those hours are added beside |

Both are read off the vault's ledger, set against the disk, the catalog and the record. Whoever
stocks the vault does the rest by itself, as it finds the files there.

- **Any rendering of a month will do to stock from**, so a month is needed only where none of its
  renderings is on disk as the catalog has it. What is asked for then is the rendering it was
  stocked from, or failing that any that is stored.
- **Only what cold storage holds at the catalog's version.** A month it does not hold so is said,
  and left: it is to be downloaded from the venue, not brought back.
- **What it would bring is said first, with what it weighs, and then asked**; yes is the answer. A
  tar comes back whole, so the archives weigh what their tars do.
- **No more than there is room for.** Tars are taken oldest first for as long as each, and what
  comes out of it, leaves 25 GB free. The rest is said and left for a later run, when what was
  brought has been stocked and has gone again.

| | |
|---|---|
| `-n`, `--dry-run` | say what the vault waits for and what it weighs, and bring nothing |
| `-w`, `--watch` | look again at intervals, and bring what has come to be waited for since; asked before the first time and not again |

**Nothing else brings these files back.** Every command that reads the vault's ledger — pushing,
evicting or pulling the vault, evicting the archives — says where the vault waits for files in cold
storage, and names this command.
