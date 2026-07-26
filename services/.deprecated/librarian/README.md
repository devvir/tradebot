# Librarian Service

HTTP↔MongoDB sidecar. Bulk-inserts JSON arrays of documents and serves
batched reads of a single collection, on the project's main database
(`DB_DATABASE`). Exists so CPU-heavy modules (farmer, digger, …) can offload
the BSON-encoding and mongo round-trips to a dedicated Node event loop —
recovering the throughput that a one-process pipeline loses to event-loop
contention.

The librarian holds no business logic, no doc-shape knowledge, no batch-sizing
intelligence: callers send batches small enough to fit one `insertMany` /
`find().toArray()`, and the librarian ships them through.

## What it does

- `POST /:table` — bulk-insert. Body is a non-empty JSON array of documents,
  passed to `db.<collection>.insertMany(docs, { ordered: false })`. Returns
  `{ inserted: <count> }`.
- `GET /:table?from=&limit=&filter=` — batched read. Sorts by `_id` ascending,
  returns `{ docs: [...] }` up to `limit` (default 10000, no upper cap). `from`
  is an `_id` value applied as `{ _id: { $gte: from } }` for stateless
  pagination. `filter` is an optional JSON object merged verbatim into the
  mongo query.
- Treats `E11000` on insert as success when `LIBRARIAN_IGNORE_DUPLICATES=true`
  (default); otherwise reports the conflict as `409`.
- Rejects oversized bodies (`413`), malformed bodies / query params (`400`),
  surfaces non-duplicate mongo errors (`500`).
- Logs read/write throughput every 5 seconds.
- `GET /health` for liveness probes.

## Reusability

Nothing about the librarian is tied to any one module. Any module that needs
HTTP-driven mongo access can extend the librarian compose service under its
own alias and set its own replica count — different modules can run their own
librarian pools against the same database without sharing instances.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_URL` | Yes | — | MongoDB connection string |
| `DB_DATABASE` | Yes | — | Target database |
| `LIBRARIAN_IGNORE_DUPLICATES` | No | `true` | When `true`, `E11000` on insert is reported as `200 { duplicates: true }`. When `false`, falls through to `409`. |

## Development

```sh
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/LIBRARIAN.md](../../docs/services/LIBRARIAN.md).
