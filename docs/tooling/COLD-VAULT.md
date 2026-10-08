# cold and the vault

How `tools cold` stores the vault, moves it off the local disk and brings it back. See
[COLD.md](COLD.md) for the namespace, and [COLD-PUSH.md](COLD-PUSH.md) and
[COLD-EVICT.md](COLD-EVICT.md) for the archives, which are handled differently throughout.

**The vault is the one tree that is moved in and out as a matter of routine.** The archives leave the
disk once and come back on a rainy day. The vault is what everything downstream reads, on a machine
smaller than its data: what is being worked on is here, the rest is in cold storage, and which is
which changes with the work. So what matters is that any part of it can be brought back without the
rest.

## Stored as it is

**Nothing is packed.** A vault partition is already what a tar would be made to be: one compressed
file for a small month, a file per instrument for a large one. Its files are sent to Mega as they
are, and what is brought back later is exactly the files that are wanted.

**A partition is what is stored; a file is what is moved.** `push` works a partition at a time: a
partition is in cold storage once every file of it is, and not before. `evict` and `pull` work a
file at a time, since a large month's instruments can leave and return one by one.

### Where a file is in Mega

```
<MEGA_ROOT>/vault/<venue>/<market>/<dataset>[,<variant>…]/<@ or instrument>/<YYYYMM>[.pre|.post].parquet
```

**A file's path says what it holds, and nothing of which revision it is.** That is how the vault
names its files, and they are stored under the names they have. The revision a partition is stored
at is in the record, read off the vault's ledger.

**The catalog's variants, without the names.** In the vault a directory is `interval=1h` because a
query engine reads it back as a column. In cold storage nothing reads it, so the names are dropped, and
the variants are joined to the dataset as the catalog writes them — `klines,1h`, `trades,aggregated`,
and plain `trades` for the vault's `aggregated=false` — which puts every file at the same depth whatever its dataset
has. `@` holds a month stored whole, as it does in the vault.

## `cold push vault`

Stores every partition the vault's ledger holds that cold storage does not have at that revision.

1. **Read the ledger.** Each partition it lists, at the revision it lists, is looked up in the
   record. One already stored is done. One the ledger says is `updating` — its files are being
   changed — or `outdated` — its files are of an older making, waiting to be stocked again — is
   not listed at all.
2. **Find its files.** They are found on disk and measured once: what they weigh is what Mega has to
   hold for them to count. A partition the vault does not hold as its ledger says is left out and
   counted.
3. **Hand them to Mega.** Files go to Mega's own queue, which sends them one at a time and outlives
   the command. No more is handed over than `COLD_QUEUE_TARGET_GB` waiting.
4. **Confirm from Mega's listing.** A file is stored when it has been handed over, has left Mega's
   queue, and Mega lists it at the size it has on disk — never on an exit code. One that left the
   queue without arriving is handed over again. A file is never taken as stored before it is handed
   over: every revision of it sits at one path, so what Mega holds there beforehand may be the
   month this one replaces.
5. **A partition is stored when its last file is**, and is then written into the vault's
   `backedup.csv` — see below.

**A partition stocked again is stored again, every file of it.** Which of its files changed is not
known and is not asked: all of them are handed to Mega, which takes a file it already holds
unchanged without sending it again. A month that was only given a neighbouring month's hours is one
such: its own files go through untouched and the new one is sent. Once every file is confirmed, the
earlier revision is dropped from the record, and a file it had that the new one has not — an
instrument the month no longer holds — is removed from Mega.

**Nothing is stored while the vault reports a loss.** The ledger is what says what there is to
store, and `ERROR.log` in the vault says it was found wrong. That holds for `evict` and `pull` too.

With `--watch` it looks at the ledger again every 30 minutes for what has been stocked since.

### A second look at what was just stored

**A file is written down as stored the moment Mega shows it**, with the identifier Mega gave it
then. That can be overtaken. Mega is slow to show a transfer it has accepted, and for a moment after
one finishes it is in neither the queue nor the listing — so a file can be handed over twice, and
is then stored twice, the second replacing the first under another identifier.

Handing over twice is harmless: Mega recognises the same bytes and sends nothing again. What it
leaves is a record naming an identifier that is no longer the current one. So:

