# The BitMEX data

What was collected from BitMEX before it closed, and how to read it.

**BitMEX is gone and its data is not.** The venue closed in September 2026. Nothing collects from it
and nothing can be asked of it again, so what is described here is all there will ever be. The
files are in cold storage.

**It is raw.** These are the files as the collectors wrote them, in BitMEX's own tables and
columns. They are not in the Parquet vault.

---

## Where it came from

Four sources, each for what the one before it could not give:

| source | tables | from |
|---|---|---|
| **BitMEX's S3 dumps** — a gzip a day | `trade`, `quote` | 2014-11-22 |
| **BitMEX's REST API** | `funding`, `insurance`, `settlement`, `compositeIndex`, `tick`; the bins `tradeBin1m`, `5m`, `1h`, `1d` and `quoteBin1m`, `5m`, `1h`, `1d` | each table's first row; the bins from 2014-11-22 |
| | `trade`, `quote` | 2026-04-16 and 2026-04-14 on: the days the S3 dumps came without the pool |
| **The live websocket** | `announcement`, `chat`, `connected`, `instrument`, `liquidation`, `orderBookL2`, `publicNotifications` | 2026-03-08 for the order book |
| **Tardis's free samples** — the first day of each month | the same seven websocket tables | 2019-04-01 |

- **The seven websocket tables exist nowhere else.** No dump and no REST endpoint carried them, which
  is why they start when listening did, with one sampled day a month before that.
- **`tick` is `trade` for the indices**: the prints of size 0 on symbols that begin with a dot.
  They were kept out of `trade` and filed as a table of their own, from the websocket as from REST.
- **What REST collected and how** is in [SCRIBE.md](../../services/.deprecated/scribe/SCRIBE.md);
  the Tardis samples in [TARDY.md](../../services/.deprecated/tardy/TARDY.md).

## How it is laid out

```
<table>/<yyyy>/<yyyymmdd>.csv.gz
```

- **A file is a day of a table**, gzip-compressed CSV, its first row the header. The columns of each
  table are in [TABLES.md](TABLES.md).
- **A day is the UTC day of the event**, not of its reception — see below.
- **A name with a second part, `<yyyymmdd>.<suffix>.csv.gz`, is a source and not the day's file**: one
  collector's copy of that day (`.s3` for a dump, and a collector's own tag for the websocket), kept
  beside the file that was made from them.
- **A dotted table is a slice of the table before the dot**: `orderBookL2.secondary` is the order
  book of the Secondary pool, with `orderBookL2` holding the Primary one.

The store that wrote this layout is the vault service: [VAULT.md](../services/VAULT.md).

## How to read a file

**A websocket table is a log of messages, not a table of rows.** Each message is its action —
`partial`, `insert`, `update`, `delete` — and the rows it carried, and the state of the table at any
moment is what those actions add up to. A `partial` is the whole state as it then stood; the others
change it. An `update` carries only the columns that changed.

- **`_date_` is on the first row of a message and empty on the rest.** A non-empty `_date_` starts
  a new message. It is the time the message was received.
- **`timestamp` is BitMEX's own time for the event**, and the one to order by.

**The other tables are plain rows**, one a record.

**Liquidity pools.** BitMEX ran more than one pool.

- `trade` and `quote` carry every pool in one file, told apart by the `pool` column: `Primary` or
  `Secondary`. The S3 dumps from before pools existed have no value there.
- `orderBookL2` is one table a pool, since the two pools came over two subscriptions.
- **The bins are the Primary pool's**, throughout. Left unpinned, BitMEX's bins change from
  `Primary` to `Aggregated` on 2026-03-04, and the aggregate cannot be taken apart again.

**A bin's `timestamp` is the end of its period.** The bar of 23:59–00:00 carries the next day's
midnight and is filed under that day.

**`compositeIndex` is ordered by `logged`**, the time BitMEX recorded a row, and not by `timestamp`.

## Which day a message is in

**A message is filed whole, under the day of its newest row.** The day is taken from the largest
`timestamp` among the rows of the message.

- A change — `insert`, `update`, `delete` — has one `timestamp` for all its rows, so that is its day.
- A `partial` is a snapshot whose rows each carry the time they last changed, which may be a day
  back or more. It is filed where its newest row is.
- **Three tables have no `timestamp`** — `connected`, `liquidation`, `publicNotifications` — and are
  filed by the day they were received. So is a message with no rows.

**Filing by the event's time keeps an event and its duplicates together**: the same event received
twice, or by two collectors, carries the same `timestamp` however late each copy arrived.

## What was done to it

For each table and day, the collectors' copies were merged into one sorted file with the duplicates
taken out. That file is the day's.

- **Duplicates came in over the websocket.** On some days `instrument` and `orderBookL2` messages
  arrived more than once, as from a second, ghost subscription. What that looked like, how it was
  told from a real repetition, and what was removed is in
  [DEDUP_COMPARISON.md](DEDUP_COMPARISON.md) and [dedup_validation_2026.md](dedup_validation_2026.md).
- **The tool that did it is kept, not running**, with its documentation — merging, removing
  duplicates, re-sorting, re-filing by the event's day, salvaging broken gzips:
  `dev/tooling/.deprecated/data/docs/`.
