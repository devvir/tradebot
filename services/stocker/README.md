# Stocker

Turns the archives into the vault: every venue's raw files, read partition by partition as the
catalog lists them, normalised into one Parquet format per canonical table. Stocker alone stocks the
vault. It reads the archives and never writes to them.

Deployed by: warehouse module (`modules/store/warehouse/compose.yml`).
How it works: [docs/services/STOCKER.md](../../docs/services/STOCKER.md). Every input format and how
it is mapped: [docs/services/STOCKER-PARTITIONS.md](../../docs/services/STOCKER-PARTITIONS.md).

## Storage

Two mounts. Compose refuses to start without either.

| Host directory | In the container | Access |
|---|---|---|
| `DATA_ARCHIVES_DIR` | `/data/archives` | read-only |
| `DATA_VAULT_DIR` | `/data/vault` | read-write. The container runs as uid 1000, so the directory must exist and be writable by it |

```bash
sudo mkdir -p "$DATA_VAULT_DIR"
sudo chown 1000:1000 "$DATA_VAULT_DIR"
```

At startup the service checks that the archives can be read and the vault written, and stops with
the reason where either cannot.

**The vault root** holds:

| Entry | Written by | Contract |
|---|---|---|
| `venue=…/` | stocker | The Parquet files, laid out as in [the path convention](../../docs/services/STOCKER.md#path-convention). Do not add or change files by hand. A file may be taken out where `backedup.csv` records a copy of its partition at the revision the ledger holds; a partition missing files without such a copy is a loss at the next start |
| `ledger.csv` | stocker | A line per partition stocked, appended and never changed; the last line for a partition counts. Never edit or remove it: a partition without a line is not stocked, as far as stocker knows, and is stocked again from its archives. See [The ledger](../../docs/services/STOCKER.md#the-ledger) |
| `backedup.csv` | whatever keeps a copy of the vault elsewhere | Which partitions have a safe copy, and at which revision. Stocker only reads it. Its format: [COLD-VAULT.md](../../docs/tooling/COLD-VAULT.md#backedupcsv) |
| `ERROR.log` | stocker | A line per loss found as the service starts: a partition the ledger holds that is not in the vault whole and has no safe copy. Such a partition is stocked again. Nothing removes the file but a person, which is how a loss is acknowledged |
| `.stocker-tmp/` | stocker | Scratch: extracted archives, partitions being built (`stage/`) and the query engine's spill (`engine/`). Cleared at startup, except for the pieces of a partition already built, which the next build takes up. See [the scratch layout](../../docs/services/STOCKER.md#extraction-runs-ahead-of-the-builds-on-threads-of-its-own) |

Scratch sits on the vault's volume, never in the system temp directory, so every free-space check
(`STOCKER_MIN_FREE_GB`) is a check of that one volume.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DATA_ARCHIVES_DIR` | _(required)_ | Host archives directory, mounted read-only at `/data/archives`. Set in the root `.env` |
| `DATA_VAULT_DIR` | _(required)_ | Host vault directory, mounted at `/data/vault`. Set in the root `.env` |
| `CATALOG_API` | `http://catalog:8080` | Where the catalog answers |
| `CATALOG_TOKEN` | _(none)_ | The catalog's shared secret, sent as `x-catalog-token` |
| `STOCKER_LENS` | _(none)_ | The lens the catalog is read through, sent as `x-catalog-lens`; none reads the whole catalog |
| `STOCKER_VENUES` | _(all)_ | Comma-separated venues to stock, case-insensitive: `binance`, `bitget`, `bybit`, `gate`, `htx`, `kucoin`, `okx`. An unknown venue fails startup |
| `STOCKER_CONCURRENCY` | `2` | DuckDB connections, one pool shared by partitions: as many light partitions built side by side, or one heavy partition's tasks. Each holds a month-sized sort |
| `STOCKER_THREADS` | `4` | Threads the query engine may use, shared by every build |
| `STOCKER_ENGINE_MEMORY_GB` | `4` | Memory the query engine may use, shared by every build, before it spills to disk |
| `STOCKER_MIN_FREE_GB` | `20` | Free space kept on the vault's volume. Below it a sweep stops; a partition whose extraction would cross it waits; the engine's spill is capped at what is free above it, and never under 1 GB |
| `LOG_LEVEL` | `info` | Log level |
| `TZ` | `UTC` | The container's time zone. Stocker's own times (ledger lines, `ERROR.log`) are UTC whatever it is |

The four numeric settings take a positive integer; anything else fails startup. `DATA_ARCHIVES_DIR`
and `DATA_VAULT_DIR` also replace the container paths when the service runs outside Docker.

Fixed, not settings: a sweep runs every 5 minutes, and the Node heap is 4096 MB (a build argument in
`docker/compose.yml`). What grows with a month's size is the query engine's memory, which is
`STOCKER_ENGINE_MEMORY_GB`.

**Health.** `GET /health` on port 3000, inside the container, answers 200 while the process runs;
compose checks it every 30 s. It says nothing about sweeps: each sweep ends with a log line saying
what it did ([Running it](../../docs/services/STOCKER.md#running-it)).

## Extending it

| To add | Put it in | Then |
|---|---|---|
| A format of a dataset | `src/schema/series.ts` | one entry, no code |
| A canonical table | `src/schema/tables.ts` | one entry, and its name in the `Table` type in `src/types.ts` |
| A venue's margining rule | `src/schema/margin.ts` | one entry, no code |
| A container format | `src/containers/` | add it to `CONTAINERS` in `containers/registry.ts`, and map its file ending to it in `containerOf` in `src/keys.ts` (taking the ending out of `UNOPENED` if it is one of those) |
| A file format | `src/formats/` | add it to `FORMATS` in `formats/index.ts` |
| A change to what is written | `src/versions.ts`, or the series entry's `version` | the stocker version it ships in, at the narrowest level that covers it; the partitions it covers are stocked again ([The revision](../../docs/services/STOCKER.md#the-revision)) |

No code outside `src/schema/` names a venue.

A series entry names the catalog's venue, market, dataset and variant it reads, the canonical table,
the format, the timestamp column, and a map from canonical field to source expression. Files that
carry a header are mapped by name; headerless ones declare every column in published order. Where a
dataset holds more than one format, an entry also says which files it reads: by the instrument's
margining, or by the months it holds for.

## Development

```bash
pnpm --filter @tradebot/stocker build
pnpm --filter @tradebot/stocker test
```

Outside the production image, the first read of an `xlsx` series fetches DuckDB's `excel` extension
from DuckDB's extension repository where it is not installed locally; the production image has it
installed.
