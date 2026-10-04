# Stocker Service

Owns the vault — its only writer. The vault is the output of the whole collection system: every
venue and every source, normalised into one format per dataset, so consumers never have to care
which venue or source the data came from.

Stocker is **not an archives service**. Collection has three standard sources — archives, REST
and WS — and only archives is under development today; REST and WS files, and any further source
such as a third-party provider, are more formats to transform the same way. Raw is never
modified, moved or deleted.

## What it does

- Asks the catalog, through a lens, what every partition of the archives holds
- Stocks each partition that is fully downloaded, on disk as the catalog lists it, and not yet in
  the vault at its current version
- Decodes `.zip`, `.csv.gz`, `.tar.gz` and Excel-inside-zip; `.csv.gz` is handed to the query
  engine untouched, since it reads gzip natively
- Maps each format onto a **canonical table** with one schema across all venues, filling NULL
  where a venue publishes nothing
- Converts every timestamp to **int64 microseconds UTC**, inferring each value's unit
- Writes zstd Parquet, sorted by `ts`, one file per instrument, one directory per partition
- Keeps no records: a partition's version directory in the vault is the record
- Runs long-lived, sweeping on a timer so files that land unattended are picked up on their own

Full technical detail — how a sweep decides, the version, the path convention, the canonical
schemas — is in [docs/services/STOCKER.md](../../docs/services/STOCKER.md). Every input format,
and what is not mapped yet, is in
[docs/services/STOCKER-PARTITIONS.md](../../docs/services/STOCKER-PARTITIONS.md).

## Layout

```
<vault>/venue=…/market=…/dataset=…[/interval=…][/kind=…]/YYYYMM/<version>/{FL}/symbol=…/
    {table}.{venue}.{market}.{symbol}[.{interval|kind}].{YYYYMM}.parquet
```

`…/YYYYMM/<version>/` is one partition. The month, the version and `{FL}` — the symbol's first
letter — are bare segments a query engine ignores; the `key=value` levels are read back as
columns and pruned on:

```sql
SELECT * FROM read_parquet('<vault>/venue=okx/market=perp/dataset=trades/**/*.parquet', hive_partitioning=true)
WHERE symbol = 'BTC-USDT-SWAP'
```

## Storage

Two volumes. The archives come in **read-only**; the vault is the one stocker owns and must
exist, writable by uid 1000:

```bash
sudo mkdir -p "$STOCKER_VAULT_DIR"
sudo chown 1000:1000 "$STOCKER_VAULT_DIR"
```

Everything transient — archive extraction, partitions being built, the query engine's spill —
lives in `<vault>/.stocker-tmp` and is cleared at startup. Never the system temp directory: a Gate
order-book month is ~23 GB and in a container `/tmp` is the overlay filesystem.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `STOCKER_ARCHIVES_DIR` | yes | — | **Host** archives directory (hauler's), mounted read-only at `/data/archives` |
| `STOCKER_VAULT_DIR` | yes | — | **Host** vault directory, mounted at `/data/vault` |
| `CATALOG_API` | no | `http://catalog:8080` | Where the catalog answers |
| `CATALOG_TOKEN` | no | _(none)_ | The catalog's shared secret |
| `STOCKER_LENS` | no | _(none)_ | The lens the catalog is read through; none reads the whole catalog |
| `STOCKER_VENUES` | no | _(all)_ | Comma-separated venue filter, case-insensitive; an unknown venue fails startup |
| `STOCKER_TABLES` | no | _(all)_ | Comma-separated table filter, case-insensitive; an unknown table fails startup |
| `STOCKER_SYMBOLS` | no | _(all)_ | Symbol tokens, matched as case-insensitive substrings. A partition stocked through it carries it in its version |
| `STOCKER_START_MONTH` | no | _(none)_ | Oldest month to stock, inclusive. `yyyy-mm`, `yyyymm` or `yymm` |
| `STOCKER_END_MONTH` | no | _(none)_ | Newest month to stock, inclusive |
| `STOCKER_CONCURRENCY` | no | `2` | Instruments built at once, each holding a month-sized sort |
| `STOCKER_SCAN_MINUTES` | no | `30` | Minutes between sweeps |
| `STOCKER_THREADS` | no | `4` | Query engine threads |
| `STOCKER_MIN_FREE_GB` | no | `20` | No partition is started below this much free space on the vault volume |

`STOCKER_ARCHIVES_DIR` and `STOCKER_VAULT_DIR` also override the container paths when running
outside Docker.

`STOCKER_MEMORY_MB` (default `4096`) is a **build argument**, not one of these. Nothing in stocker
reads it or behaves differently for it — the container's entrypoint turns it into the node heap and
that is the end of it. Appetite is set by `STOCKER_CONCURRENCY`, since every concurrent build holds
a sort; this is only the ceiling the host will tolerate while the collectors run alongside.

## Extending it

| To add | Put it in | Then |
|---|---|---|
| A format of a dataset | `src/schema/series.ts` | one entry, no code |
| A canonical table | `src/schema/tables.ts` | one entry, no code |
| A venue's margining rule | `src/schema/margin.ts` | one entry, no code |
| A container format | `src/containers/` | register in `containers/index.ts` |
| A file format | `src/formats/` | register in `formats/index.ts` |

Nothing outside `schema/` names a venue.

A series entry names the catalog's venue, market, dataset and variant it reads, the format, the
timestamp column, and a map from canonical field to source column. Files that carry a header are
mapped by name; headerless ones must declare every column in published order. Where a dataset
holds more than one format, an entry also says which files it reads — by the instrument's
margining, or by the months it holds for.

## Development

```bash
pnpm install
pnpm build
pnpm test
```
