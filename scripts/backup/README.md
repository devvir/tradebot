# scripts/backup

Daily backup and rotation job for `tradebot_archive` (MongoDB).

Each run: dumps yesterday's data from every collection → gzip archives, prunes documents older than N days from the live database, and rotates old dump files off disk.

Date-range selection uses the `_id` field directly (no separate timestamp index) — the writer embeds the creation timestamp in each document's `_id`.

Requires `mongodump` and `mongosh` to be installed on the host (`mongodb-database-tools` and `mongodb-mongosh` packages). MongoDB must be port-mapped to the host via `DB_PORT`.

---

## Environment variables

Loaded automatically from the root `.env` at startup.

| Variable              | Default               | Description                                              |
|-----------------------|-----------------------|----------------------------------------------------------|
| `DB_USER`        | *(required)*          | MongoDB username                                         |
| `DB_PASS`        | *(required)*          | MongoDB password                                         |
| `DB_PORT`        | `27017`               | Host port MongoDB is mapped to                           |
| `BACKUP_DATABASE`     | `tradebot_archive`    | Database to back up and prune                            |
| `DUMP_DIR`            | `/data/backups/tradebot` | Directory where dump files are written               |
| `DUMP_RETENTION_DAYS` | `30`                  | Delete local dump files older than this many days        |
| `PRUNE_AGE_DAYS`      | `14`                  | Delete documents older than this many days from live DB  |

---

## Usage

```sh
# Build
pnpm --filter tradebot-backup build
# or: cd scripts/backup && npx tsc -p tsconfig.json

# Normal run (yesterday's data + prune + rotate)
node scripts/backup/dist/index.js

# Dump a specific date (no prune or rotation)
node scripts/backup/dist/index.js --date=2026-03-07

# Preview what would happen without touching anything
node scripts/backup/dist/index.js --dry-run

# Only prune the live DB and rotate dump files (skip dump)
node scripts/backup/dist/index.js --prune-only

# Only dump (skip prune and rotation)
node scripts/backup/dist/index.js --dump-only
```

## Cron

```cron
# Run daily at 02:00 UTC
0 2 * * *  node /data/Development/Repos/NM/tradebot/scripts/backup/dist/index.js >> /var/log/tradebot-backup.log 2>&1
```

## Dump file layout

After all collections are dumped, they are bundled into a single `.tar` per day:

```
tradebot_archive__2026-03-08.tar
  tradebot_archive__trade__2026-03-08.gz
  tradebot_archive__liquidation__2026-03-08.gz
  tradebot_archive__instrument__2026-03-08.gz
  ...
```

The individual `.gz` files inside are already gzip-compressed (`mongodump --gzip --archive`),
so the outer tar has no additional compression. This keeps individual collections extractable.

### Restoring all collections

```sh
tar -xf tradebot_archive__2026-03-08.tar
for f in tradebot_archive__*__2026-03-08.gz; do
  mongorestore --uri "mongodb://user:pass@localhost:27018/?authSource=admin" \
    --gzip --archive="$f"
done
```

### Restoring a single collection

```sh
tar -xf tradebot_archive__2026-03-08.tar tradebot_archive__trade__2026-03-08.gz
mongorestore --uri "mongodb://user:pass@localhost:27018/?authSource=admin" \
  --gzip --archive=tradebot_archive__trade__2026-03-08.gz \
  --nsInclude="tradebot_archive.trade"
```
