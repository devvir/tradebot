# Hauler

Brings catalogued venue files to disk, under canonical names.

Prospector establishes what every venue publishes and serves each venue as a
bucket over the [catalog API](../../docs/modules/CATALOG-API.md). Hauler walks
those buckets, fetches what is still owed, and writes each object at its key. It
never discovers, never learns how a venue structures its archive, and never
names a file. The key is where its file goes.

```
<archives>/<venue>/<key>

/data/archives/bitget/perp/klines,1m/202506/B/BTCUSDT/
    bitget|perp|klines,1m|BTCUSDT|20250601.zip
```

The full identity is in the filename, so a reader lists files and parses names
without learning where they live.

## What it does

- Walks every venue on its own loop, asking only for files not yet downloaded,
  through the lens named in `HAULER_LENS` when one is set. A walk that brought
  files to disk runs again 5 minutes later; a walk that found nothing runs again
  after 30 minutes.
- Checks every file against the size and ETag the listing carries. A file
  already on disk and correct is **touched** (its modification time becomes the
  time of the pass) and reported as downloaded. So after a pass, a file with an
  older date is one the catalog did not list.
- Renames a file on disk that differs to `<name>.bak` (or `.bak.2`, `.bak.3`, …)
  and then fetches it again. It never deletes anything.
- Reports each page by `FileId`: downloaded, failed, or mismatched. The catalog
  checks the venue again and decides what is true.
- Removes every leftover `.part` file when it starts. `.bak` files stay for a
  person to review.

See [HAULER.md](../../docs/services/HAULER.md) for the design.

## Environment

| variable | | |
|---|---|---|
| `CATALOG_URL` | required | where prospector's API is |
| `CATALOG_TOKEN` | — | sent to the catalog on every request; empty sends none |
| `HAULER_LENS` | everything | the slug of the catalog lens to haul through |
| `HAULER_VENUES` | all | comma-separated venues to haul |
| `HAULER_CONCURRENCY` | 8 | concurrent fetches per venue |
| `HAULER_ARCHIVES_DIR` | required (compose) | the host directory mounted at `/data/archives` |

Hauler serves no API, and it keeps no state other than the files on disk.

## Commands

It runs in the catalog module:

```sh
tb up catalog hauler -d
tb logs catalog hauler
```
