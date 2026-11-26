# Review: vault (services/vault)

## Overall assessment

services/vault is the BitMEX-era CSV.gz HTTP file store (Express + @devvir/zipper). DATA_PIPELINE.md calls it 'the vault service'; it is not stocker's Parquet vault, and docs on both sides should keep that naming. The code is small and readable, but its HTTP boundary and per-file lifecycle have real integrity and safety defects, most of them reproduced in scratch scripts by both review lenses. The most serious: (1) graceful shutdown does not await writes already handed to zipper or seals in flight, so acknowledged rows are lost on routine restarts (deterministic for a SIGTERM right after POST /close); (2) nothing validates :table, :date or ?suffix=, so the unauthenticated API can create, read and unlink *.csv.gz / *.csv.gz.tmp outside /data/vault, including the read-write repo mount at /live; (3) a corrupt gzip in a free-text table crashes the whole process through an unhandled zlib 'error' event; (4) DELETE and PUT drop the zipper writer without aborting it, so queued members resurrect a deleted file without its header or splice live rows into an uploaded file; concurrent PUTs share one tmp path and can seal a corrupt file permanently. Further medium issues: a synchronous mkdir throw inside the 200 ms tick crashes the process, GET ?skip>0 on a missing file hangs, the comma-split reader silently misaligns quoted values, WS-table input is not validated (deletes become inserts on replay), pushMany overflows the stack above ~125k lines, a failed seal wedges the bucket, the health probe passes on a full disk and is not wired to the container healthcheck, there is no fsync anywhere, compositeIndex has no casts, and the prod Dockerfile starts dist/index.js which no service emits. Tests (127) pass but coverage is 0% exactly on health.ts, middleware.ts, server/index.ts, the shutdown drain, storeFile and the write-failure paths; some tests assert impossible behaviour. README.md, docs/services/VAULT.md and many source comments are false and break CLAUDE.md (consumer names journalist/courier, history wording).

Cross-cutting root causes: no validation at the HTTP boundary (one parseKey helper fixes a class of bugs); per-key lifecycle operations (rows, seal, PUT, DELETE) share no coordination beyond the `closing` set and writers are dropped rather than aborted (a per-key state/barrier module, VLT-25, is where VLT-04/05/11 should land); header presence is inferred from file existence instead of being a property of the write; synchronous throws and unhandled stream errors reach the top level with no handler.

Restructuring recommendation (owner decision, VLT-20): the producers named in vault's code (journalist, courier) no longer exist outside services/.deprecated and nothing in the repo calls vault's write API. Its current value is the read path over existing BitMEX history, which planned stocker work will normalise through. If vault becomes read-only (GET/list/headers/stats, maybe PUT), deleting buffers.ts, ticker.ts, close.ts, encode.ts, health.ts and most of writer.ts removes most write-path defects (VLT-01, 04, 06, 09, 10, 11, 12, 19). The read-path, validation and docs items (VLT-02, 03, 07, 08, 14, 15, 16, 18) apply either way and should be done first. Repro scripts are under reviews/2026-11/units/scratch/ (vault/, v/, f1v2/, f2v2/, f2-v2/, f3v2/, v2f1/, vault-*.js, bench-*.js, cov-vault/).

Counts: 1 critical, 3 high, 16 medium, 10 low; 26 implement, 4 deferred, 6 rejected suggestions.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| VLT-01 | critical | correctness | IMPLEMENT | Graceful shutdown loses acknowledged rows: only writers with leftover buffered lines are drained, seals in flight are not awaited, and the drain runs concurrently with server close |
| VLT-02 | high | security | IMPLEMENT | Path traversal and no date/suffix validation: :table, :date and ?suffix= build filesystem paths unchecked (create/read *.csv.gz, unlink *.csv.gz.tmp, mkdir, directory probing outside /data/vault) |
| VLT-03 | high | robustness | IMPLEMENT | A corrupt or non-gzip file in a free-text table crashes the process (unhandled gunzip 'error' event in csvRecords) |
| VLT-04 | high | correctness | IMPLEMENT | DELETE and PUT-over-open drop the zipper writer without aborting it: queued members resurrect the deleted file without its header, or are spliced into the uploaded file |
| VLT-05 | medium | correctness | IMPLEMENT | PUT is not atomic or validated: concurrent uploads share one tmp path and can seal a truncated or mixed file, renameSync can overwrite a sealed file, and empty or non-gzip bodies are sealed permanently |
| VLT-06 | medium | robustness | IMPLEMENT | A synchronous mkdir failure inside appendBatch escapes the 200 ms tick, crashing the process and dropping every batch flushed that tick |
| VLT-07 | medium | correctness | IMPLEMENT | GET /files/:table/:date?skip>0 on a missing or still-open file never responds |
| VLT-08 | medium | correctness | IMPLEMENT | Comma-split reader silently misaligns non-free-text rows whose values the writer quoted; no encode-to-decode round-trip test |
| VLT-09 | medium | correctness | IMPLEMENT | WS-table input not validated: a row without `action`, an empty `date`, or a client `_date_` key silently merges or splits messages |
| VLT-10 | medium | robustness | IMPLEMENT | POST /rows: spread push overflows the stack above ~125k lines, earlier items stay buffered after a 400, and unknown tables leave buffer entries behind |
| VLT-11 | medium | robustness | IMPLEMENT | A failed seal wedges the bucket until restart: the closing key is never cleared and the terminal zipper writer stays in the map |
| VLT-12 | medium | robustness | IMPLEMENT | Health recovery probe writes zero bytes and passes on a full disk; storage health is not wired to the container healthcheck |
| VLT-13 | medium | robustness | IMPLEMENT | No fsync on the durability path (seal rename, year directory, PUT store) |
| VLT-14 | medium | correctness | IMPLEMENT | compositeIndex has a header but no casts: its numeric fields are served as strings |
| VLT-15 | medium | config | IMPLEMENT | Prod Dockerfile starts dist/index.js, but vault (and every Node service) builds to dist/src/index.js; package.json main is wrong |
| VLT-16 | medium | docs | IMPLEMENT | docs/services/VAULT.md and services/vault/README.md contradict the code in many places |
| VLT-17 | medium | testing | IMPLEMENT | No tests on the risky paths: health, error middleware, server/index, shutdown drain, storeFile, write-failure handling, config validation, /stats |
| VLT-18 | medium | efficiency | IMPLEMENT | NDJSON read path emits one HTTP chunk per line |
| VLT-19 | medium | correctness | DEFER | Crash recovery: resuming a .csv.gz.tmp does not repair a torn final member, and files recreated after quarantine (or 0-byte tmps) get no header |
| VLT-20 | medium | design | DEFER | Decide vault's role: live writer or read-only server of the BitMEX CSV.gz archive |
| VLT-21 | low | robustness | IMPLEMENT | Error middleware turns body-parser 4xx (413, 415) into 500; /stats ignores ?suffix and 500s on a seal-rename race |
| VLT-22 | low | correctness | IMPLEMENT | S3 'D' timestamps are converted to ISO strings without a zone designator |
| VLT-23 | low | docs | IMPLEMENT | Source docblocks name consumer services, narrate history, or describe behaviour that is not there; truncate-failure branch is silent |
| VLT-24 | low | testing | IMPLEMENT | Tests that assert misleading behaviour, a fragile gzip-member helper with a false comment, non-production date forms, and over-mocked route tests |
| VLT-25 | low | code-quality | IMPLEMENT | Bucket lifecycle spread across routes, ticker, close and index, with triplicated header-prepend code |
| VLT-26 | low | code-quality | IMPLEMENT | Duplicate baseTable implementation and dead 'required' cast type |
| VLT-27 | low | code-quality | IMPLEMENT | Unused test export and a type named Buffer that shadows Node's global |
| VLT-28 | low | efficiency | IMPLEMENT | Per-row cast work: two objects, Object.entries and a regex baseTable lookup for every row |
| VLT-29 | low | security | DEFER | Unauthenticated API published on all host interfaces, repo mounted read-write at /live, requestTimeout = 0 |
| VLT-30 | low | efficiency | DEFER | Synchronous filesystem calls on request paths |

## VLT-01: Graceful shutdown loses acknowledged rows: only writers with leftover buffered lines are drained, seals in flight are not awaited, and the drain runs concurrently with server close

