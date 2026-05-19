# Writer Service — Technical Reference

## Overview

Writer is a deliberately thin HTTP-to-MongoDB proxy. Its only job is to call
`insertMany` on whatever JSON array a client sends. It exists for one reason:
to put the BSON-encoding and mongo I/O work on its own Node event loop, freeing
the producer's loop to do its real job (streaming, parsing, reconstruction)
without contention.

Throughput characteristics in isolation, measured against the prototype that
preceded this service: **30-45k inserts/s sustained**, **peaks 50-65k/s**, with
mongo at ~220% CPU. Same numbers hold once the writer is wired up properly —
no per-doc work was added on top of the prototype.

## Why a separate process?

Node is single-threaded for JS work. A producer that reads, parses, and writes
to mongo in the same process is sharing one event loop across all three. With
mongo's BSON encoding being expensive enough to dominate the loop, the
producer's read/parse work gets squeezed: measured baseline of 40k reads/s
collapses to ~14k/s when mongo writes share the loop.

Putting the mongo work behind an HTTP boundary spends one TCP round-trip per
batch but gives each side a full CPU core. The producer's reader rate
recovers; the writer's BSON-encoding rate climbs to whatever mongo can absorb.

A worker thread would have given a similar win without HTTP overhead, but at
the cost of structured-clone or shared-buffer wiring on every batch.
Cross-process HTTP keeps the contract narrow and reusable: anything that can
POST JSON can use it.

## API

### `POST /write/:table`

Body: a non-empty JSON array of documents. The writer calls
`db.collection(:table).insertMany(body, { ordered: false })` and returns one
of:

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ inserted: <n> }` | All `n` docs inserted. |
| `200` | `{ inserted: <n>, duplicates: true }` | Some/all docs were already present (`E11000`); the caller opted into this via `WRITER_IGNORE_DUPLICATES=true`. |
| `400` | `{ error: 'body must be a non-empty array' }` | Body was missing, not an array, or empty. |
| `409` | `{ inserted: <n>, error: 'duplicate key' }` | `E11000` with `WRITER_IGNORE_DUPLICATES=false`. `inserted` reflects docs that landed before the conflict (mongo runs with `ordered: false`). |
| `413` | `{ error: 'request body too large' }` | Body exceeded the 32 MB cap. |
| `500` | `{ error: <message> }` | Mongo rejected the insert for any reason other than duplicate-key. |

`ordered: false` is deliberate: per-doc failures don't halt the batch.

### `GET /health`

Returns `200 { ok: true }`. Used by the docker healthcheck.

## Body limits

- Hard limit: **32 MB per request** (express body cap). Larger requests get a
  `413` before they reach mongo.
- Soft consideration: mongo's hard per-document BSON limit is 16 MB, and the
  wire-protocol message limit is ~48 MB. Producers should batch under both;
  the writer doesn't split.

## Duplicate handling (`WRITER_IGNORE_DUPLICATES`)

Default is `true` because the original consumer (farmer) needs it. Farmer
assigns deterministic `_id`s and retries forever on transient errors — without
idempotent E11000 handling, every retry-after-partial-success would loop on
the second pass. Treating duplicate-key as `200` short-circuits cleanly.

Other consumers may not have this property. A pipeline that generates fresh
`_id`s on every send, or one that uses `_id` as a uniqueness check, should set
`WRITER_IGNORE_DUPLICATES=false`. Conflicts then surface as `409 Conflict`
(not 500 — it's a caller-fault outcome, not a server failure) and the body's
`inserted` field reports how many docs landed before the conflict aborted the
batch.

## Throughput logging

Every 5 seconds, `startServer` emits a `Writer metrics` log line:

```
{
  totalInserted: 12_345_678,
  delta:            187_322,
  rate:              37_464
}
```

`rate` is `delta / 5s`. The number is "what mongo actually absorbed" — only
successful inserts (including duplicate-handled ones) increment it. Tracking
this alongside the producer's own counter is the cheapest way to confirm the
two are in sync.

## What the writer doesn't do

- **No batch splitting.** A 64 MB body is a `413`, not "let me chunk it for
  you". Sizing is the caller's problem; the writer is supposed to behave
  identically to a thin shim around `insertMany`.
- **No retries.** If mongo rejects, the writer returns `500`. The caller's
  retry policy decides what happens next. (Retrying at *two* layers would
  amplify load when mongo is struggling.)
- **No doc-shape validation.** The writer doesn't know or care what fields
  the docs have. That's a producer concern.
- **No connection pooling tweaks.** Default mongo driver. The `maxPoolSize`
  knob is available via `DB_URL` query string if needed; nothing inside the
  writer overrides it.

## Folder structure

```
src/
  index.ts        SK.run — connect mongo, hand the Db to startServer
  service.ts      SKFactory({ name: 'writer', mongodb: true, config })
  config.ts       env: DB_DATABASE, WRITER_IGNORE_DUPLICATES
  types.ts        Config interface
  server.ts       express app (createApp) + http listener (startServer)
```

`createApp(db, config, counter)` is exported separately from `startServer` so
tests can mount the express app under supertest without binding a port.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_URL` | Yes | — | MongoDB connection string |
| `DB_DATABASE` | Yes | — | Target database |
| `WRITER_IGNORE_DUPLICATES` | No | `true` | `E11000` → `200` (with `duplicates: true`) when `true`; `500` when `false` |
