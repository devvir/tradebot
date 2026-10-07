# Warehouse Module

Turns the archives into the Parquet vault. Runs continuously: every sweep asks the catalog what
each partition holds, and stocks whatever is downloaded in full, settled in the catalog, and not yet
in the vault at its current revision.

## Services

| Service | Role |
|---------|------|
| **stocker** | Reads the archives, normalises each format into the canonical tables, writes Parquet |

No infrastructure of its own. Stocker needs the catalog, which the archives module runs, and keeps
no records outside the vault: what each partition was stocked from is a line in the vault's own
ledger.

## Storage

| Directory | Mount | Owner |
|---|---|---|
| `DATA_ARCHIVES_DIR` | `/data/archives`, **read-only** | hauler — this module only reads it |
| `DATA_VAULT_DIR` | `/data/vault` | stocker |

Pre-create the vault owned by uid 1000:

```bash
sudo mkdir -p /storage/tradebot/vault && sudo chown 1000:1000 /storage/tradebot/vault
```

Both are set once, in the monorepo's root `.env`, so hauler and stocker cannot disagree about where the
archives are. Set either in this module's `.env` only to move it for this module alone.

## Usage

```bash
tb up warehouse          # Start
tb up warehouse --build  # Rebuild and start
tb down warehouse        # Stop
tb logs warehouse        # Follow logs
```

## Scoping a run

`STOCKER_LENS` decides what the catalog shows stocker at all, and `STOCKER_VENUES` narrows it to
some venues. Neither is a commitment — nothing about them is recorded, so widening one later simply
makes more partitions eligible. The running month is never stocked, because its files are still
arriving.

Configuration is in the [service README](../../../services/stocker/README.md).