- **Severity:** critical
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/index.ts:14-35`
  - `services/vault/src/server/index.ts:29-41`
  - `services/vault/src/fs/writer.ts:70-97`
  - `services/vault/src/fs/writer.ts:130-137`
  - `services/vault/src/data/close.ts`
  - `services/vault/src/server/routes.ts:105-121`
  - `packages/service-kit/src/plugins/shutdown.ts:29-35`
  - `docs/services/VAULT.md:196-201`

**Problem.** The shutdown listener drains only keys returned by buffers.flushAll(), which skips empty buffers. A batch the ticker handed to a writer up to 200 ms earlier sits on that writer's zipper chain (async gzip then appendFile) and is never awaited. Seals started by POST /close are fire-and-forget and their buffer is already removed, so shutdown never sees them. service-kit runs all 'shutdown' listeners concurrently (Promise.all) and then calls process.exit(0), so vault's stopTicker/flushAll runs while server.close() still waits on in-flight requests: a POST /rows finishing after that point gets 202 and is dropped. An exit mid-append can also leave a torn gzip member (see VLT-19). requestTimeout = 0 lets one stalled upload hold server.close() open until Docker SIGKILLs. VAULT.md promises a sequential shutdown that awaits all write chains; neither is true.

**Evidence.** Second verifier ran the real built service under SIGTERM (scripts in reviews/2026-11/units/scratch/f1v2/): POST 100k rows then SIGTERM after 20-60 ms lost all 100001 lines with exit 0; POST 50k rows + POST /close + SIGTERM lost all 50001 lines in 8 of 8 trials. Lens B verifier (reviews/2026-11/units/scratch/f2-v2/repro.cjs, repro2.cjs): after _test_tick() the listener resolved with the .tmp not yet on disk; a POST /rows whose body was still arriving at shutdown got 202 and its line stayed in memory after all listeners resolved.

**Fix.** 1) fs/writer.ts: `export const drainAll = async () => { await Promise.allSettled([...writers.values()].map(w => w.flush())); await Promise.allSettled([...sealing]); }` with a module-level `sealing: Set<Promise<void>>` that appendBatch(seal=true) adds to and removes in finally (a seal's rename happens in writer.close(), after the chain, so flush() alone does not cover it). 2) server/index.ts: stop registering its own 'shutdown' listener; return `{ close(): Promise<void> }` that calls server.close() plus closeIdleConnections(), with a bounded deadline (~5-8 s, under Docker's 10 s grace) after which it calls closeAllConnections(). 3) index.ts: one ordered listener (export it as e.g. `shutdownVault({ close })` for tests): set a `shuttingDown` flag that makes POST /rows, /close, PUT and DELETE return 503; await http close; stopTicker(); flushAll() + appendBatch with header prepend (per-item try/catch, see VLT-06); await drainAll(); log. Do not rely on service-kit ordering listeners. 4) Replace requestTimeout = 0 with a socket inactivity timeout (e.g. req.setTimeout(60-120 s) in PUT) so a moving upload is never cut but a stalled one is. 5) Rewrite the VAULT.md Shutdown section to match (see VLT-16).

**Tests to add.** New tests/shutdown.test.ts with real buffers/writer over a temp DATA_DIR (mock fs/paths as writer.test does): (a) push > BATCH_SIZE lines, _test_tick(), run shutdownVault, assert the .tmp decodes to header + all lines when it resolves; (b) start appendBatch(seal=true)/closeBucket without awaiting, run shutdownVault, assert the .csv.gz exists with every line; (c) rows pushed while the injected close() is pending are on disk after resolve; (d) POST /rows returns 503 once shuttingDown is set and nothing is buffered; (e) no writer chain pending after resolve. Optional integration test spawning the service and sending SIGTERM right after POST /close, mirroring f1v2/driver_close.mjs.

**Verifier notes.** Lens A: first verifier rated high (narrow window, no active writer client today); second verifier reproduced deterministic loss on the seal path and rated critical. Lens B: both verifiers high. Taken as critical because loss of acknowledged rows on a routine restart is deterministic for the seal path.

## VLT-02: Path traversal and no date/suffix validation: :table, :date and ?suffix= build filesystem paths unchecked (create/read *.csv.gz, unlink *.csv.gz.tmp, mkdir, directory probing outside /data/vault)

- **Severity:** high
- **Category:** security
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/server/routes.ts:37-42`
  - `services/vault/src/server/routes.ts:54`
  - `services/vault/src/server/routes.ts:105-121`
  - `services/vault/src/server/routes.ts:126-153`
  - `services/vault/src/server/routes.ts:162-199`
  - `services/vault/src/server/routes.ts:204`
  - `services/vault/src/server/routes.ts:235-240`
  - `services/vault/src/server/routes.ts:263-282`
  - `services/vault/src/fs/paths.ts:5-8`
  - `services/vault/src/fs/writer.ts:105-128`
  - `services/vault/src/fs/reader.ts:50-93`
  - `services/vault/docker/base.yml:26-27`
  - `services/vault/tests/server/routes.test.ts`

**Problem.** filenameOf concatenates the :date param with any ?suffix= string, :table is used raw, and paths.ts feeds both to path.join under DATA_DIR with no containment check. Express 5 decodes %2F in params and the query string is free-form. So PUT writes an attacker body to any `<x>.csv.gz` uid 1000 can write (mkdir -p for the year dir), GET decodes any *.csv.gz, DELETE unlinks any *.csv.gz.tmp, and GET /files/:table returns 200 {} instead of 404 for any existing directory. The API is unauthenticated, published on the host (VLT-29) and the container mounts the repo read-write at /live. Bad dates are also accepted: yearDir is filename.slice(0,4), so `2024-01-01`, `abc` or `20241399` are written but listFiles (requires ^\d{4}$ and ^\d{8}) never lists them. /stats reads req.params.date directly.

**Evidence.** Both lenses reproduced with real Express 5.2.1: `/files/..%2F..%2Flive/20240101` gives table `../../live`, path `/live/2024/20240101.csv.gz`; `?suffix=/../../../../../live/x` resolves to `/live/x.csv.gz`; GET with an encoded suffix returned 200 with rows of a gzip outside DATA_DIR ({"secret":"hunter2"}); built paths.js `closedPath('x','20240101./../../../../live/somewhere/name')` returned `/data/live/somewhere/name.csv.gz`. Scripts: reviews/2026-11/units/scratch/vault/exp1.js, vault-traversal.js, v/ex.cjs, v2f1/r.cjs.

**Fix.** Add one helper in routes.ts, e.g. `parseKey(req, res): { table, filename } | null`, used by every route taking :table or :date: POST rows, POST close, GET file, GET headers, PUT, DELETE, GET /files/:table and GET /stats. Rules: table `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)?$` (keeps pseudo-tables like orderBookL2.secondary); for write routes also require headersFor(table) (PUT may accept any valid name, since the read path casts tables stored by PUT; see VLT-26); date `^\d{8}$` plus a calendar round-trip check via Date.UTC; suffix, when present, `^[A-Za-z0-9_-]{1,32}$` (no dots, no slashes). Return 400 {error}; for PUT call req.resume() before responding. Defence in depth in paths.ts: path.resolve the result and throw unless it starts with DATA_DIR + path.sep.

**Tests to add.** routes.test.ts: GET/PUT/DELETE/POST rows with table `..%2Fx` return 400; `?suffix=%2F..%2Fx` and `?suffix=a.b` return 400; dates `abc`, `2024-01-01`, `20241399`, `20230230`, `2024%2F..%2Fx` return 400 on PUT, POST rows, GET, DELETE and /stats; GET /files/..%2F..%2Ftmp returns 400. Move every test date in routes.test.ts (and other tests, see VLT-24) to the 8-digit form. New tests/fs/paths.test.ts: closedPath('x','20240101./../../../../../live/n') and openPath('../..','20240101') throw.

**Verifier notes.** Merges lens A F3 + F15 and lens B F1. Lens A first verifier rated medium (writes limited to .csv.gz extensions); lens B both verifiers and lens A reviewer rated high. Taken as high: unauthenticated create/read/delete outside the data dir, including the source tree.

## VLT-03: A corrupt or non-gzip file in a free-text table crashes the process (unhandled gunzip 'error' event in csvRecords)

- **Severity:** high
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/data/parse.ts:87-101`
  - `services/vault/src/data/parse.ts:147-153`
  - `services/vault/src/fs/reader.ts:30-35`
  - `services/vault/src/index.ts`

**Problem.** csvRecords does `stream.pipe(createCsvParser(false))` and iterates the parser. pipe does not forward source errors and zipper's reader returns a bare gunzip with no error listener, so a gunzip failure (torn tail, non-gzip bytes, truncated member) is an unhandled 'error' event and Node exits; vault and service-kit register no uncaughtException handler. In-memory buffers for every table are lost. Reached by GET /files/:table/:date and /headers for announcement, chat, publicNotifications and their pseudo-tables. The comma-split path (readline) propagates the error and survives. Triggerable on purpose: PUT junk to /files/chat/<date> (VLT-05), then GET.

**Evidence.** Lens A second verifier, against built routes (reviews/2026-11/units/scratch/f2v2/repro.js): GET /files/chat/20240101 on a gzip with its last 10 bytes cut exits code 1 with `Unhandled 'error' event ... Z_BUF_ERROR`; same for announcement; non-gzip bytes crash both GET and /headers with Z_DATA_ERROR; /headers on a torn tail returns 200 (header parsed first). Control: same torn file under a comma-split table is logged and the client gets ECONNRESET.

**Fix.** In parse.ts csvRecords: `const parser = createCsvParser(false); const done = pipeline(stream, parser).catch(err => parser.destroy(err)); try { for await (const r of parser) yield r; } finally { await done.catch(() => {}); }` (pipeline from node:stream/promises), or `stream.on('error', err => parser.destroy(err))` before piping. rfc4180's finally must still call close(). The GET handler's existing stream error path then logs and destroys / returns 500; /headers falls into its catch and returns 500. Defence in depth (optional): process.on('uncaughtException') in index.ts that logs fatal and calls service.shutdown('error') so buffers are drained.

**Tests to add.** tests/data/parse.test.ts with a real file under a mocked closedPath: createParser('chat').read() on a truncated gzip rejects with code Z_BUF_ERROR; on non-gzip bytes rejects with Z_DATA_ERROR; no unhandled error is reported (vitest fails on those by default). Route test: GET of a truncated chat file ends with a destroyed response or 500, not a hang or crash; /headers on a file truncated inside the first member returns 500.

**Verifier notes.** All three verifications confirmed high. The 'hang' described by the reviewer appears only under harnesses that catch the error; in production the outcome is the crash.

## VLT-04: DELETE and PUT-over-open drop the zipper writer without aborting it: queued members resurrect the deleted file without its header, or are spliced into the uploaded file

- **Severity:** high
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/fs/writer.ts:53-57`
  - `services/vault/src/fs/writer.ts:121-128`
  - `services/vault/src/fs/writer.ts:141-166`
  - `services/vault/src/server/routes.ts:173-181`
  - `services/vault/src/server/routes.ts:190-199`
  - `services/vault/src/data/ticker.ts:42`

