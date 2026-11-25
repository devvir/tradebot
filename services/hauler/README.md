# Hauler

Brings catalogued venue files to disk, under canonical names.

The catalog serves every venue as one S3-style bucket over the
[catalog API](../../docs/modules/CATALOG-API.md), each venue under its own prefix. Hauler walks each
venue's prefix, fetches what is still owed, and writes each object at `<archives>/<key>`. It never
discovers, never learns how a venue structures its archive, and never names a file.

Deployed by: archives module (`modules/collect/archives/compose.yml`).
How it works: [docs/services/HAULER.md](../../docs/services/HAULER.md).

## What it does

- **Walks every venue on its own loop**, asking only for files still owed, through the lens named in
  `HAULER_LENS` when one is set. A walk that reported any file downloaded runs again 5 minutes later;
  any other walk runs again after 30 minutes.
- **Checks every file against the size and ETag the listing carries.** A file already on disk and
  correct is touched (its modification time becomes the time of the walk) and reported as
  downloaded. A file on disk that differs stays where it is until a verified replacement is in hand,
  and is then moved to `<name>.bak` (or `.bak.2`, `.bak.3`, ...). Hauler never deletes an archive
  file.
- **Reports each page by Key**: downloaded, failed or mismatched. The catalog forwards the report to
  prospector, which checks the venue again and rules.
- **Reports a file failed only on the venue's word**: a `404` or `410` from every address in
  rotation, the listed address among them, or a `403` from the listed address on every attempt.
  A timeout, a `5xx`, a `429` or a short body leaves the file unreported and owed, to come round on
  the next walk.
- **Takes a refusing address out of rotation, not the venue.** A `429`, any answer saying how long to
  wait, or five `403`s in a row with nothing delivered between takes that address out for a while;
  the server's other addresses carry on. Its files wait only where every address of their server is
  out.
- **Stops taking new files when the archives volume runs low**: under `HAULER_MIN_FREE_GB` free, low
  on inodes, or a write refused for want of room.
- **Removes every unfinished download when it starts.** They all sit in `.hauler-tmp` at the
  archives' root, so that is one directory. `.bak` files stay for a person to review.

The venue list and each venue's addresses are read once, at startup: a venue the catalog gains later
is walked only after a restart. Hauler keeps no persistent state other than the files on disk; held
downloads and address scores live in memory and start empty with each process.

## Environment

| variable | default | |
|---|---|---|
| `CATALOG_API` | `http://catalog:8080` | where the catalog API is |
| `CATALOG_TOKEN` | empty | sent to the catalog on every request; empty sends none |
| `HAULER_LENS` | empty (every catalogued file) | slug of the catalog lens to haul through |
| `HAULER_VENUES` | empty (every venue the catalog knows) | comma-separated venues to haul |
| `HAULER_CONCURRENCY` | `100` | fetches in flight across every venue together: one budget, not one per venue |
| `HAULER_MIN_FREE_GB` | `25` | free space on the archives volume, in GB, below which no new file is taken |
| `DATA_ARCHIVES_DIR` | required (compose) | host directory mounted at `/data/archives`, writable by uid 1000 |
| `LOG_LEVEL` | `info` | |

`HAULER_CONCURRENCY` and `HAULER_MIN_FREE_GB` must be positive integers; anything else stops the
service at startup.

Hauler serves no API beyond its health check, `GET /health` on port 3000.

## Commands

```sh
tb up archives hauler -d
tb logs archives hauler
```
