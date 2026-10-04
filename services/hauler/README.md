# Hauler

Brings catalogued venue files to disk, under canonical names.

Prospector establishes what every venue publishes, and the catalog serves every
venue as one S3-style bucket over the [catalog API](../../docs/modules/CATALOG-API.md),
each under its own prefix. Hauler walks each venue's prefix, fetches what is still
owed, and writes each object at its key. It never discovers, never learns how a
venue structures its archive, and never names a file. The key is where its file goes.

```
<archives>/<key>

/data/archives/bitget/perp/klines,1m/B/BTCUSDT/202506/
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
- Reports each page by Key: downloaded, failed, or mismatched. The catalog
  checks the venue again and decides what is true. Only the venue saying a file
  is not there (`404`, `410`, or `403` on every attempt) makes it failed; a
  timeout, a busy venue or a `429` leaves it unreported, to come round on the
  next walk.
  A refusal also pauses every fetch from that venue for a while.
- Removes every unfinished download when it starts: they all sit in `.hauler-tmp` at the
  archives' root, so that is one directory. `.bak` files stay for a person to review.

See [HAULER.md](../../docs/services/HAULER.md) for the design.

## Environment

| variable | | |
|---|---|---|
| `CATALOG_API` | `http://catalog:8080` | where the catalog API is |
| `CATALOG_TOKEN` | — | sent to the catalog on every request; empty sends none |
| `HAULER_LENS` | everything | the slug of the catalog lens to haul through |
| `HAULER_VENUES` | all | comma-separated venues to haul |
| `HAULER_CONCURRENCY` | 8 | concurrent fetches per venue |
| `HAULER_MIN_FREE_GB` | 25 | free space on the archives volume below which nothing more is fetched |
| `HAULER_ARCHIVES_DIR` | required (compose) | the host directory mounted at `/data/archives` |

Hauler serves no API, and it keeps no state other than the files on disk.

## Commands

It runs in the archives module:

```sh
tb up archives hauler -d
tb logs archives hauler
```