**Problem.** deleteFile unlinks the .csv.gz.tmp and removes the map entry but never calls writer.abort() or awaits the chain. zipper writes each member with a path-based fs.promises.appendFile, which re-creates the file. Members queued by an earlier, unawaited tick therefore land after the delete: (a) DELETE is undone and the recreated file has no header; isInitialized (existsSync) then reports true, so it is sealed headerless and decodes with a data row as column names; (b) PUT over an open file streams into the same tmp path, so stale members end up inside the sealed upload, or the upload's write stream overwrites part of an O_APPEND member and the permanent .csv.gz is corrupt; (c) PUT/DELETE during an in-flight close let the old writer rename whatever is at tmp. Neither route checks `closing`. Calling abort() on a closing writer returns the pending close promise, so the file would be sealed anyway.

**Evidence.** Lens A (reviews/2026-11/units/scratch/vault/race.test.ts): after delete+drain the tmp exists; sealed content starts with a data row; PUT case decodes 2001 rows with the live row at index 2000. Lens B (vault-delete-race.js): 'after queued write settles, tmp exists: true isInitialized: true'; PUT result 5003 lines with 5000 stale rows. Lens B second verifier (reviews/2026-11/units/scratch/f3v2/repro2.js): fast upload leaves a headerless 10001-line .tmp next to the sealed file; a two-chunk upload produced a sealed .csv.gz failing gunzip ('incorrect header check', gzip -t rc=2).

**Fix.** fs/writer.ts: make deleteFile async (or add `discard`): take the writer, `if (w) await w.abort()`, remove the map entry, then unlink openPath if it still exists (covers no-writer and resumed-from-disk cases). While it runs, hold the key in a per-key barrier (`discarding`, or the shared busy set from VLT-25) that POST /rows, /close, PUT and DELETE answer with 409, so a new writer created by a tick cannot be unlinked by the old abort's final unlink. Put flush/remove buffer + barrier + abort/unlink in one data-layer function `discardBucket(table, filename)` used by both routes. In routes.ts make PUT and DELETE async, return 409 while closing.has(key), await discardBucket before storeFile / before 204, and wrap DELETE in try/catch -> 500.

**Tests to add.** writer.test.ts over a temp dir: appendBatch (not awaited) then await deleteFile leaves no .tmp after drainHandle; queued append, await deleteFile, then storeFile with a body chunked by a delay -> .csv.gz equals exactly the uploaded bytes and no .tmp remains; POST rows during a discard gets 409 and the new writer is not unlinked. routes.test.ts: DELETE and PUT while closing return 409; DELETE right after a tick flush leaves fileState 'none'. Update _test_reset callers for the async deleteFile.

**Verifier notes.** Merges lens A F4 (first verifier: medium, normal courier usage targets days with no live writer) and lens B F3 (both verifiers high, second reproduced permanent-file corruption). Taken as high. Lens B first verifier flagged the barrier requirement that the original fix missed.

## VLT-05: PUT is not atomic or validated: concurrent uploads share one tmp path and can seal a truncated or mixed file, renameSync can overwrite a sealed file, and empty or non-gzip bodies are sealed permanently

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/fs/writer.ts:99-119`
  - `services/vault/src/server/routes.ts:162-186`
  - `services/vault/src/server/middleware.ts:19-20`

**Problem.** storeFile always streams to the shared openPath() (flags 'w') then renameSync(tmp, dest), and the route's fileState check runs before the upload (TOCTOU). Two overlapping PUTs for one key: the first to finish renames the shared inode while the second still writes into it, so the 204 client's data can be replaced by the other upload plus trailing garbage, or a later abort leaves dest permanently truncated (re-PUT then 409). renameSync silently overwrites a dest created in the gap. A PUT that crashes mid-upload leaves something fileState reports as 'open'. No body validation: an empty or non-gzip body gets 204 and is sealed, after which GET is 500 forever and PUT is 409, until someone deletes the file by hand.

**Evidence.** Lens B (reviews/2026-11/units/scratch/vault-put-race.js): 'A ok' / 'B err ENOENT'; final file decodes entirely as B; gzip -t 'trailing garbage ignored' (exit 2). Lens A (vault/misc.test.ts): empty PUT to /files/trade/20240301 -> 204 size 0, retry -> 409, GET -> 500 'Read failed'; 'this is not gzip' -> 204 then GET 500.

**Fix.** In storeFile write to a unique temp name outside the streaming namespace: `${closedPath}.upload-${randomUUID()}` opened 'wx' via a FileHandle (listFiles already ignores names not ending .csv.gz/.csv.gz.tmp). Count bytes with a pass-through Transform; after the pipeline, verify with `pipeline(createReadStream(part), zlib.createGunzip(), new Writable({write(_c,_e,cb){cb()}}))` (handles multi-member), or tee through gunzip in the same pass. If bytes === 0 or gunzip fails, unlink the part file and throw a typed InvalidUploadError (route maps to 400). Then `await fh.sync()`, close, publish with `fs.promises.link(part, dest)` (EEXIST -> 409, never overwrites), unlink part, fsync the year dir (shares fsyncDir with VLT-13). On error unlink only this request's part file. In routes.ts keep a per-key `uploading` set (shared busy set, VLT-25): PUT returns 409 while uploading or closing. Remove stale `*.upload-*` files at startup or document them, and fix the storeFile docblock / VAULT.md lines that say a crashed upload leaves an open file.

**Tests to add.** writer.test.ts storeFile block: success (closed file present, no temp left); source erroring mid-stream rejects and leaves neither temp nor dest; empty body and non-gzip body rejected; a failed upload does not make fileState report 'open'; two concurrent storeFile calls -> exactly one succeeds and dest equals its bytes. Route tests: empty PUT -> 400 and fileState 'none'; 'not gzip' -> 400; valid gzip -> 204 and readable; second PUT while the first is streaming -> 409.

**Verifier notes.** Merges lens A F5 and F9 and lens B F4; storeFile fsync from lens A F10 is folded in here. All verifiers medium. Corrections: if PUT2 completes, dest holds PUT2's full content and only PUT2 gets a spurious 500; a client that destroys its socket and retries usually just fails the retry. No in-repo PUT client exists today. The reviewer's Content-Length check and 'require non-JSON content type' are dropped as redundant (see Rejected).

## VLT-06: A synchronous mkdir failure inside appendBatch escapes the 200 ms tick, crashing the process and dropping every batch flushed that tick

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/fs/writer.ts:70-97`
  - `services/vault/src/fs/writer.ts:141-148`
  - `services/vault/src/data/ticker.ts:31-46`
  - `services/vault/src/data/buffers.ts:99-115`
  - `services/vault/src/index.ts:22-30`
  - `services/vault/src/data/close.ts`

**Problem.** appendBatch is not async and calls getOrCreateWriter, which runs mkdirSync before any promise exists. A throw (EACCES when /data/vault is not mounted or owned by uid 1000, ENOSPC/inodes on a new year or table dir, EROFS, ENOTDIR) skips the caller's .catch and leaves tick(). flushReady has already spliced lines out of every ready buffer, so other files' batches in that tick are dropped too, and the throw escapes setInterval as an uncaught exception. Storage health (503 + canary) never engages. base.yml says the volume is optional and the prod image creates no /data, so a misconfigured deploy crash-loops instead of returning 503. The shutdown loop has the same synchronous throw; in closeBucket it becomes a 500.

**Evidence.** Lens A (reviews/2026-11/units/scratch/vault/tick.test.ts): make <data>/funding a regular file, buffer 10k lines each for funding/20240101 and tick/20240101, _test_tick() -> `tick threw: ENOTDIR ... mkdir '.../funding/2024'` and `tick buffer remaining: 0 tick file exists: false`.

**Fix.** Make appendBatch async (or wrap its body in try/catch returning Promise.reject(err)) so every caller's .catch sees the error. In tick(), handle each batch in its own try/catch: log, call recordFailure(...) so health goes 503 after the threshold, and optionally put the lines back with a new LineBuffer.unshiftMany (the 503 caps growth). Same per-item handling in the shutdown loop (VLT-01). Also make tick tolerate the 'no header definition' throw per batch (test at ticker.test.ts:65-70 then becomes 'logs and continues flushing other tables', see VLT-24).

**Tests to add.** ticker.test.ts: with <data>/funding a regular file, _test_tick() does not throw and after draining tick/20240101's tmp exists with its rows; recordFailure is called for the failing file.

**Verifier notes.** Lens A only; reviewer high, verifier medium (misconfiguration or full disk at directory creation; loud rather than silent). Taken as medium.

## VLT-07: GET /files/:table/:date?skip>0 on a missing or still-open file never responds

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/server/routes.ts:126-153`

**Problem.** With skip>0 the handler calls res.flushHeaders() before the lazy generator opens the file. openClosedFile then throws NotFoundError on the first pull, the error handler only responds `if (!res.headersSent)` with no else, and stream.pipe(res) does not end the destination on source error. The client gets 200 and a body that never ends. Same for a day that is still open (only .csv.gz.tmp exists).

**Evidence.** Both lenses reproduced (reviews/2026-11/units/scratch/vault/hang.test.ts, vault-skip404.js): without skip 404 in ~20 ms; with ?skip=1 or ?skip=5 the client times out after 3 s and the response never ends.

**Fix.** Before building the stream, for every request: `if (fileState(table, filename) !== 'closed') { res.status(404).json({ error: `No closed file for ${table}/${filename}` }); return; }` (race-free: nothing in vault deletes a closed file). In the stream error handler, when res.headersSent call res.destroy(err) for every error type, NotFoundError included.

**Tests to add.** routes.test.ts: GET ?skip=1 on a missing day returns 404 and ends; on an open day (rows flushed, not closed) returns 404; an error after headers are flushed destroys the response.

**Verifier notes.** Lens A F8 + lens B F5. Lens B reviewer said high; both verifiers medium (skip implies the file usually existed).

## VLT-08: Comma-split reader silently misaligns non-free-text rows whose values the writer quoted; no encode-to-decode round-trip test

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/data/parse.ts:10-13`
  - `services/vault/src/data/parse.ts:46-75`
  - `services/vault/src/data/parse.ts:139-167`
  - `services/vault/src/data/encode.ts:21-50`
  - `services/vault/src/server/routes.ts:88-98`
  - `shared/utils/src/csv.ts:28-36`
  - `shared/utils/src/tables.ts:310-326`
  - `services/vault/tests/data/decode.test.ts:121-135`

