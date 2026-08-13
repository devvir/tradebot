# Warehouse Module

Turns the collectors' raw archives into one queryable Parquet vault. Runs continuously — it
rescans the raw tree on a timer and builds whatever is new, so archives that land unattended are
picked up on their own.

## Services

| Service | Role |
|---------|------|
| **stocker** | Reads the raw tree, normalises each venue's shape into the canonical tables, writes Parquet |

No infrastructure. Stocker keeps its record of built partitions as files under `@meta/` in the
vault and runs its queries in process, so there is no database or queue to start first.

## Storage

Two host directories, and the module owns only one of them:

| Directory | Mount | Owner |
|---|---|---|
| `TRUCKER_DATA_DIR` | `/data/trucker`, **read-only** | trucker — this module is only a consumer |
| `DATA_DIR` | `/data/shared`, **read-only** | `@shared`, always `$DATA_DIR/@shared` on the host |
| `STOCKER_VAULT_DIR` | `/data/vault` | stocker |

Pre-create the vault owned by uid 1000:

```bash
sudo mkdir -p /storage/tradebot/vault && sudo chown 1000:1000 /storage/tradebot/vault
```

`TRUCKER_DATA_DIR` names the same host path as the collect module's `.env`. Repoint both
together when storage moves.

## Usage

```bash
tb up warehouse          # Start
tb up warehouse --build  # Rebuild and start
tb down warehouse        # Stop
tb logs warehouse        # Follow logs
```

## Working an era at a time

`STOCKER_START_MONTH` and `STOCKER_END_MONTH` bound a run to inclusive `YYYY-MM` months. Neither is a
commitment — nothing about them is recorded, so widening one later simply makes more months
eligible.

Holding `STOCKER_END_MONTH` below the era trucker is currently fetching means each month is built once,
from a complete era, instead of being rebuilt every time more of its raw arrives. It is a saving
in rework, not a correctness requirement: a partition built from a half-collected month is
rebuilt whole once the rest lands.

The running month is never processed, whatever the bounds say, because its raw is still arriving.

Configuration and the full storage contract are in the
[service README](../../../services/stocker/README.md).
