# Stocker Service

Normalises every collector's raw output into one partitioned Parquet vault, so consumers never
learn where a dataset came from or what shape it arrived in.

Trucker, and later the REST and websocket collectors, each drop data exactly as its source
published it — different paths, containers, column names, timestamp units and symbol
conventions. Stocker reads all of them and writes one uniform, queryable tree beside them. Raw
is never modified, moved or deleted.

## What it does

- Reads every origin under `sources/` — trucker's archive tree today
- Decodes `.zip`, `.csv.gz`, `.tar.gz` and Excel-inside-zip; `.csv.gz` is handed to the query
  engine untouched, since it reads gzip natively
- Maps each source series onto a **canonical table** with one schema across all venues, filling
  NULL where a venue publishes nothing
- Converts every timestamp to **int64 microseconds UTC**, from the unit each series declares
- Writes zstd Parquet, sorted by `ts`, into hive-partitioned directories
- Rebuilds only the partitions whose raw inputs have changed
- Runs long-lived, rescanning so raw that lands unattended is picked up on its own

Full technical detail — the path convention, the canonical schemas, the extension points — is
in [docs/services/STOCKER.md](../../docs/services/STOCKER.md). What is not mapped yet and what
is still open is in [docs/planning/STOCKER.md](../../docs/planning/STOCKER.md).

## Layout

```
<vault>/venue=…/market=…/{FL}/symbol=…/dataset=…[/interval=…][/variant=…]/
    {table}.{venue}.{market}.{symbol}[.{interval|variant}].{YYYYMM}.parquet
```

`{FL}` is the symbol's first letter, uppercased, `_` for anything that is not a letter — a bare
segment that bounds how many directories a market holds, and the one level a query engine does not
see.

Hive-style `key=value` directories, so a query engine reads them back as columns and prunes on
them without the caller building a path:

```sql
SELECT * FROM read_parquet('<vault>/trades/**/*.parquet', hive_partitioning=true)
WHERE venue = 'okx' AND market = 'perp' AND symbol = 'BTC-USDT-SWAP'
```

File names are descriptive rather than `data.parquet` because a file that leaves the tree
travels alone — an upload queue shows the name, not the path.

## Storage

Two volumes. Raw comes in **read-only**; the vault is the one stocker owns and must exist,
writable by uid 1000:

```bash
sudo mkdir -p "$STOCKER_VAULT_DIR"
sudo chown 1000:1000 "$STOCKER_VAULT_DIR"
```

Everything transient — archive extraction, part-written files, the query engine's spill — lives
in `<vault>/.stocker-tmp` and is cleared at startup. Never the system temp directory: a Gate
order-book month is ~23 GB and in a container `/tmp` is the overlay filesystem.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATA_DIR` | yes | — | **Host** root of the tradebot tree; `@shared` at `$DATA_DIR/@shared` mounts read-only at `/data/shared` |
| `TRUCKER_DATA_DIR` | no | `$DATA_DIR/trucker` | **Host** directory trucker owns, mounted read-only at `/data/trucker`. Also overrides the container path when running outside Docker |
| `STOCKER_VAULT_DIR` | yes | — | **Host** vault directory, mounted at `/data/vault` |
| `STOCKER_VENUES` | no | _(all)_ | Comma-separated venue filter, case-insensitive; an unknown venue fails startup |
| `STOCKER_TABLES` | no | _(all)_ | Comma-separated table filter, case-insensitive; an unknown table fails startup |
| `STOCKER_SYMBOLS` | no | _(all)_ | Symbol tokens, matched as case-insensitive substrings |
| `STOCKER_FROM` | no | _(none)_ | Oldest month to process, `YYYY-MM` inclusive |
| `STOCKER_TO` | no | _(none)_ | Newest month to process, `YYYY-MM` inclusive. Hold it below the era still being collected so a run never touches raw that is still arriving |
| `STOCKER_CONCURRENCY` | no | `2` | Partitions built at once, sharing one memory budget |
| `STOCKER_SCAN_MINUTES` | no | `30` | Minutes between rescans of the raw tree |
| `STOCKER_MEMORY_LIMIT` | no | `4GB` | Query engine cap; it spills to disk rather than being killed |
| `STOCKER_THREADS` | no | `4` | Query engine threads |

`TRUCKER_DATA_DIR`, `STOCKER_VAULT_DIR` and `STOCKER_SHARED_DIR` override the container paths when running outside
Docker.

## Extending it

Four extension points, each a file you add rather than a switch you edit:

| To add | Put it in | Then |
|---|---|---|
| An origin (REST, websocket, vault) | `src/sources/` | register in `sources/index.ts` |
| A container format | `src/containers/` | register in `containers/index.ts` |
| A file format | `src/formats/` | register in `formats/index.ts` |
| A venue series | `src/schema/series.ts` | one entry, no code |
| A canonical table | `src/schema/tables.ts` | one entry, no code |

Nothing outside `sources/` and `schema/` names a venue.

A series entry needs a path pattern capturing `symbol`, the container and format, the timestamp
column and **its unit**, and a map from canonical field to source column. Files that carry a
header are mapped by name; headerless ones must declare every column in published order.

**Declare the timestamp unit; never infer it.** Bybit stamps its spot trades in integer
milliseconds and its perpetual trades in fractional seconds, both under a header that says only
`timestamp`. A build whose timestamps fall outside 2015–2035 is rejected rather than published,
which is how that one was caught.

## Development

```bash
pnpm install
pnpm build
pnpm test
```