**Problem.** Every table outside FREE_TEXT_TABLES is read by a plain line.split(','), justified by the claim that those tables hold only numbers, symbols and ISO timestamps. The write path never enforces it: encode uses rowToCsv, which RFC 4180-quotes values containing `,`, `"` or `\n` and JSON-stringifies objects. Such a value reads back with shifted columns, a literal quote, and NaN -> null numbers, with no error; an embedded newline splits a record (fake continuation rows on WS tables). Files already on disk are not protected by a write-side check alone. No test round-trips a row from encode through disk to decode; decode.test's 'quoted field containing a comma' test feeds a pre-parsed record for orderBookL2 and hides the gap.

**Evidence.** Lens A (reviews/2026-11/units/scratch/vault/misc.test.ts): POST tick {symbol:'XBT,USD', price:5} then GET returns {"symbol":"\"XBT","price":null,"tickDirection":"5"}. Lens B verifier: liquidation orderID 'a,b' -> `d,insert,"a,b",...` splits into ['d','insert','"a','b"',...].

**Fix.** (1) Reader: in commaSplit, for a line containing `"`, use a quote-aware single-line RFC 4180 splitter (or csv-parse sync on that one line); if quotes are unbalanced (embedded newline split the record) throw Error('quoted multi-line field in comma-split table <table>/<filename>') rather than yielding misaligned fields. Lines without `"` keep the fast split. (2) Writer: in encode(), for tables not in FREE_TEXT_TABLES, reject any value that is an object or whose String() contains `,`, `"` or `\n`, naming the column; the route maps encode errors to 400. This is only safe together with VLT-10's encode-all-then-push, otherwise a 400 leaves a partial batch that the retry duplicates.

**Tests to add.** New tests/data/roundtrip.test.ts over a temp DATA_DIR: for each TABLE_HEADERS table encode a representative row/message, write header+lines through appendBatch(seal)/closeBucket, decodeFile, compare with the expected typed object (pins lossy behaviour: null/'' omitted, booleans, timestamp_D rewrite, number casts; compositeIndex fails until VLT-14). Cases: WS message with data: [], continuation rows, chat text with comma/quote/newline, null field omitted, a .secondary pseudo-table. Plus: POST a comma value on tick -> 400 with nothing buffered; a hand-built tick file with a quoted comma reads correctly; an embedded newline -> 500, not wrong data.

**Verifier notes.** Merges lens A F11 (medium) and lens B F22 (low; verifier recommended reader-side tolerance and warned about partial batches). Latent in practice (BitMEX values in these tables have no commas) but silent corruption on the read path that planned normalisation depends on.

## VLT-09: WS-table input not validated: a row without `action`, an empty `date`, or a client `_date_` key silently merges or splits messages

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/server/routes.ts:80-86`
  - `services/vault/src/data/encode.ts:21-48`
  - `services/vault/src/data/encode.ts:273-281`
  - `services/vault/src/data/decode.ts:58-75`

**Problem.** The on-disk message boundary for WS tables is a non-empty _date_ cell. The rows route only validates items that have `action`, so a bare object on a WS table is encoded as a continuation row and appended to the previous message on read. `msg.date ?? new Date()` keeps '', so date: '' merges the whole message into the previous one. A client _date_ key in data rows forges a boundary. A comma in date is mis-split (VLT-08).

**Evidence.** Lens A (reviews/2026-11/units/scratch/vault/misc.test.ts): insert message, bare row, then {action:'delete', date:''} on liquidation read back as ONE insert message with three rows; the delete is lost.

**Fix.** In POST /rows, when WS_TABLES.has(baseTable(table)): every item must have action in [partial, insert, update, delete], Array.isArray(data), every data element a plain object, and date (when present) a string matching `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`; otherwise 400 before buffering anything. For non-WS tables reject items carrying `action` or `data` (no REST table has an action column). In encodeMessage, build each row from a copy without _date_/_action_.

**Tests to add.** routes.test.ts: bare row to liquidation -> 400; date: '' -> 400; REST item with action -> 400; a data row containing _date_ does not create a new message on read; a valid message still round-trips.

**Verifier notes.** Lens A only; reviewer and verifier medium. No active writer in the repo, but cheap boundary validation that prevents silent replay divergence (deletes applied as inserts).

## VLT-10: POST /rows: spread push overflows the stack above ~125k lines, earlier items stay buffered after a 400, and unknown tables leave buffer entries behind

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/data/buffers.ts:24`
  - `services/vault/src/server/routes.ts:88-98`
  - `services/vault/src/server/index.ts:18`

**Problem.** pushMany does lines.push(...many); on Node 22 this throws RangeError at ~130k elements. One WS message with >125k data rows (~10 MB, under the 50 MB body limit) therefore always gets 400 and can never be stored. Items earlier in the same body were already pushed, so the client is told 400 while part of the request is buffered, and its retry duplicates them. buffers.get runs before encode, so every POST for an unknown table leaves an empty map entry keyed by caller-chosen table/filename (unbounded growth).

**Evidence.** Lens B verifier on Node 22: spread push succeeds at 125,000 and throws 'Maximum call stack size exceeded' at 130,000. routes.ts:88 creates the buffer before the per-item encode/push loop at :90-93.

**Fix.** buffers.ts: `for (const l of many) lines.push(l);`. routes.ts: check headersFor(table) first and 400 'No header definition for table ...' before touching buffers; encode every item into a local string[][] inside the try; only after all succeed call buffers.get(...) and push each array.

**Tests to add.** buffers.test: pushMany accepts 200k lines and count() is 200000. routes.test: a WS message with 200k data rows -> 202; second item failing to encode -> nothing from the request buffered; unknown table -> 400 and no buffer entry (test helper exposing map size).

**Verifier notes.** Lens B only; reviewer and verifier medium. The verifier noted the never-storable large message is worse than the duplicate-on-retry case.

## VLT-11: A failed seal wedges the bucket until restart: the closing key is never cleared and the terminal zipper writer stays in the map

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/server/routes.ts:30-33`
  - `services/vault/src/server/routes.ts:113-121`
  - `services/vault/src/fs/writer.ts:85-97`
  - `services/vault/src/fs/writer.ts:141-145`

**Problem.** When closeBucket rejects, the route only logs: closing keeps the key, so POST /rows gets 409 'File is closed' while the file is still .csv.gz.tmp. appendBatch deletes the writer only on seal success; zipper memoises `terminal`, so a retried close returns the same rejection and writes reject 'cannot write to a closed writer'. Triggers: rename ENOENT (e.g. after VLT-04's unlink) or zipper firstError (gzip failure or failed quarantine rename). The client got 202 for the close. The routes.ts:30-33 comment ('Append-only ... Never cleaned up') contradicts line 116.

**Evidence.** routes.ts:115-119 `.then(() => closing.delete(key)).catch(err => logger.error(...))`; writer.ts:85-96 writers.delete only in the success .then; zipper writer.js `close: () => { if (terminal) return terminal; ... }`.

**Fix.** writer.ts seal chain: `.finally(() => writers.delete(key))` before the rethrowing catch, so the next write or close creates a fresh writer that resumes the .tmp. Close route: `.catch(log).finally(() => closing.delete(key))`. Rewrite the routes.ts:30-33 comment: the set holds buckets whose close is in progress, rows for them get 409, an entry is removed when the close settles. Optionally surface seal failures (recordFailure or a /stats field).

**Tests to add.** routes.test: after closeBucket rejects once, POST /rows is accepted again and a second /close seals the file. writer.test: appendBatch(seal) after a failed seal (tmp removed under it) creates a new writer instead of rejecting.

**Verifier notes.** Lens A F14 (low) + lens B F6 (medium). Lens A verifier noted firstError is rarer than claimed (auto recovery resolves most failed members). Taken as medium: rare trigger, but the bucket stays wedged with a misleading 409.

## VLT-12: Health recovery probe writes zero bytes and passes on a full disk; storage health is not wired to the container healthcheck

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/fs/health.ts:121`
  - `services/vault/src/fs/health.ts:132-144`
  - `services/vault/docker/base.yml:28-33`
  - `packages/service-kit/src/plugins/health.ts:32-37`

**Problem.** tryRecover does appendFileSync(CANARY_PATH, ''), which allocates no blocks, so on ENOSPC the probe succeeds 5 s after vault goes unhealthy. POST /rows returns 202 again, zipper's auto recovery drops the members, and the cycle repeats, losing acknowledged rows. Vault registers no 'healthCheck' listener, so service-kit's :3000/health (used by the compose healthcheck) always answers 200 while vault answers 503.

**Evidence.** Lens B verifier on a filled 64 KiB tmpfs: appendFileSync(p, '') succeeds, appendFileSync(p, Buffer.alloc(4096)) fails ENOSPC. grep finds no healthCheck in services/vault/src.

**Fix.** In tryRecover: open 'w', writeSync Buffer.alloc(4096), fsyncSync, close, unlink; on failure best-effort unlink the partial canary (staying synchronous is fine: runs once per 5 s only while unhealthy). In index.ts (or createServer) register `service.on('healthCheck', res => { const ok = isHealthy(); res.writeHead(ok ? 200 : 503, {'Content-Type':'application/json'}); res.end(JSON.stringify({ status: ok ? 'ok' : 'unhealthy', reason: getFailureReason() })); })`.

