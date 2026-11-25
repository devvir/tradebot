# Prospector Service

Surveys each venue's published archives and records every file in them (path, date, size, checksum,
and the series it belongs to) in one SQLite database, the catalog database. It reads listings, `HEAD`
answers and instrument lists, never the contents of an archive file. It is the catalog database's
only writer: every row of every table, lenses included, is written by this service.

Deployed by: archives module (`modules/collect/archives/compose.yml`).
How it works: [docs/services/PROSPECTOR.md](../../docs/services/PROSPECTOR.md).

## Running it

- **Storage.** The database is `catalog.db` in `/data/catalog` inside the container. The compose file
  mounts the host's `CATALOG_DIR` there and refuses to start without it. The container runs as uid
  1000, so the host directory must be writable by it.
- **Ports.** `8080` is the private API (surveys, status, reports, lenses), reached as
  `http://prospector:8080` on the shared compose network; no host port is published. `3000` serves
  `GET /health` for the container healthcheck; it is not published either.
- **Nothing is surveyed unasked.** A venue starts when the API is asked to survey it
  (`POST /surveys`). From then on it is enrolled: it is re-read every 24 hours and resumed after a
  restart, until it is paused (`POST /surveys/pause`). See
  [The API](../../docs/services/PROSPECTOR.md#the-api).

## Environment

| variable | default | meaning |
|---|---|---|
| `PROSPECTOR_VENUES` | empty: every registered venue | Comma-separated subset of `binance`, `bitget`, `bybit`, `gate`, `htx`, `kucoin`, `okx` (case-insensitive). The venues this process may survey or resume; a venue outside it answers `404` at the API. An unknown name fails startup. It starts nothing on its own. |
| `PROSPECTOR_CONCURRENCY` | `200` | Requests in flight at once, across every venue: one pool that walks, updates and probes all draw from, on top of each venue's own pacing in its adapter. One transport worker per 1,000. Keep below ~1,250 over HTTP/1.1; not enforced. Anything but a positive integer fails startup. |
| `CATALOG_TOKEN` | empty | Shared secret every API request must carry in `x-catalog-token`. Empty turns the check off, and the service logs a warning at startup. |
| `LOG_LEVEL` | `info` | Log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`). |

## When a venue is walked

An enrolled venue's daily pass is an **update** (generate the keys each known series is missing and
ask about those) or a **walk** (list the archive again). Only a walk finds a shape the catalog does
not already hold, so a venue that can be listed walks on set days of the month. Those days belong to
the deployment: copy `src/walk-schedule.example.yaml` to `src/walk-schedule.yaml` (git-ignored) and
name a venue's days:

```yaml
binance: 15        # the 15th
kucoin: 1,10,20    # the 1st, 10th and 20th
gate:              # never: every pass is an update
```

- Days are whole numbers from 1 to 30. `#` starts a comment.
- A venue left out walks once a month, on the day equal to its lowest id in the `venue` table.
- A missed day is made up at the next pass, and two walks of a venue never start within 24 hours of
  each other.
- Only a venue that can be listed may be named: `okx` and `bitget` publish no listing, are never
  walked, and may not appear.
- The file is read once, at startup. The prod image carries the file present when it was built, so
  there a change needs a rebuild.

**A bad file stops the service before it surveys anything.** It logs
`The walk schedule cannot be used — fix it or remove it; stopping` with the problem, naming the line
for a malformed line, a repeated venue or a bad day, and the venue for one that does not exist or
cannot be listed. It exits with status 78, so the container's restart policy brings it back into the
same refusal until the file is fixed or removed.

**A new dataset is found by a walk, not catalogued by it.** A listable archive's prefix tree is
discovered by descent, so a dataset no adapter knows is still found on the first walk that reaches
it. Its files are recorded in the `unreadable` table until the adapter's `inspectUrl` learns to place
them; the walk after that catalogues them.

## Adding a venue

1. An adapter in `src/adapters/`.
2. A line in `ADAPTERS` in `src/venues.ts`.
3. A row in `VENUES` in `src/database/migrations/001-core.ts`, giving its address. Startup refuses an
   adapter with no row.
4. A scanner in `src/scanners/` only for a new platform. A standard S3 listing (`s3`), a browsable HTML
   index (`html`) and a bucket that can only be asked one key at a time (`probed`) are covered.

A venue served from more than one host gets one adapter and one `VENUES` row per host, told apart by
`host`, as bybit is (`bybit.primary.ts`, `bybit.secondary.ts`).