- **Each round begins by taking second transfers of the same file out of the queue.** The one being
  sent is kept, else the first asked for. Only what this command queued is looked at: the queue is
  shared with whatever else is uploading.
- **Once everything found has been sent, what was stored since the last such look is asked of Mega
  again.** Another identifier at the size sent is written down. Another size, or nothing there, is
  written down as not stored, and the run sends it again before it rests.

### `backedup.csv`

**The one thing cold writes into the vault.** A line when a partition is stored — partition,
revision, date — at the vault's root. It tells whoever stocks the vault that a safe copy of that
revision exists, so that whatever of the partition is on disk from then on is no loss: all of its
files, some of them, or none.

That is why moving files out and back writes nothing into the vault at all. Which files are away at
any moment is cold's own record.

## `cold evict vault`

Takes vault files off the local disk, to make room. It removes what a selection means and nothing
outside it — and with nothing to narrow it, everything cold storage holds. While nothing is reading
the vault, all of it can go and make room for more to be stocked; once something is, what is being
worked on stays and the rest goes.

**A file can go once its partition is in cold storage at the revision the ledger has.** A file of a
partition still on its way, or stocked again since it was stored, stays. Nothing on disk is looked
at to decide. The ledger is read again as each partition's turn comes, since a file's path does not
say which revision it is of: one stocked again in the meantime is left where it is.

Files go to the host's trash by default and `--purge` deletes outright, as for the archives
([COLD-EVICT.md](COLD-EVICT.md#files-go-to-the-trash)). `--dry-run` says what would go.

**A partition that is about to be completed stays on disk.** One stocked without the hours a
neighbouring month holds of it, whose neighbour's archives are on disk now, is not evicted whatever
the selection says, and the run says how many it kept: whoever stocks the vault adds those hours
beside the partition's own files, and needs them here to do it.

## `cold pull vault`

Brings files back, each to the place in the vault it was taken from. It is `evict`'s other half,
and asked for as every pull is: a venue, and a dataset or a partition of it — see
[COLD-PULL.md](COLD-PULL.md#what-is-asked-for) — with `--instruments` besides.

- **Only what is away**, and only of the revision the ledger still has: a file of a revision the
  vault has since restocked is not brought back.
- **Asked of Mega all at once**, to its own queue. A run stopped here leaves them coming, and the
  next run finds them arrived.
- **Confirmed from the disk**: a file is back when it is there at the size it was stored at and Mega
  is no longer writing it. One already there at that size is simply written down as back. One Mega
  drops without delivering is asked for again, three times at the most.
- **Not started without room**: what is asked for has to fit on the vault's volume with 5 GB to
  spare.

## Selecting part of the vault

What `evict` takes. Each narrows; one left out means any. `pull` takes `--instruments` from here
and names the rest its own way.

| | |
|---|---|
| `[venues…]` | after the origin, as everywhere in `cold` |
| `--market` | `spot`, `perp`, … |
| `--dataset` | `trades`, `klines`, … |
| `--variant` | a dataset's flavour as the vault's path has it: a kline's interval, funding's kind |
| `--from`, `--to` | months, `YYYYMM`, both ends included |
| `--instruments` | instruments by name, comma-separated |

**Instruments select files where a month has a file per instrument, and behave differently where it
does not.** A small month is one file holding every instrument:

- `evict --instruments` leaves that file alone. Taking it away for the sake of one instrument would
  take the rest with it.
- `pull --instruments` brings that file back. The instrument's rows are nowhere else.

```
tools cold evict vault htx --dataset trades --to 202212
tools cold pull vault bybit --partition perp/klines,1m/2023
tools cold pull vault binance --dataset trades --instruments BTCUSDT,ETHUSDT --date 2024
```

## `cold stats vault`

Venue by venue: how many of the ledger's partitions are stored, how many files and bytes that is,
and how much of it is away from the disk right now.

## The record

| | |
|---|---|
| `vault_file` | a file of the vault on its way to cold storage or in it: partition, revision, instrument, where it is, what it weighs, Mega's handle, and since when it has been away from the disk |
| `vault_partition` | a partition every file of which is stored, at that revision |
| `vault_move` | each time a file was taken off the disk or brought back |

A file's place in Mega is not recorded: it follows from what the file is.