**Tests to add.** New tests/fs/health.test.ts with fake timers and mocked fs: 5 recordFailure within 60 s -> unhealthy with reason; failures older than 60 s pruned; probe failure reschedules; probe success resets; a probe whose payload write throws ENOSPC keeps vault unhealthy; setBackpressure idempotent and isThrottled per path (use health._test_reset). healthCheck listener returns 503 while unhealthy.

**Verifier notes.** Lens B only; reviewer and verifier medium. Verifier dropped the 'make the probe async' part as unnecessary.

## VLT-13: No fsync on the durability path (seal rename, year directory, PUT store)

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/fs/writer.ts:84-96`
  - `services/vault/src/fs/writer.ts:111-113`
  - `services/vault/src/fs/writer.ts:141-148`

**Problem.** Neither storeFile nor zipper's appendFile/close-rename fsync the file or directory. The seal and PUT rename onto a new name, so ext4's replace-on-rename heuristic does not apply; after power loss a sealed .csv.gz can be zero-length or short, and it is then permanent (409 on re-PUT).

**Evidence.** writer.ts:112-113 `await pipeline(source, createWriteStream(tmp)); renameSync(tmp, dest);`; grep of the zipper dist finds no fsync/fdatasync/sync( call.

**Fix.** Add helpers fsyncFile(path) and fsyncDir(dir) (open, FileHandle.sync, close). Seal path in appendBatch: `written.then(() => fsyncFile(openPath(...))).then(() => writer.close()).then(() => fsyncDir(yearDir(...)))`. fsync the year dir right after mkdirSync creates it. storeFile's fsync is part of VLT-05. Per-member fdatasync is a throughput trade-off left to the owner (not part of this item).

**Tests to add.** Spy on FileHandle.sync to assert seal and storeFile call it for the file and the year dir; seal and storeFile still produce readable files. No real power-loss test.

**Verifier notes.** Lens A only; reviewer and verifier medium. Rare trigger, permanent cost for a data store, fixable inside vault without touching zipper.

## VLT-14: compositeIndex has a header but no casts: its numeric fields are served as strings

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/data/headers.ts:23`
  - `services/vault/src/data/casts.ts:34-155`
  - `services/vault/src/data/casts.ts:165`

**Problem.** TABLE_HEADERS defines compositeIndex and files exist from the deprecated scribe, but TABLE_CASTS has no entry and applyCasts falls back to {}, so lastPrice, weight etc. are strings unlike every other table's prices. Nothing checks that each headered table has casts.

**Evidence.** grep compositeIndex services/vault/src finds only headers.ts:23; casts.ts:165 `TABLE_CASTS[baseTable(table)] ?? {}`.

**Fix.** Add `compositeIndex: num('indexMultiplier', 'lastPrice', 'sourcePrice', 'conversionIndexPrice', 'weight')`, checked against a real vault file (conversionIndex and reference are symbols, logged is a timestamp; REST timestamps are ISO, no tsD). Do not derive from TABLE_SPECS: it has no compositeIndex or tick entry. Export TABLE_CASTS or a test helper.

**Tests to add.** casts.test: every key of TABLE_HEADERS has a TABLE_CASTS entry; applyCasts({lastPrice:'23000.5', weight:'0.25', symbol:'.BXBT'}, 'compositeIndex') gives numbers for lastPrice/weight and a string for symbol.

**Verifier notes.** Lens B only; reviewer and verifier medium. The reviewer's 'derive from TABLE_SPECS' alternative is rejected (does not cover compositeIndex).

## VLT-15: Prod Dockerfile starts dist/index.js, but vault (and every Node service) builds to dist/src/index.js; package.json main is wrong

- **Severity:** medium
- **Category:** config
- **Decision:** IMPLEMENT
- **Locations:**
  - `docker/prod.node.Dockerfile:62`
  - `services/vault/docker/base.yml:10-12`
  - `services/vault/package.json:5-9`
  - `docker/node/entrypoint.sh`

**Problem.** base.yml defaults to docker/${APP_ENV:-prod}.node.Dockerfile, whose CMD runs `node ... dist/index.js`. composite: true with no rootDir makes tsc emit dist/src/index.js (dist contains only src and tsconfig.tsbuildinfo). package.json start and the dev entrypoint use dist/src/index.js; main says dist/index.js. A prod vault container exits with MODULE_NOT_FOUND and restart-loops. Dev works only because .env.example sets APP_ENV=dev.

**Evidence.** `ls services/vault/dist` -> `src tsconfig.tsbuildinfo`; prod.node.Dockerfile:62 `exec node --max-old-space-size=${NODE_MEMORY_MB} dist/index.js`; entrypoint.sh uses `services/${SERVICE_NAME}/dist/src/index.js`.

**Fix.** Set `"main": "dist/src/index.js"` in services/vault/package.json. Change docker/prod.node.Dockerfile:62 CMD to `dist/src/index.js`; this file is shared by every Node service (catalog, hauler, hoarder, pipe, prospector, router, stocker, catalog-ui), so make the change once and coordinate with the other units' reports rather than per service; fix their package.json main for consistency. Do not change rootDir. If possible verify with `docker build --build-arg SERVICE_NAME=vault -f docker/prod.node.Dockerfile .` and docker run.

**Tests to add.** Build check only (optional docker build/run smoke test).

**Verifier notes.** Lens A F18 (medium) + lens B F16 main part. Repo-wide, outside services/vault scope for the Dockerfile line.

## VLT-16: docs/services/VAULT.md and services/vault/README.md contradict the code in many places

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/README.md:3`
  - `services/vault/README.md:7`
  - `services/vault/README.md:10`
  - `services/vault/README.md:26`
  - `services/vault/package.json:4`
  - `docs/services/VAULT.md:30`
  - `docs/services/VAULT.md:32`
  - `docs/services/VAULT.md:34`
  - `docs/services/VAULT.md:54`
  - `docs/services/VAULT.md:56`
  - `docs/services/VAULT.md:67-70`
  - `docs/services/VAULT.md:74`
  - `docs/services/VAULT.md:147-158`
  - `docs/services/VAULT.md:164`
  - `docs/services/VAULT.md:180`
  - `docs/services/VAULT.md:196-201`
  - `docs/services/VAULT.md:207-218`

**Problem.** README: port 80 (code: 8000; health on 3000), 'No environment variables' (VAULT_COMPRESSION_LEVEL, 1-9, default 6, invalid fails startup), 'streams open and closed files' (only closed files are readable), 'a live gzip stream' (each flush appends a self-contained member). VAULT.md: csv-parse 'end-to-end on the read path' (only FREE_TEXT_TABLES; others comma-split); REST table list omits tick, trade, quote and the bin tables; POST /rows errors omit 429 and the unknown-table 400; 'a failed upload leaves an open file' (storeFile unlinks; only a crash leaves one); write-safety and serialisation sections describe an old implementation (handle.writing, sidecar-and-continue) instead of zipper's quarantine to .failed.N; 'append-only closing set' (deleted on success); handles.has (now writers.has); strict shutdown order and 'all open write chains are awaited' (false, VLT-01); 'every :date endpoint accepts ?suffix=' (not /stats, which is undocumented); tuning table omits MAX_INFLIGHT/INFLIGHT_RESUME and VAULT_COMPRESSION_LEVEL; base URL omits port 8000. CLAUDE.md wording: history at l.56 ('identical to never having heard of suffixes'), future at l.30 ('any future variant'). package.json description is stale.

**Evidence.** Each claim checked by lens verifiers against server/index.ts:13 (PORT = 8000), config.ts:6-23, reader.ts:21-25, parse.ts:31-74, writer.ts:114-116, routes.ts:58-61 and :116, writer.ts:56, service-kit shutdown.ts:29-30, routes.ts:265.

**Fix.** Rewrite docs/services/VAULT.md as the single deep article describing only today's code (after VLT-01/02/04/05 land, describe the shipped behaviour): (a) name it 'the vault service' (CSV.gz), distinct from the Parquet vault; (b) read path: both strategies (RFC 4180 via createCsvParser for FREE_TEXT_TABLES; physical-line comma split otherwise) and the invariant, naming the membership sets in @tradebot/utils instead of hand lists; (c) API at http://vault:8000 with complete status lists (POST /rows 202/400/409/429/503; PUT 204/400/409/500; GET /stats/:table/:date {state,size,mtime,birthtime} or 404); suffix sentence as 'Without ?suffix= the filename is the date'; (d) one write paragraph: one @devvir/zipper writer per open file with retries 3, backoff 100 ms, recovery 'auto', water marks 15/5 -> per-path 429; what onWriteFailure does (recordFailure; truncate failure writes a .csv.gz.error sidecar naming the quarantine path); point to zipper's README for mechanics; verify in zipper whether the fresh file after quarantine has a header before stating it (see VLT-19); (e) closing barrier removed when the seal settles; restart uses writers.has; (f) shutdown as implemented; (g) tuning table incl. MAX_INFLIGHT 15, INFLIGHT_RESUME 5, VAULT_COMPRESSION_LEVEL; HTTP 8000, health 3000; (h) remove history/future wording. Cut README to a few lines: purpose, dev commands, port 8000 / health 3000, VAULT_COMPRESSION_LEVEL, data dir /data/vault must be a writable volume, closed files only, pointer to VAULT.md. package.json description: 'Date-partitioned CSV.gz file store with an HTTP API for row ingestion, upload, seal, delete, read, list and stats'.

**Tests to add.** None (docs). Review each statement against code after the code fixes land.

**Verifier notes.** Merges lens A F19 (docs part; verifier raised low -> medium because the user asked for a docs fresh start), lens B F17 and F18 (both medium). Lens A verifier did not verify the 'quarantined file is replaced by a headerless file' claim; lens B F7 verifier traced it in zipper (fresh target starts with the failed data member). Check before documenting.

## VLT-17: No tests on the risky paths: health, error middleware, server/index, shutdown drain, storeFile, write-failure handling, config validation, /stats

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/fs/health.ts:31-156`
  - `services/vault/src/server/middleware.ts:10-35`
  - `services/vault/src/server/index.ts:13-41`
  - `services/vault/src/index.ts:10-36`
  - `services/vault/src/fs/writer.ts:105-119`
  - `services/vault/src/fs/writer.ts:175-218`
  - `services/vault/src/config.ts:14-23`
  - `services/vault/src/server/routes.ts:263-282`
  - `services/vault/tests/fs/writer.test.ts`

