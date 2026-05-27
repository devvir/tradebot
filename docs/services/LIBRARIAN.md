# Librarian Service — Technical Reference

## Overview

Librarian is a deliberately thin HTTP↔MongoDB proxy serving the project's main
database (`DB_DATABASE`). It exposes two endpoints — bulk insert and batched
read — and exists for one reason: to put the BSON-encoding and mongo I/O work
on its own Node event loop, freeing the producer/consumer's loop to do its
real job (streaming, parsing, reconstruction, in-memory buffering) without
contention.

Throughput characteristics on the insert path, measured against the prototype
that preceded the standalone service: **30-45k inserts/s sustained**, **peaks
50-65k/s**, with mongo at ~220% CPU. The same architectural argument applies
to the read path — a consumer that wants to keep warm buffers full at high
fan-out shouldn't also be paying the BSON-decoding tax on its own loop.

## Why a separate process?

Node is single-threaded for JS work. A producer that reads, parses, and writes
to mongo in the same process is sharing one event loop across all three. With
mongo's BSON encoding being expensive enough to dominate the loop, the
producer's read/parse work gets squeezed: measured baseline of 40k reads/s
collapses to ~14k/s when mongo writes share the loop.

Putting the mongo work behind an HTTP boundary spends one TCP round-trip per
batch but gives each side a full CPU core. The client's loop recovers; the
librarian's BSON encoding/decoding climbs to whatever mongo can absorb. A
worker thread would have given a similar win without HTTP overhead, but at
the cost of structured-clone or shared-buffer wiring on every batch.
Cross-process HTTP keeps the contract narrow and reusable: anything that can
POST/GET JSON can use it.

## API

### `POST /:table`

Body: a non-empty JSON array of documents. The librarian calls
`db.collection(:table).insertMany(body, { ordered: false })` and returns one
of:

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ inserted: <n> }` | All `n` docs inserted. |
| `200` | `{ inserted: <n>, duplicates: true }` | Some/all docs were already present (`E11000`); the caller opted into this via `LIBRARIAN_IGNORE_DUPLICATES=true`. |
| `400` | `{ error: 'body must be a non-empty array' }` | Body was missing, not an array, or empty. |
| `409` | `{ inserted: <n>, error: 'duplicate key' }` | `E11000` with `LIBRARIAN_IGNORE_DUPLICATES=false`. `inserted` reflects docs that landed before the conflict (mongo runs with `ordered: false`). |
| `413` | `{ error: 'request body too large' }` | Body exceeded the 32 MB cap. |
| `500` | `{ error: <message> }` | Mongo rejected the insert for any reason other than duplicate-key. |

`ordered: false` is deliberate: per-doc failures don't halt the batch.

### `GET /:table`

Query params:

| Param | Required | Default | Description |
|---|---|---|---|
| `limit` | No | `10000` | Positive integer, no upper cap. The caller decides what fits its memory budget; the librarian doesn't second-guess. |
| `from` | No | — | Lower `_id` cursor. Applied as `{ _id: { $gte: from } }`. Parsed as a JS-safe number (the project's `_id`s are numeric). |
| `before` | No | — | Upper `_id` cursor — the mirror of `from`. Applied as `{ _id: { $lte: before } }`. Combine with `from` for a bounded `_id` range. |
| `order` | No | `asc` | `_id` sort direction: `asc` (default) or `desc`. |
| `filter` | No | — | Optional JSON-encoded mongo filter document. Merged verbatim into the query. |

The final mongo query is `{ ...filter, ...(from/before → { _id: { $gte, $lte } }) }`,
sorted `{ _id: order }`, limited.

`from`/`before`/`order` are additive and optional — a bare `GET /:table` is
unchanged (ascending, `from`-only). Descending reads (`order=desc` with `before`)
serve reverse pagination and single-doc cursor probes — e.g. `before=X&order=desc&limit=1`
returns the latest doc at-or-before `X`, the primitive a consumer uses to binary-search
the `_id` index for a timestamp without a timestamp index.

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ docs: [...] }` | Up to `limit` docs, sorted by `_id` ascending. |
| `400` | `{ error: <message> }` | `limit` not a positive integer, `from` not a number, or `filter` not valid JSON / not an object. |
| `500` | `{ error: <message> }` | Mongo failure during the read. |

