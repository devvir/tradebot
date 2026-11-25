# The BitMEX data

What this repo collected from BitMEX before the venue closed, and how to read it. This is a dataset,
not a venue reference.

**BitMEX is gone and its data is not.** The venue closed on 2026-09-23. Nothing collects from it and
nothing can be asked of it again, so what is described here is all there will ever be. The files are
in cold storage.

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
- **The REST collector and the Tardis downloader are kept, not run,** under `services/.deprecated/`:
  what REST collected and how is in [SCRIBE.md](../../services/.deprecated/scribe/SCRIBE.md), the
  Tardis samples in [TARDY.md](../../services/.deprecated/tardy/TARDY.md).

## How it is laid out

```
<table>/<yyyy>/<yyyymmdd>.csv.gz
```

- **A file is a day of a table**, gzip-compressed CSV, its first row the header. The columns of each
  table are in [TABLES.md](TABLES.md).
- **A day is the UTC day of the event**, not of its reception — see below.
- **A name with a second part, `<yyyymmdd>.<suffix>.csv.gz`, is a source and not the day's file**: one
  collector's copy of that day, kept beside the file that was made from it. The suffixes are listed
  below.
- **A dotted table holds part of the table before the dot**, in a directory of its own:
  `orderBookL2.secondary` is the order book of the Secondary pool, with `orderBookL2` holding the
  Primary one.

The store that wrote this layout is the vault service: [VAULT.md](../services/VAULT.md).

### Source suffixes

| suffix | the copy of the day it holds |
|---|---|
| `.s3` | a BitMEX S3 dump of `trade` or `quote`, rows in BitMEX's order (by symbol, then time); the day's file is the same rows ordered by time |
| `.local` | the websocket tables as captured by the collector on the main workstation |
| `.antel` | the websocket tables as captured by a collector on the dedicated machine `antel`, from 2026-04-10 |
| `.mtav` | the websocket tables from a further capture, named `mtav` |
| `.tardis` | a Tardis free sample: the first day of a month of the websocket tables |
| `.prepared` | an earlier merge of a day's websocket sources, standing in for them where they were lost (`instrument` on 2026-05-06) |
| `.mongo` | rows read back from a MongoDB copy of the data (`orderBookL2` on 2026-04-09 and 2026-04-10) |

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

For each table and day, the sources were merged into one file ordered by time, with the duplicates
taken out. That file is the day's.

- **Duplicates came in over the websocket**, as from a second, ghost subscription: `instrument` and
  `orderBookL2` messages arriving more than once, worst on 2026-04-08, 04-19, 04-20 and 05-14.
- **Over 2026's `instrument` sources, about 1.6% of about 1.06 billion messages were removed**, almost
  all of them on those days. The Tardis samples and the `.prepared` day had none to remove.
- **`orderBookL2` lost every repeat of a message's content.** An `instrument` value can really flip
  back and forth within a few hundred milliseconds, so there repeats under 500 ms apart were kept,
  except on the days whose ghost copies arrived with no gap at all.
- **The tool that did it is kept, not running**, with its documentation and the working logs of those
  runs, in [dev/tooling/.deprecated/data/docs/](../../dev/tooling/.deprecated/data/docs/DATA-DEDUP.md).