**Problem.** Coverage: health.ts, middleware.ts, server/index.ts 0%; src/index.ts never loaded; writer.ts 65% lines with onWriteFailure and writeErrorSidecar uncovered and storeFile only ever mocked; config.ts 60% (validation branch uncovered); /stats uncovered. VLT-01, 03-07, 11, 12 and 21 all sit in this code.

**Evidence.** Both lenses' coverage runs (reviews/2026-11/units/scratch/cov-vault/, cov-vault-verify/): `health.ts 0 | 0 | 0 | 0 | 31-156`, `middleware.ts 0 ... 10-35`, `writer.ts 66.66 | 52 | 60 | 65 | ...176-184,200-214`, `config.ts 63.63 ... 17-22`; grep -c storeFile tests/fs/writer.test.ts -> 0.

**Fix.** Add each test alongside the fix it guards (listed in the respective items) plus these standalone ones: tests/server/middleware.test.ts mounting errorMiddleware on a small express app (request.aborted -> 499; malformed JSON -> 400 'Invalid JSON body'; thrown Error -> 500, nothing written after headersSent; 413/415 per VLT-21); writer.test onWriteFailure block by mocking @devvir/zipper createWriter to capture opts.onWriteFailure (no truncateError -> recordFailure; truncateError -> .csv.gz.error with quarantinePath and an error log); tests/config.test.ts (export parseCompressionLevel or vi.resetModules + dynamic import, since loadConfig runs at import: unset -> 6; '9' -> 9; '0','10','1.5','abc' throw); routes /stats cases (VLT-21). Extract the shutdown handler so it is testable without SK.run (VLT-01). Keep coverage output out of the repo.

**Tests to add.** As listed in fix.

**Verifier notes.** Lens A F20 (low) + lens B F20 (medium). Both verifiers recommend pairing each test with its fix rather than a separate large task.

## VLT-18: NDJSON read path emits one HTTP chunk per line

- **Severity:** medium
- **Category:** efficiency
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/server/routes.ts:132`
  - `services/vault/src/server/routes.ts:152`
  - `services/vault/src/data/decode.ts:31-33`
  - `services/vault/src/data/decode.ts:59-75`

**Problem.** Readable.from(decodeFile(...)) is object-mode and each yielded line becomes its own res.write and chunked-transfer frame. Day files hold millions of rows.

**Evidence.** reviews/2026-11/units/scratch/bench-stream.js, 1M ~120-byte lines over local HTTP: per-line 2011-2398 ms with ~1,001,744 client chunks vs 447-645 ms with ~3,750 chunks batched at 64 KiB. Verifier: decode itself costs ~2 s per 1M rows, so the end-to-end saving is ~30-40%, not 3.5-4x.

**Fix.** Add a `batchLines(gen, 64 * 1024)` async-generator wrapper (or coalesce at the end of decodeFile): accumulate lines with a running length, yield parts.join('') at >= 64 KiB, flush the remainder on completion. Keep res.on('close', () => stream.destroy()). skip>0 behaviour unchanged.

**Tests to add.** Batched output for N rows is byte-identical to unbatched and every chunk ends with '\n'; route test: GET body equals the joined NDJSON for a file > 64 KiB.

**Verifier notes.** Lens B only; reviewer and verifier medium, with the magnitude corrected.

## VLT-19: Crash recovery: resuming a .csv.gz.tmp does not repair a torn final member, and files recreated after quarantine (or 0-byte tmps) get no header

- **Severity:** medium
- **Category:** correctness
- **Decision:** DEFER
- **Locations:**
  - `services/vault/src/fs/writer.ts:53-57`
  - `services/vault/src/fs/writer.ts:141-166`
  - `services/vault/src/fs/writer.ts:168-218`
  - `services/vault/src/data/ticker.ts:38-40`
  - `services/vault/src/data/decode.ts:27`

**Problem.** getOrCreateWriter hands an existing .csv.gz.tmp to zipper, which resumes by appendFile with lastGoodOffset = current size. If the previous process died mid-append (SIGKILL, OOM, power loss, or VLT-01's exit), the tail is a partial member; every member appended after restart sits behind it and a streaming gunzip fails there (free-text tables then crash, VLT-03). Header presence is inferred from existsSync: a 0-byte tmp, or the fresh target zipper starts after quarantine (truncate failure -> rename to .failed.N, failed data member re-appended to a new tmp) never gets a header, so the rest of the day decodes under data values as column names. The sidecar says 'A fresh open file continues from here'. A header enqueued from onWriteFailure would land second, because report() runs after the re-append.

**Evidence.** Lens A (reviews/2026-11/units/scratch/vault/tick.test.ts 'torn member on resume'): header+row, half a 500-row member appended, writer module re-imported, Sell row appended and sealed -> `decode failed after 264 lines: Z_BUF_ERROR`. Lens B verifier traced zipper writer.js runSafe (quarantine then appendFile of the failed member) and decode.ts:27 using the first record as header.

**Fix.** Owner decides where resume repair and 'header on (re)create' live. If vault: before createWriter for an existing tmp, stream it through zlib.createGunzip tracking the end offset of each complete member, truncateSync to the last complete offset and log bytes cut; size 0 after repair -> uninitialised. Move the header decision into the write chain (appendBatch takes headerLine and prepends it when currentSize()==0 at write time). If zipper: add a preamble/onCreate option written whenever target is created, including after quarantine. Alternative in vault's synchronous callback: rewrite the fresh target as gzipSync(header+'\n') + its bytes. The bounded logging part (log + recordFailure in the truncateError branch, reappendError in the sidecar, fix the writer.ts:189-190 comment) is implemented now under VLT-23.

**Tests to add.** Write header+row, append half a gzip member, re-import the writer module, append a row and seal: the sealed file decodes fully incl. the post-restart row. Mock appendFile to fail 4x and truncate to reject: .failed.1 exists, sidecar exists, error logged, fresh tmp's first decoded line is the header.

**Verifier notes.** Merges lens A F6 (verifier: medium, defer) and lens B F7 (verifier: low, defer; reviewer's fix of enqueuing a header from onWriteFailure is wrong). Kept medium because a torn tail after an abnormal kill makes the rest of the day unreadable.

**Owner question.** Should resume repair (truncate to last complete gzip member) and 'write the CSV header whenever the target file is (re)created, including after quarantine' be added to @devvir/zipper (preamble/onCreate option), or implemented in vault (startup scan of open .tmp files plus moving the header decision into the write chain)? Is a startup scan of large open files acceptable?

## VLT-20: Decide vault's role: live writer or read-only server of the BitMEX CSV.gz archive

- **Severity:** medium
- **Category:** design
- **Decision:** DEFER
- **Locations:**
  - `services/vault/src/data/buffers.ts`
  - `services/vault/src/data/ticker.ts`
  - `services/vault/src/data/close.ts`
  - `services/vault/src/data/encode.ts`
  - `services/vault/src/fs/health.ts`
  - `services/vault/src/fs/writer.ts`
  - `docs/DATA_PIPELINE.md:68-93`

**Problem.** BitMEX is closed and the producers named in vault's code (journalist, courier, scribe) exist only under services/.deprecated; nothing in the repo calls POST /rows, /close, PUT or DELETE. The whole buffers -> ticker -> seal machinery has no current producer, yet holds most of the defects in this report (VLT-01, 04, 06, 09, 10, 11, 12, 19 and part of 05, 13). Its present value is the read path, which planned stocker normalisation will use.

**Evidence.** Lens B notes: grep outside .deprecated finds no vault write client; DATA_PIPELINE.md:68-71 states BitMEX is closed.

**Fix.** If read-only: delete buffers.ts, ticker.ts, close.ts, encode.ts, health.ts and most of writer.ts plus their routes and tests, and drop the write-path items instead of fixing them. Keep or harden PUT only if an importer still needs it. Read-path, validation, config and docs items (VLT-02, 03, 07, 08 reader half, 14, 15, 16, 18, 21, 22) apply either way and should be implemented first. If it stays a live writer, implement the write-path items as specified, landing them in the bucket module (VLT-25).

**Tests to add.** Depends on the decision.

**Verifier notes.** Restructuring recommendation from lens B notes and lens A notes; not a reviewer finding with verdicts. Verifiers still marked the write-path fixes as implement, so the implementation agent may proceed with them unless the owner decides otherwise.

**Owner question.** Will vault ingest live rows again (any producer planned for POST /rows, /close, PUT, DELETE), or should it become a read-only server of the existing BitMEX archive, with the write machinery deleted rather than fixed?

## VLT-21: Error middleware turns body-parser 4xx (413, 415) into 500; /stats ignores ?suffix and 500s on a seal-rename race

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/server/middleware.ts:16-35`
  - `services/vault/src/server/routes.ts:263-282`

**Problem.** The middleware only special-cases request.aborted and 400 SyntaxError, so a body over the 50 MB limit (413) or an unsupported charset (415) is logged as 'Unhandled request error' and answered 500, inviting endless retries. /stats reads req.params['date'] instead of filenameOf(req), so ?suffix= is ignored unlike every other :date route, and statSync after fileState throws ENOENT (500) if a seal rename lands in between. Nothing in the repo calls /stats today.

**Evidence.** Lens A verifier with built middleware and body-parser 2.3.0 (reviews/2026-11/units/scratch/f17.cjs): PayloadTooLargeError (413, expose) and charset=latin9 (415) both answered 500. routes.ts:265 `const filename = req.params['date'] as string;`, :274 `statSync(path)`.