Pagination is the client's responsibility — pass `from = lastSeenId + 1` (or
filter `_id !== from` on receipt) for the next batch. There's no
continuation token; nothing stateful lives on the librarian side.

### `GET /health`

Returns `200 { ok: true }`. Used by the docker healthcheck.

## Body limits

- Hard limit on `POST`: **32 MB per request** (express body cap). Larger
  requests get a `413` before they reach mongo.
- Soft consideration: mongo's hard per-document BSON limit is 16 MB, and the
  wire-protocol message limit is ~48 MB. Producers should batch under both;
  the librarian doesn't split.

## Duplicate handling (`LIBRARIAN_IGNORE_DUPLICATES`)

Default is `true` because the original consumer (farmer) needs it. Farmer
assigns deterministic `_id`s and retries forever on transient errors — without
idempotent E11000 handling, every retry-after-partial-success would loop on
the second pass. Treating duplicate-key as `200` short-circuits cleanly.

Other consumers may not have this property. A pipeline that generates fresh
`_id`s on every send, or one that uses `_id` as a uniqueness check, should
extend the librarian compose service with `LIBRARIAN_IGNORE_DUPLICATES=false`.
Conflicts then surface as `409 Conflict` (not 500 — it's a caller-fault
outcome, not a server failure) and the body's `inserted` field reports how
many docs landed before the conflict aborted the batch.

## Throughput logging

Every 5 seconds, `startMetrics` emits a `Librarian metrics` log line:

```
{
  writes: { total: 12_345_678, delta: 187_322, rate: 37_464 },
  reads:  { total:    421_000, delta:  18_000, rate:  3_600 }
}
```

`rate` is `delta / 5s`. Only successful operations (including
duplicate-handled inserts) increment the counters. Tracking these alongside
each client's own counter is the cheapest way to confirm the two sides are in
sync.

## What the librarian doesn't do

- **No batch splitting.** A 64 MB body is a `413`, not "let me chunk it for
  you". Sizing is the caller's problem; the librarian is supposed to behave
  identically to a thin shim around `insertMany` / `find().toArray()`.
- **No retries.** If mongo rejects, the librarian returns `500`. The caller's
  retry policy decides what happens next. (Retrying at *two* layers would
  amplify load when mongo is struggling.)
- **No doc-shape validation.** The librarian doesn't know or care what fields
  the docs have. That's a client concern.
- **No connection pooling tweaks.** Default mongo driver. The `maxPoolSize`
  knob is available via `DB_URL` query string if needed; nothing inside the
  librarian overrides it.
- **No projection / sort / range filters on read beyond `_id`.** The `filter`
  query param is mongo's full filter document — callers that need anything
  fancier express it there. Sort is always `{ _id: 1 }`.

## Folder structure

```
src/
  index.ts        SK.run — connect mongo, hand the Db to the router
  service.ts      SKFactory({ name: 'librarian', mongodb: true, config })
  config.ts       env: DB_DATABASE, LIBRARIAN_IGNORE_DUPLICATES
  types.ts        Config interface + counter types
  server.ts       express router — the API surface (routes only)
  handlers/
    write.ts      POST /:table — bulk insertMany + E11000 handling
    read.ts       GET  /:table — find().sort({_id:1}).limit() with cursor
  query.ts        parsers for `limit` / `from` / `filter` query params
  metrics.ts      writes/reads throughput counters + 5s log loop
```

## Deployment

The librarian is a sidecar — never run standalone, always extended by the
module that needs it. The pattern:

```yaml
# inside modules/<group>/<module>/compose.yml
services:
  writer:                                            # alias of your choice
    extends:
      file: ../../../services/librarian/docker/compose.yml
      service: librarian
    deploy:
      replicas: ${MODULE_WRITER_REPLICAS:-1}         # module owns the scaling
```

Each module that extends librarian owns its replica count, so two modules
running against the same database don't share instances or contend for the
same pool.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_URL` | Yes | — | MongoDB connection string |
| `DB_DATABASE` | Yes | — | Target database |
| `LIBRARIAN_IGNORE_DUPLICATES` | No | `true` | `E11000` → `200` (with `duplicates: true`) when `true`; `409` when `false` |
