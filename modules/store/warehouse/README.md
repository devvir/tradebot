# Warehouse Module

Turns the archives into the Parquet vault. Runs continuously: every sweep asks the catalog what
each partition holds, and stocks whatever is downloaded in full and not yet in the vault at its
current version.

## Services

| Service | Role |
|---------|------|
| **stocker** | Reads the archives, normalises each format into the canonical tables, writes Parquet |

No infrastructure of its own. Stocker needs the catalog, which the archives module runs, and keeps
no records: a stocked partition's version directory in the vault is the whole record.

## Storage

| Directory | Mount | Owner |
|---|---|---|
| `STOCKER_ARCHIVES_DIR` | `/data/archives`, **read-only** | hauler — this module only reads it |
| `STOCKER_VAULT_DIR` | `/data/vault` | stocker |

Pre-create the vault owned by uid 1000:

```bash
sudo mkdir -p /storage/tradebot/vault && sudo chown 1000:1000 /storage/tradebot/vault
```

`STOCKER_ARCHIVES_DIR` names the same host path as `HAULER_ARCHIVES_DIR` in the archives module.
Repoint both together when storage moves.

## Usage

```bash
tb up warehouse          # Start
tb up warehouse --build  # Rebuild and start
tb down warehouse        # Stop
tb logs warehouse        # Follow logs
```

## Scoping a run

`STOCKER_LENS` decides what the catalog shows stocker at all; `STOCKER_VENUES`, `STOCKER_TABLES`
and the month bounds narrow it further. None of them is a commitment — nothing about them is
recorded, so widening one later simply makes more partitions eligible. The running month is never
stocked, whatever the bounds say, because its files are still arriving.

Configuration is in the [service README](../../../services/stocker/README.md).