**Fix.** middleware.ts after the existing branches: `if (typeof e.status === 'number' && e.status >= 400 && e.status < 500 && (err as {expose?: boolean}).expose) { if (!res.headersSent) res.status(e.status).json({ error: (err as Error).message }); return; }`. /stats: use the VLT-02 parseKey/filenameOf, make the handler async with `await fs.promises.stat`, on ENOENT re-check fileState once and return 404 if still missing; other errors -> 500.

**Tests to add.** middleware.test: 413 and 415 pass through. routes.test /stats: honours ?suffix= (fileState called with '20240101.snapshot'); closed -> state with size/mtime/birthtime; none -> 404; stat ENOENT race -> 404.

**Verifier notes.** Lens A F17 + /stats parts of lens B F16. Both low.

## VLT-22: S3 'D' timestamps are converted to ISO strings without a zone designator

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/data/casts.ts:181-182`
  - `services/vault/tests/data/casts.test.ts:41`

**Problem.** timestamp_D does value.replace('D','T'). BitMEX S3 trade/quote CSVs carry no Z (`2019-01-01D00:00:03.181913000`), so PUT-sourced days emit zone-less timestamps that Date.parse treats as local time, while live rows carry Z. The only test uses input that already ends in Z.

**Evidence.** Verifier: TZ=America/New_York Date.parse of the zone-less form is 5 h off the Z form (1546318803181 vs 1546300803181).

**Fix.** `const t = value.replace('D', 'T'); result[key] = /([Zz]|[+-]\d{2}:?\d{2})$/.test(t) ? t : `${t}Z`;` keeping all nine fractional digits (also in compileCasts if VLT-28 lands).

**Tests to add.** casts.test: `2019-01-01D00:00:03.181913000` -> `2019-01-01T00:00:03.181913000Z`; existing Z-terminated case unchanged.

**Verifier notes.** Lens A only; low (compose defaults TZ to UTC, no in-repo consumer parses these with Date.parse today).

## VLT-23: Source docblocks name consumer services, narrate history, or describe behaviour that is not there; truncate-failure branch is silent

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/server/middleware.ts:19-21`
  - `services/vault/src/server/index.ts:27-29`
  - `services/vault/src/server/routes.ts:7-12`
  - `services/vault/src/server/routes.ts:30-33`
  - `services/vault/src/server/routes.ts:155`
  - `services/vault/src/fs/writer.ts:5-6`
  - `services/vault/src/fs/writer.ts:99-104`
  - `services/vault/src/fs/writer.ts:168-174`
  - `services/vault/src/fs/writer.ts:175-191`
  - `services/vault/src/fs/health.ts:15-18`
  - `services/vault/src/data/headers.ts:7-10`
  - `services/vault/src/data/headers.ts:29`
  - `services/vault/src/data/ticker.ts:3-7`
  - `services/vault/src/data/casts.ts:8`
  - `services/vault/src/fs/reader.ts:95`

**Problem.** CLAUDE.md forbids explaining a provider by its consumers and history. Consumer names: middleware.ts:19 (journalist), server/index.ts:27, routes.ts:155, writer.ts:5 and 101-103 (courier), headers.ts:9 (journalist CHAT_SCHEMA), health.ts:15-18 (lists callers). History: routes.ts:10-12 ('existed before suffixes were introduced'), writer.ts:170 ('Mirrors the original split'), headers.ts:7-10/29 provenance. False: routes.ts:30-33 'Never cleaned up'; writer.ts:101-103 (PUT itself discards the open file; storeFile unlinks on failure); ticker.ts:5-7 contradicts itself; writer.ts:189-190 '(the stderr log from the writer is always emitted)' while the truncateError branch logs nothing and zipper does not log, so a truncate failure with a failed sidecar write is completely silent; casts.ts:8 documents the unused 'required' cast; reader.ts:95 'tables that have at least one file' but returns every directory.

**Evidence.** grep -rn -i 'journalist\|courier' services/vault/src gives six hits; no such services exist outside .deprecated. writer.ts:176-180 returns after writeErrorSidecar without logging.

**Fix.** Rewrite in neutral current-state terms. middleware: 'A client that drops the connection mid-request surfaces as type request.aborted -> 499.' server/index: 'Uploads may be arbitrarily large, so the per-request deadline is disabled' (update after VLT-01 changes the timeout). routes.ts:155 drop '(courier)'; writer.ts:5 'full pre-built gzip stream (PUT route)'; storeFile docblock describes the temp file actually used after VLT-05 and that it is removed on error. Drop history sentences (routes.ts:10-12, writer.ts:170, headers.ts provenance list and :29). routes.ts:30-33 as in VLT-11. ticker.ts:3-7 'flushes ready buffers on a 200 ms interval; closeBucket and the shutdown drain also append directly'. health.ts: describe the API without naming callers. casts.ts:8 removed with 'required' (VLT-26). reader.ts:95 'Lists table directories under the data dir' (or filter and keep wording). In onWriteFailure's truncateError branch add `logger.error({ table, filename, err: info.error, truncateError: info.truncateError, reappendError: info.reappendError, quarantinePath: info.quarantinePath, lastGoodOffset }, 'Append failed and truncate failed; file quarantined')`, call recordFailure, include reappendError in the sidecar, log in the sidecar catch, and fix the comment.

**Tests to add.** writer.test: truncate-failure branch logs at error level and calls recordFailure (with the VLT-17 onWriteFailure harness).

**Verifier notes.** Merges lens A F19 (source-comment part) and lens B F19 (low), plus the bounded logging part of lens B F7.

## VLT-24: Tests that assert misleading behaviour, a fragile gzip-member helper with a false comment, non-production date forms, and over-mocked route tests

- **Severity:** low
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/tests/data/decode.test.ts:121-135`
  - `services/vault/tests/data/ticker.test.ts:65-70`
  - `services/vault/tests/fs/writer.test.ts:37-61`
  - `services/vault/tests/fs/writer.test.ts:89`
  - `services/vault/tests/server/routes.test.ts:7-44`

**Problem.** (1) decode.test 'handles a quoted field containing a comma' feeds a pre-parsed orderBookL2 record (with a 'note' column orderBookL2 lacks), certifying a path that is comma-split in reality. (2) ticker.test expects tick() to throw on a table with no header; unreachable in production (encode fails first) but it enshrines a throw that would crash setInterval. (3) writer.test readMembers scans for 1f 8b; its comment 'gunzipSync handles the first member only' is false and the scan fails when compressed bytes contain that pair (25-329 of 2000 random 5-member files). (4) 43 filenames use '2023-02-01', which listFiles rejects and VLT-02 will reject. (5) routes.test mocks every collaborator, so the routes-to-data/fs contract (PUT over open with a live writer, close then rows) is untested.

**Evidence.** Node: gunzipSync(concat of 3 members) returns 'a\nb\nc\n'. Random-member repro counts from both reviewer and verifier. ticker.test.ts has 71 lines (reviewer's 121-126 miscited); parse.test.ts:226 citation does not exist.

**Fix.** Replace readMembers with gunzipSync(readFileSync(p)).toString('utf8'); where multi-member matters, compare sizes against per-batch gzips or count members via gunzipSync info. Rename the decode test to 'passes field values through unchanged' using chat's real columns; add a parse-level test for comma-split behaviour (after VLT-08, the quote-aware path). Change the ticker test to 'logs and continues flushing other tables' once VLT-06 lands. Use 8-digit dates everywhere. Add tests/server/integration.test.ts mounting real registerRoutes over a temp DATA_DIR (mock only fs/paths) driving _test_tick: POST rows -> tick -> close -> GET; PUT over open with a live writer; DELETE with queued writes; close -> rows -> 409.

**Tests to add.** As listed in fix.

**Verifier notes.** Lens B F21; reviewer medium, verifier low with location corrections; item (2) is unreachable in production.

## VLT-25: Bucket lifecycle spread across routes, ticker, close and index, with triplicated header-prepend code

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/data/ticker.ts:38-40`
  - `services/vault/src/data/ticker.ts:48-54`
  - `services/vault/src/data/close.ts:22-36`
  - `services/vault/src/index.ts:22-30`
  - `services/vault/src/server/routes.ts:1-5`
  - `services/vault/src/server/routes.ts:30-34`
  - `services/vault/src/server/routes.ts:173-177`
  - `services/vault/src/server/routes.ts:194-196`

**Problem.** 'Prepend header if not initialised, then appendBatch' exists three times (identical headerLine in ticker.ts and close.ts; index.ts:25 with a non-null assertion). routes.ts claims 'No business logic' yet owns the closing barrier and repeats the flush/remove/deleteFile discard sequence in PUT and DELETE. The race fixes (VLT-04, 05, 11) otherwise have to be made in several places.

**Evidence.** ticker.ts:48-54 and close.ts:31-36 identical; index.ts:25 `[headersFor(table)!.join(','), ...lines]`; routes.ts:173-176 and 194-196 the same three calls.

**Fix.** Create data/bucket.ts: writeLines(table, filename, lines, seal = false) (header prepend with a clear error when no headers, then appendBatch; used by tick, closeBucket and the shutdown drain), discardBucket (VLT-04), and the per-key closing/uploading/discarding state behind markClosing/isClosing/acceptsRows(key). routes.ts then only parses params (VLT-02) and maps results to status codes. Delete both headerLine copies and the `!`. Do this as the vehicle for VLT-04/05/11, not as a separate refactor.

**Tests to add.** bucket.test.ts: header prepended on an uninitialised file, not on an initialised one; existing ticker/close/routes tests pass.

**Verifier notes.** Lens B F14; reviewer medium, verifier low (maintainability; the `!` cannot fire today).

