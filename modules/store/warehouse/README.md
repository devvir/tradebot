# Warehouse Module

Turns the archives into the Parquet vault. Runs continuously: a sweep every 5 minutes asks the
catalog what each partition holds, and stocks whatever is downloaded in full, settled in the
catalog, and not in the vault's ledger at its current revision.

## Services

| Service | Role |
|---------|------|
| **stocker** | Reads the archives, normalises each format into the canonical tables, writes Parquet |

No infrastructure of its own. Stocker reads the catalog, which the archives module runs, over the
shared network, and keeps no records outside the vault: what each partition was stocked from is a
line in the vault's own ledger.

## Storage

| Directory | Mount | Owner |
|---|---|---|
| `DATA_ARCHIVES_DIR` | `/data/archives`, **read-only** | hauler; this module only reads it |
| `DATA_VAULT_DIR` | `/data/vault` | stocker |

Pre-create the vault owned by uid 1000:

```bash
dir="${DATA_VAULT_DIR:-$DATA_DIR/vault}"
sudo mkdir -p "$dir" && sudo chown 1000:1000 "$dir"
```

Both default under `DATA_DIR`, to `${DATA_DIR}/archives` and `${DATA_DIR}/vault`. `DATA_DIR` is set
once, in the monorepo's root `.env`, so hauler and stocker cannot disagree about where the archives
are. Compose refuses to start stocker while `DATA_DIR` is unset and either variable is too. Set either in the root
`.env` to move it for every module, or in this module's `.env` to move it for this module alone: the
module's `.env` is read after the root one. What the vault root holds is in the
[service README](../../../services/stocker/README.md#storage).

## Usage

```bash
tb up warehouse -d          # Start
tb up warehouse -d --build  # Rebuild and start
tb down warehouse           # Stop
tb logs warehouse -f        # Follow logs
```

## Scoping a run

`STOCKER_LENS` decides what the catalog shows stocker at all, and `STOCKER_VENUES` narrows it to
some venues. Neither is a commitment: nothing about them is recorded, so widening one later makes
more partitions eligible without stocking again what is already done. The running month is never
stocked, because its files are still arriving.

Configuration is in the [service README](../../../services/stocker/README.md#configuration).
