# cold and the vault

How `./tools cold` stores the vault, takes it off the local disk and brings it back. What every cold
command shares — configuration, where things live, locks, the record, how Mega is trusted,
watching — is in [COLD.md](COLD.md). The archives are handled differently throughout: see
[COLD-PUSH.md](COLD-PUSH.md), [COLD-EVICT.md](COLD-EVICT.md) and [COLD-PULL.md](COLD-PULL.md).

**The vault is the tree that is moved in and out as a matter of routine.** It is read on a machine
smaller than its data: what is being worked on is on disk, the rest is in cold storage, and which is
which changes with the work. So any part of it can be brought back without the rest.

## Stored as it is

**Nothing is packed.** A vault partition is one file for a month stored whole (`@`), or a file per
instrument for a month stored split. Its files are sent to Mega as they are, and what comes back is
exactly the files that are wanted.

**A partition is what is stored; a file is what is moved.** `push` works a partition at a time: a
partition is in cold storage once every file of it is, and not before. `evict` and `pull` work a file
at a time, so a split month's instruments can leave and return one by one.

### Where a file is in Mega

```
<MEGA_ROOT>/vault/<venue>/<market>/<dataset>[,<variant>…]/<@ or instrument>/<YYYYMM>[.pre|.post].parquet
```

**A file's path says what it holds, and nothing of which revision it is.** Every revision of a file
is stored at the same path. Which revision cold storage holds of a partition is in the record, read
off the vault's ledger.

**The variants, without their names.** In the vault a directory is `interval=1h`; in Mega the
variants are joined to the dataset as the catalog writes them — `klines,1h`, `trades,aggregated`,
and plain `trades` for the vault's `aggregated=false` — so every file sits at the same depth whatever
its dataset has. A file's place in Mega is not recorded: it follows from its path in the vault.

## What cold reads of the ledger