## VLT-26: Duplicate baseTable implementation and dead 'required' cast type

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/data/headers.ts:84`
  - `shared/utils/src/tables.ts:280`
  - `services/vault/src/data/casts.ts:8`
  - `services/vault/src/data/casts.ts:14-16`
  - `services/vault/src/data/casts.ts:171-172`
  - `services/vault/src/data/decode.ts:3`
  - `services/vault/src/data/parse.ts:23`
  - `docs/services/VAULT.md:30`

**Problem.** vault re-implements baseTable (regex replace) although @tradebot/utils exports an equivalent one that vault already depends on. The 'required' CastType and its branch are used by no table.

**Evidence.** grep "'required'" casts.ts hits only the type, doc comment and branch; both baseTable versions behave the same on all inputs including '' and '.x'.

**Fix.** Delete vault's baseTable and import it from @tradebot/utils (casts.ts, decode.ts, parse.ts, headers.ts users); update the VAULT.md reference. Remove 'required' from CastType, the doc comment and the branch (if VLT-28 lands first, drop its required handling too). Keep the casts for tables without TABLE_HEADERS entries: PUT can store them and GET casts them; add a one-line comment saying so.

**Tests to add.** casts.test: applyCasts(row,'quote.secondary') equals applyCasts(row,'quote'); empty strings are dropped for every table.

**Verifier notes.** Lens B F15 (low). Verifier rejected 'drop casts for unheadered tables' (reachable via PUT) and deferred deriving casts from TABLE_SPECS (no tick/compositeIndex/flair entries; needs a type mapping and golden tests).

## VLT-27: Unused test export and a type named Buffer that shadows Node's global

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/data/ticker.ts:59`
  - `services/vault/src/fs/health.ts:148`
  - `services/vault/src/data/types.ts:9`
  - `services/vault/src/data/buffers.ts:7-40`

**Problem.** knip reports `_test_TICK_MS` unused (and health `_test_reset`, unused only because health has no tests). `interface Buffer` in data/types.ts shadows the global Buffer type in buffers.ts, confusing in a codebase full of gzip Buffers.

**Evidence.** `npx knip --workspace services/vault`: '_test_TICK_MS services/vault/src/data/ticker.ts:59:14', '_test_reset services/vault/src/fs/health.ts:148:14'.

**Fix.** Delete _test_TICK_MS; keep health._test_reset and use it in the VLT-12 tests. Rename the interface to LineBuffer and update buffers.ts.

**Tests to add.** Typecheck and existing tests.

**Verifier notes.** Lens B F16 (code-quality parts; main/Dockerfile went to VLT-15, /stats to VLT-21). Low.

## VLT-28: Per-row cast work: two objects, Object.entries and a regex baseTable lookup for every row

- **Severity:** low
- **Category:** efficiency
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/vault/src/data/decode.ts:81-93`
  - `services/vault/src/data/casts.ts:161-189`

**Problem.** applyFields builds a raw object per row, then applyCasts re-resolves TABLE_CASTS[baseTable(table)] (regex) per row, allocates Object.entries and builds a second object. Casts depend only on table and column index.

**Evidence.** reviews/2026-11/units/scratch/bench-casts.js, 1M trade rows incl. JSON.stringify: 2001-2079 ms now vs 987-1090 ms with precomputed per-column casters.

**Fix.** casts.ts: `compileCasts(table, cols): (fields: string[]) => Record<string, unknown>` resolving casts once, mapping each column to a caster (number, boolean, json with try/catch, timestamp_D per VLT-22, identity), one loop writing one object; empty strings are skipped (the WS path relies on that via Object.keys(row).length > 0). decode.ts calls it once after the header (cols for REST, dataCols with offset for WS) and drops applyFields. Keep applyCasts as a thin wrapper so casts.test keeps running.

**Tests to add.** Existing casts.test cases run through compileCasts; empty-field dropping preserved; WS decode unchanged.

**Verifier notes.** Lens B F11; low, CPU only.

## VLT-29: Unauthenticated API published on all host interfaces, repo mounted read-write at /live, requestTimeout = 0

- **Severity:** low
- **Category:** security
- **Decision:** DEFER
- **Locations:**
  - `services/vault/docker/compose.yml:11-14`
  - `services/vault/docker/base.yml:26-27`
  - `services/vault/src/server/index.ts:27-30`

**Problem.** compose.yml publishes `${VAULT_PORT:-}:8000` and `:3000` with no host IP (0.0.0.0, random port when unset). No auth. base.yml mounts the monorepo read-write at /live, which VLT-02 turns into writes in the source tree. requestTimeout = 0 lets a slow body be held open forever.

**Evidence.** compose.yml `ports: - ${VAULT_PORT:-}:8000 - :3000`; base.yml `- ../../../:/live`; server/index.ts:30 `server.requestTimeout = 0;`.

**Fix.** Recommended: drop the 8000 publish and use the compose network (as prospector does: 'Only health is published'), or `"127.0.0.1:${VAULT_PORT:?VAULT_PORT is not defined}:8000"`. Handle /live repo-wide (dev-only override, or read-only where prod does not use it). The idle-timeout part is covered by VLT-01. Add a shared-secret header only if access beyond the compose network is needed.

**Tests to add.** None (config).

**Verifier notes.** Lens A F12; reviewer medium, verifier low and defer: the /live mount and :3000 publish are a repo-wide convention (dev.node.Dockerfile uses WORKDIR /live), and exposure is a deployment decision. The traversal amplification is fixed by VLT-02.

**Owner question.** Must vault's port 8000 be reachable from outside the compose network? If not, may the publish be dropped (or bound to 127.0.0.1)? Should the read-write /live mount be moved to a dev-only override repo-wide?

## VLT-30: Synchronous filesystem calls on request paths

- **Severity:** low
- **Category:** efficiency
- **Decision:** DEFER
- **Locations:**
  - `services/vault/src/fs/reader.ts:39-44`
  - `services/vault/src/server/routes.ts:63`
  - `services/vault/src/fs/writer.ts:109-128`
  - `services/vault/src/fs/reader.ts:54-93`
  - `services/vault/src/server/routes.ts:274`
  - `services/vault/src/fs/health.ts:134-136`

**Problem.** Every POST /rows runs two existsSync via fileState; PUT, DELETE, listing and /stats use sync mkdir/rename/unlink/readdir/stat. On a hung disk each call blocks the event loop.

**Evidence.** reader.ts:40-41 existsSync pair called from routes.ts:63 on every POST /rows.

**Fix.** If taken up: convert non-hot paths to fs.promises (/stats is done in VLT-21; listFiles/listTables readdir/stat; storeFile/deleteFile as part of VLT-04/05). For POST /rows, skip the disk check when writers.has(key) (a live writer means open). Only add a closed-key cache together with VLT-25's bucket state.

**Tests to add.** Routes integration: POST /rows on a bucket with a live writer performs no fs stat (spy).

**Verifier notes.** Lens B F12; reviewer medium, verifier low and defer: microsecond stats on a healthy disk; on a hung disk async calls only move the stall to the threadpool; the in-memory cache is a design change coupled to the race fixes.

**Owner question.** Is event-loop blocking on degraded storage a concern worth a state cache, or is the cheap writers.has(key) short-circuit plus converting non-hot paths enough?

## Deferred — decisions needed

- **VLT-19** (Crash recovery: resuming a .csv.gz.tmp does not repair a torn final member, and files recreated after quarantine (or 0-byte tmps) get no header): Should resume repair (truncate to last complete gzip member) and 'write the CSV header whenever the target file is (re)created, including after quarantine' be added to @devvir/zipper (preamble/onCreate option), or implemented in vault (startup scan of open .tmp files plus moving the header decision into the write chain)? Is a startup scan of large open files acceptable?
- **VLT-20** (Decide vault's role: live writer or read-only server of the BitMEX CSV.gz archive): Will vault ingest live rows again (any producer planned for POST /rows, /close, PUT, DELETE), or should it become a read-only server of the existing BitMEX archive, with the write machinery deleted rather than fixed?
- **VLT-29** (Unauthenticated API published on all host interfaces, repo mounted read-write at /live, requestTimeout = 0): Must vault's port 8000 be reachable from outside the compose network? If not, may the publish be dropped (or bound to 127.0.0.1)? Should the read-write /live mount be moved to a dev-only override repo-wide?
- **VLT-30** (Synchronous filesystem calls on request paths): Is event-loop blocking on degraded storage a concern worth a state cache, or is the cheap writers.has(key) short-circuit plus converting non-hot paths enough?

## Rejected

- **Derive vault casts from TABLE_SPECS (lens B F8/F15 alternative)**: TABLE_SPECS has no compositeIndex or tick entry, lacks chat flair/guild, cannot express timestamp_D, and would change GET output where the two have drifted; the explicit compositeIndex cast (VLT-14) is the bounded fix.
- **Drop casts for tables without TABLE_HEADERS entries (lens B F15)**: Reachable: PUT accepts any table name and GET casts the stored file using those entries; removing them changes read output.
- **Enqueue a header via writer.write from onWriteFailure after quarantine (lens B F7 suggested fix)**: report() runs after the failed member is already re-appended to the fresh file, so the header would land second; the real fix is deferred under VLT-19.
- **PUT Content-Length comparison and 'require non-JSON content type' (lens A F9 suggestions)**: An aborted request already makes pipeline() reject on Node 22, and the gunzip integrity check in VLT-05 covers truncation; the content-type rule adds little.
- **Make the health recovery probe async (lens B F9 suggestion)**: It runs once per 5 s and only while unhealthy; blocking cost is negligible. The payload fix (VLT-12) is what matters.
- **tick() throwing on a table with no header is a production crash (lens B F21 item 2)**: Unreachable in production: encode() fails on the same headersFor lookup before anything is buffered, and flushReady skips empty buffers. Per-batch hardening is still covered by VLT-06.