The ledger and its marks are [STOCKER.md](../services/STOCKER.md#the-ledger)'s. Cold goes by the
last line the ledger has for each partition: a partition whose last line says `updating` or
`outdated` is not stocked, and is not stored, evicted or pulled.

**Nothing goes by the vault's account while it reports a loss.** Where `<vault>/ERROR.log` has
anything in it, or there is no `<vault>/ledger.csv`, `push`, `evict` and `pull` of the vault say so
and end with a failure.

## `cold push vault`

Stores every partition the ledger holds that cold storage does not have at that revision.

1. **Read the ledger.** Each partition, at the revision its last line gives, is looked up in the
   record; one already stored at that revision is done.
2. **Find its files.** They are found on disk and measured once: what they weigh is what Mega has to
   hold for them to count. A partition the vault does not hold as its ledger says — fewer files than
   the line counts, or no file of the month's own — is left out, and the run says how many.
3. **Hand them to Mega.** Files go to Mega's own upload queue, which outlives the command. Nothing
   more is handed over while the queue holds `COLD_QUEUE_TARGET_GB` or more, or cannot be read.
4. **Confirm from Mega's listing**, as [COLD.md](COLD.md#how-mega-is-trusted) sets out: a file is
   stored when Mega lists it at the size and modification time of the file on disk, and only after
   this run handed it over. One that left the queue without arriving is handed over again.
5. **A partition is stored when its last file is**, and a line is then added to `backedup.csv` (see
   [below](#backedupcsv)).

The run says what it found and asks to go ahead; yes is the answer.

**A partition stocked again is stored again, every file of it.** Which of its files changed is not
known and is not asked: all of them are handed to Mega. Once every file is confirmed, the earlier
revision is dropped from the record, and a file it had that the new one has not — an instrument the
month no longer holds — is removed from Mega. One that cannot be removed is said, and tried again
when the partition is next stored.

**A file no longer in the vault** is forgotten with its revision, and its partition left for the
next look at the ledger — unless cold storage has held a file of that revision: then the record
may name the only copy, so it is said and left as the record has it.

**What was stored is looked at once more** once everything found has been sent, since a file can be
handed over twice and stored under another handle; see [COLD.md](COLD.md#how-mega-is-trusted).

With `-w` it reads the ledger again every 30 minutes for what has been stocked since; a look while
the vault reports a loss plans nothing. See [COLD.md](COLD.md#watching).

### `backedup.csv`

**The one file cold writes into the vault**, at its root, beside the ledger. It says which
partitions have a safe copy in cold storage, and at which revision.

```
partition|revision|date
venue=htx/market=spot/dataset=klines/interval=1h/202010|3f2a9c0d1b7e|2026-11-02T14:05:31.204Z
```

- **Fields are separated by `|`**, under a heading written when the file is created: the partition
  as the ledger names it, the revision stored, and when the line was written, as an ISO 8601 UTC
  time.
- **Only ever appended to.** The file is never rewritten, and a partition has a line for every
  revision of it that was stored.
- **A line is written when a partition is stored**, and also where the record has a partition stored
  at the ledger's revision and the file has no line for it — a run stopped in between.
- **A line promises that every file of that revision is in Mega**, so whatever of the partition is
  on disk from then on — all of its files, some of them, or none — is no loss.

Moving files out and back writes nothing into the vault: which files are away at any moment is in
cold's own record. A copy of `backedup.csv` is kept in Mega with the ledger; see
[COLD.md](COLD.md#colds-own-files-are-kept-in-mega-too).

## `cold evict vault`

Takes vault files off the local disk, to make room. It removes what a [selection](#selecting-part-of-the-vault)
means and nothing outside it; with nothing to narrow it, everything cold storage holds.

**A file can go once its partition is in cold storage at the revision the ledger has.** A file of a
partition still on its way, or stocked again since it was stored, stays. The decision is made from
the ledger and the record; the disk is not looked at. The ledger is read again, where it has
changed, as each partition's turn comes, so a partition stocked again in the meantime is left where
it is.

**A partition that is about to be completed stays.** One stocked without the hours a neighbouring
month holds of it, whose neighbour's archives are on disk now, is not evicted whatever the selection
says, and the run says how many it kept: those hours are added beside the partition's own files,
which have to be on disk for it.

What would go is said venue by venue, and then asked; yes is the answer. Files go to the host's trash
unless `--purge` deletes them outright ([COLD-EVICT.md](COLD-EVICT.md#files-go-to-the-trash)), and an
instrument's directory left empty is removed. `-n`, `--dry-run` says what would go.

## `cold pull vault`

Brings files back, each to the place in the vault it was taken from. It is asked for as every pull
is — a venue, and `--dataset` or `--partition`, with `--date`
([COLD-PULL.md](COLD-PULL.md#what-is-asked-for)) — and takes `--instruments` besides.

- **Only what is away**, and only of the revision the ledger still has: a file of a revision the
  vault has since restocked is not brought back.
- **Not started without room**: what is asked for has to fit on the vault's volume with 5 GB to
  spare. What would come is said first, and then asked; yes is the answer.
- **Asked of Mega all at once**, to its download queue. A run stopped here leaves them coming, and
  the next run finds them arrived.
- **Confirmed from the disk**: a file is back when it is there at the size it was stored at and Mega
  is no longer downloading it. One already there at that size is written down as back. One Mega
  drops without delivering is asked for again; each is asked for three times at the most in all.
  The run ends by saying how many did not come back.

`-n`, `--dry-run` says what would come back.

## Selecting part of the vault

What `evict vault` takes. Each narrows; one left out means any. `pull vault` takes `--instruments`
from here and names the rest its own way.

| | |
|---|---|
| `[venues…]` | after the origin, as everywhere in `cold` |
| `--market` | `spot`, `perp`, … |
| `--dataset` | `trades`, `klines`, … |
| `--variant` | a variant as the catalog names it: a kline's interval, funding's kind, `aggregated` |
| `--from`, `--to` | `YYYYMM`, or `YYYY` for that year's first or last month; both ends included |
| `--instruments` | instruments by name, comma-separated |

**Instruments select files where a month has a file per instrument, and behave differently where it
does not.** A month stored whole is one file holding every instrument:

- `evict --instruments` leaves that file alone. Taking it away for the sake of one instrument would
  take the rest with it.
- `pull --instruments` brings that file back. The instrument's rows are nowhere else.

```
./tools cold evict vault htx --dataset trades --to 202212
./tools cold pull vault bybit --partition perp/klines,1m/2023
./tools cold pull vault binance --dataset trades --instruments BTCUSDT,ETHUSDT --date 2024
```

## `cold stats vault`

Venue by venue: the months the ledger spans, how many of its partitions are stored, how many files
and bytes that is, and how much of it is away from the disk now.
