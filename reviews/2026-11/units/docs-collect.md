# Review consolidation: docs-collect

Scope: hauler, hoarder, vault, router, pipe, the archives module, and the warehouse README. One lens (docs-collect:docs) with 26 findings; all survived verification (F25 partly).

## Overall assessment

Eleven docs about collection were checked against the code of hauler, hoarder, vault, router and pipe, the shared rule grammar (shared/utils/src/routes.ts), and the catalog/prospector code they lean on. The hauler docs are the most accurate: the timing, retry, host-rotation and verification detail in HAULER.md matches the code. Their problem is structure. HAULER.md goes as deep on the canonical key layout as CATALOG-API.md, which owns it, and mixes in history, venue facts and stale measurements. The hauler README and compose comments make a few claims the code no longer supports. The other docs are in worse shape. VAULT.md describes a write-safety, serialisation and restart mechanism the code no longer has, since writing moved to @devvir/zipper. It also documents the port, the env vars, listings, throttling, PUT and skip wrongly. ROUTER.md's grammar, health and config sections contradict the code, and its headline 'explicit exchange' examples silently lose messages. The pipe README's 'type omitted' example is rejected at startup. The hoarder README promises a byte-faithful relay that the code does not deliver, and its Binance futures note contradicts BINANCE.md. The two archives docs contradict each other on whether surveys resume after a restart. Two planning items about hauler have landed.

Real code defects underlie several doc defects. Two are confirmed: hoarder re-serialises every frame (DCOL-01), and vault's GET ?skip on a missing file answers 200 and never ends (DCOL-04, reproduced). One more is traced but needs an owner design decision: after zipper quarantines a file, the new file has no header row (DCOL-03). A router topology quirk drops messages for a documented pattern (DCOL-02). It affects no deployed config.

Restructuring recommendation (reviewer's, endorsed by the verifiers in substance):
1. Collect (hauler and the archives module). Keep HAULER.md, but cut 'The layout on disk' to a pointer, so that CATALOG-API.md is the one home of the key grammar (DCOL-09). Remove the history, add that venues and hosts are discovered only at startup, and correct the README and compose comments. Make modules/collect/archives/README.md the run book and docs/modules/ARCHIVES.md the design page (DCOL-10, DCOL-11).
2. Vault service. Its status is an owner decision (DCOL-17). It has no producer left, is wired into no module, and its name and /data/vault path collide with the Parquet vault. The doc corrections (DCOL-03/04/05/06/24) are cheap and make the docs true today, but they are wasted if the owner deprecates vault. An implementer may want to wait for DCOL-17.
3. RabbitMQ services (router, pipe, hoarder). Give the shared rule grammar one home in shared/utils (DCOL-08), and correct the router and pipe docs against it. Whether ROUTER.md is folded into the router README (README-only convention for these three small, undeployed services) is an owner decision (DCOL-26). None of them needs a docs/services article today.
4. Planning. Cut the hauler items that have landed or are obsolete (DCOL-25).

These code observations were reported by the reviewer but NOT verified and are NOT items. Pass them to the code owners:
- vault: the table/date path params are not validated, and Express decodes %2F, so `PUT /files/x/..%2F..%2F..%2Ftmp%2Fevil` would write /tmp/evil.csv.gz.tmp. This is a path-traversal write. It was traced, not run. The service is internal and unauthenticated.
- vault: in the PUT open-file branch, a queued zipper append can race storeFile on the same .tmp path. drainHandle should run before deleteFile (raised by a verifier under DCOL-06).
- hoarder: pool.ts:66 registers shutdown as ws.close() on the first socket only, so sockets created by a reconnect are not closed on shutdown.
- router: buildConsumerTopology (topology.ts:47-48) defaults a source binding key to '#' on direct exchanges too, where '#' is not a wildcard (raised by the second verifier under DCOL-02).

## Summary

| id | severity | category | decision | title | source |
|---|---|---|---|---|---|
| DCOL-01 | high | code+docs | IMPLEMENT | Hoarder publishes re-serialised JSON, but its docs (and its design) promise a byte-faithful relay | F1 |
| DCOL-02 | high | docs | IMPLEMENT | ROUTER.md examples that put a queue on an explicit exchange deliver nothing to that queue | F2 |
| DCOL-03 | medium | docs+code | IMPLEMENT | VAULT.md write-safety, serialisation and restart sections describe an implementation that no longer exists; quarantine leaves a headerless file | F10 |
| DCOL-04 | medium | code | IMPLEMENT | Vault GET /files/:table/:date?skip=N on a missing file answers 200 and never ends (docs promise 404) | F12 |
| DCOL-05 | medium | docs | IMPLEMENT | Vault docs give the wrong port, say there are no env vars, and say open files can be read | F13+F25(part) |
| DCOL-06 | medium | docs | IMPLEMENT | VAULT.md HTTP API is wrong about listings, PUT and errors, and omits 429 and /stats | F11 |
| DCOL-07 | medium | docs | IMPLEMENT | Pipe README syntax and its 'type omitted' example are rejected at startup | F7 |
| DCOL-08 | medium | docs-structure | IMPLEMENT | The shared rule grammar is documented twice, in two consumer docs that disagree with each other and the code | F8 |
| DCOL-09 | medium | docs-structure | IMPLEMENT | HAULER.md goes as deep on the canonical key layout as CATALOG-API.md, and adds history, venue facts and stale measurements | F15 |
| DCOL-10 | medium | docs-structure | IMPLEMENT | Two docs cover the archives module at the same depth, with a wrong pointer, a wrong link and a missing variable | F23 |
| DCOL-11 | medium | docs | IMPLEMENT | Archives module README says surveys resume only when asked; prospector resumes enrolled venues on every start | F22 |
| DCOL-12 | medium | docs | IMPLEMENT | Hauler README says a refusal pauses the whole venue, and misstates who rules on a failure and when a 404 fails a file | F16 |
| DCOL-13 | medium | docs | IMPLEMENT | Hauler compose comments say the concurrency budget is per venue and that a stop leaves a .part | F17 |
| DCOL-14 | medium | docs | IMPLEMENT | Hoarder's Binance futures note contradicts BINANCE.md and is written as a plan | F20 |
| DCOL-15 | medium | docs | IMPLEMENT | ROUTER.md health section describes responses the router never gives | F4 |
| DCOL-16 | medium | docs | IMPLEMENT | Router config docs leave out QUEUE_URL and the whole backpressure feature | F5 |
| DCOL-17 | medium | docs-structure | DEFER | 'Vault' names two different stores at one container path, and the vault service has no remaining producer | F14 |
| DCOL-18 | low | docs | IMPLEMENT | ROUTER.md says a colon without @ is an error, but the shared grammar accepts it; rejection list incomplete | F3 |
| DCOL-19 | low | docs | IMPLEMENT | ROUTER.md misstates header merging, fan-out failure handling and routing-key modifiers | F6 |
| DCOL-20 | low | docs | IMPLEMENT | Router and pipe examples name retired services; pipe README uses plan phrasing | F9 |
| DCOL-21 | low | docs | IMPLEMENT | Hoarder README does not say collection is parked or name the exchange it publishes to | F21 |
| DCOL-22 | low | docs | IMPLEMENT | Hauler docs don't say venues and hosts are read once at startup, or that some state is in memory | F19 |
| DCOL-23 | low | docs | IMPLEMENT | HAULER.md and a hauler docblock carry history | F18 |
| DCOL-24 | low | docs | IMPLEMENT | Smaller VAULT.md issues: future framing, history in a docblock, and the 429 throttle constants missing | F25 |
| DCOL-25 | low | docs-planning | IMPLEMENT | Planning items on hauler have landed or are out of date | F24 |
| DCOL-26 | low | docs-structure | DEFER | RabbitMQ service docs are structured three different ways; choose one convention (hoarder and pipe need no docs/services article) | F26 |

## DCOL-01: Hoarder publishes re-serialised JSON, but its docs (and its design) promise a byte-faithful relay

- **Severity:** high
- **Category:** code+docs
- **Decision:** IMPLEMENT
- **Source finding:** F1
- **Locations:**
  - `services/hoarder/src/messages.ts:26`
  - `services/hoarder/src/messages.ts:37`
  - `services/hoarder/src/messages.ts:5-9`
  - `services/hoarder/README.md:3`
  - `services/hoarder/README.md:12`
  - `services/hoarder/tests/messages.test.ts:86`
  - `services/hoarder/src/websocket.ts:66`
  - `docs/DATA_PIPELINE.md:22`
  - `docs/DATA_PIPELINE.md:61`

**Problem.** The README, the messages.ts docblock and DATA_PIPELINE.md say every frame is published verbatim ('byte-faithful'). The code parses each frame and publishes Buffer.from(JSON.stringify(frame)). That drops whitespace, strips trailing zeros, rewrites escapes, and silently corrupts integers above 2^53. The test only checks that the parsed JSON is equal.

**Evidence.** messages.ts:26 `JSON.parse(buffer.toString())`; messages.ts:37 `publish(Buffer.from(JSON.stringify(frame)), venue, ...)`. Reproduced twice: `{"price": 64304.90, "qty":0.00100000, "id":12345678901234567891, "s":"é\/x"}` comes back as `{"price":64304.9,"qty":0.001,"id":12345678901234567000,"s":"é/x"}`. Kraken v2 sends prices and quantities as JSON numbers.

**Fix.** Code, not docs. In messages.ts publish the received `buffer` unchanged (`broker.getExchange()!.publish(buffer, venue, {...})`), and use the parsed `frame` only for `v.isData(frame)` and `describeControl`. If ws could ever deliver a non-Buffer, normalise it with `Buffer.isBuffer(b) ? b : Buffer.from(b)`, never by re-serialising. Once fixed, README:3/12, the messages.ts docblock and DATA_PIPELINE.md:22/61 are true as written. (If the code were left alone, all five statements would have to say 're-serialised JSON, structurally equal, large integers not preserved'.)

**Tests to add.** Rename messages.test.ts:86 to 'publishes the received bytes unchanged'. Feed it a non-canonical raw frame (whitespace, `64304.90`, an integer above 2^53, an escaped slash) shaped so that the test venue's isData accepts it, and assert `content.equals(rawBuffer)`.

**Verifier notes.** Both verifiers confirmed this at high severity and reproduced it. The second found the same claim in DATA_PIPELINE.md:22 and :61. It stops short of critical because typical values stay equal as doubles.

## DCOL-02: ROUTER.md examples that put a queue on an explicit exchange deliver nothing to that queue

- **Severity:** high
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F2
- **Locations:**
  - `docs/services/ROUTER.md:91`
  - `docs/services/ROUTER.md:97`
  - `docs/services/ROUTER.md:141-149`
  - `services/router/src/topology.ts:80-81`
  - `packages/rabbitmq/src/topology.ts:52-56`
  - `services/router/src/consumer.ts:33-41`
  - `packages/rabbitmq/src/exchange.ts:239-246`
  - `services/router/src/topology.ts:47-48`

**Problem.** buildPublisherTopology declares a destination queue on an exchange with no routingKey, and the rabbitmq helper then binds it with the queue's own name. On topic and direct exchanges, a message republished with its preserved or transformed key (e.g. `collect.trade`, or `okx`) matches nothing. The message is dropped without a mandatory flag or alternate exchange, and the router acks it. The pattern ROUTER.md recommends for 'routing key preserved' (`broadcast@topic:broadcast > writer@topic:writer`) and the examples at :91 and :97 therefore lose every message whose key is not the queue name. Fanout destinations are unaffected.

**Evidence.** topology.ts:81 `queues![destination.queue] = { durable: true }`; packages/rabbitmq/src/topology.ts:52-56 falls back to `[queueName]`. The second verifier reproduced it with the real parseRules, buildPublisherTopology and declareTopology on a mock channel: the bindings were (writer, writer, key 'writer') and (collect, writer, key 'collect'). No deployed config uses this pattern; it appears only in ROUTER.md.

**Fix.** Docs now (no behaviour change). In ROUTER.md: (1) state that a queue named on a destination exchange is declared and bound with its own name as the binding key, so on topic/direct it receives only messages whose routing key equals the queue name, and consumers that need other keys bind their own queues; (2) replace :91 with `collect@topic:broadcast > @topic:writer(key:message:collect)` and :97 with an exchange-only destination; (3) change the 'routing key preserved' example at :148 to `broadcast@topic:broadcast > @topic:writer`, with a comment that subscribers bind their own queues. Use neutral names if DCOL-20 lands in the same pass.

**Tests to add.** Add a buildPublisherTopology unit test in services/router/tests asserting the binding produced for `writer@topic:writer`. It pins the current behaviour, or the new behaviour if the owner picks the code option.

**Owner question.** Optional code change: should a destination queue on a topic exchange be bound with '#', or should destinations accept an explicit binding key (e.g. reuse `(key:X)`)? Direct exchanges have no wildcard and would need an explicit key. If you change it, also fix buildConsumerTopology (topology.ts:47-48), which defaults a direct-exchange source to '#' (a literal there), and add a direct-source test.

**Verifier notes.** Both confirmed it at high severity; the second reproduced it. The docs fix is bounded and done now. The code change is left to the owner.

## DCOL-03: VAULT.md write-safety, serialisation and restart sections describe an implementation that no longer exists; quarantine leaves a headerless file

- **Severity:** medium
- **Category:** docs+code
- **Decision:** IMPLEMENT
- **Source finding:** F10
- **Locations:**
  - `docs/services/VAULT.md:147-158`
  - `docs/services/VAULT.md:178-180`
  - `services/vault/src/fs/writer.ts:26-56`
  - `services/vault/src/fs/writer.ts:141-185`
  - `services/vault/src/data/ticker.ts:38-40`
  - `services/vault/src/data/parse.ts:55-59`
  - `services/vault/src/fs/reader.ts:75-81`
  - `node_modules/.pnpm/@devvir+zipper@0.1.0/node_modules/@devvir/zipper/dist/file/writer.js:99-195`

**Problem.** VAULT.md says that when a truncate fails, vault writes a sidecar and keeps appending (recoverable with gzrecover). It also describes a `handle.writing` promise chain and `handles.has`. Writing is now done by @devvir/zipper with recovery 'auto'. When the truncate fails, zipper renames the .tmp to `<file>.csv.gz.failed.N`, re-appends the failed member to a fresh .tmp, and the sidecar records the quarantine path. Side effect: the new file has no header row, because isInitialized stays true. The sealed file then lacks a header and the day's earlier data, and `.failed.N` is not listed by GET /files.

**Evidence.** zipper writer.js:124-132 runSafe → quarantine() (:183-194) → re-append (:152-166). writer.ts:56 `writers.has(key) || existsSync(openPath(...))`. ticker.ts:38-40 prepends the header only when !isInitialized. parse.ts takes the first record as column names. reader.ts:75-81 lists only .csv.gz.tmp and .csv.gz.

**Fix.** Docs now. Rewrite 'Write safety': each flush is one gzip member appended by a per-file @devvir/zipper writer (retries 3, i.e. up to 4 attempts, linear backoff 100 ms × attempt, truncating back to the last good size between attempts). A member that still fails is dropped and counted by recordFailure. If the truncate also fails, the open file is renamed to `<filename>.csv.gz.failed.N`, the failed member is re-appended to a new `.csv.gz.tmp`, and a `.csv.gz.error` sidecar records the quarantine path. State the current consequences: the new open file has no header row, earlier data is only in `.failed.N`, and `.failed.N` is not listed by GET /files. Replace 'Write serialisation' with 'one zipper writer per open file; writes queue in arrival order'. Fix :180 to `writers.has(key) || existsSync(openPath(...))`. Do NOT apply the reviewer's one-line code fix (delete the writers entry): the verifier showed it cannot work, because zipper has already re-appended the member and the .tmp exists.

**Tests to add.** When the code fix is chosen: force appendFile and truncate to fail (vi.spyOn fs.promises) and assert the sealed file's first record equals headersFor(table).

**Owner question.** How should a post-quarantine file get its header? (a) add a zipper option (preamble/onFreshFile) that writes a header member before the re-append; (b) switch vault to recovery 'none' and handle quarantine itself (header + member); (c) track quarantined keys and rebuild the file at seal. This is moot if vault is deprecated (DCOL-17). The trigger is rare: both the append and the truncate must fail.

**Verifier notes.** The first verifier confirmed it but downgraded high to medium because the trigger needs a sick disk. They refuted the suggested code fix and left the code change to the owner. No second verdict.

## DCOL-04: Vault GET /files/:table/:date?skip=N on a missing file answers 200 and never ends (docs promise 404)

- **Severity:** medium
- **Category:** code
- **Decision:** IMPLEMENT
- **Source finding:** F12
- **Locations:**
  - `services/vault/src/server/routes.ts:138-152`
  - `docs/services/VAULT.md:98-100`

**Problem.** With skip>0 the handler flushes the headers before the stream starts. The NotFoundError that the generator raises later finds headersSent true, so no 404 can be sent, and the branch has no else, so the response never ends. The client hangs on a 200.

**Evidence.** Reproduced by both reviewer and verifier (scratch/vault-skip.cjs against dist routes.js). Without skip the answer is 404 with a JSON body; with `?skip=3` it is 200 and the body never completes. routes.ts:150 `if (skip > 0) res.flushHeaders();`; :139-141 has no else.

**Fix.** In routes.ts GET /files/:table/:date, before building the stream: `if (fileState(table, filename) !== 'closed') { res.status(404).json({ error: `No closed file for ${table}/${filename}` }); return; }`. In the NotFoundError branch: `if (!res.headersSent) res.status(404).json(...); else res.destroy();`. VAULT.md:100 is then correct as written.

**Tests to add.** A vitest/supertest case: GET with ?skip=3 on a missing file returns 404 promptly.

**Verifier notes.** Confirmed and reproduced. Impact is limited today because vault has no live client (DCOL-17).

## DCOL-05: Vault docs give the wrong port, say there are no env vars, and say open files can be read

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F13+F25(part)
- **Locations:**
  - `services/vault/README.md:10`
  - `services/vault/README.md:26`
  - `docs/services/VAULT.md:54`
  - `services/vault/src/server/index.ts:13`
  - `services/vault/docker/compose.yml:12`
  - `services/vault/docker/base.yml:18`
  - `services/vault/src/config.ts:6-22`
  - `services/vault/src/fs/reader.ts:17-28`
  - `.env.example:28-30`

**Problem.** README:26 says 'No environment variables ... listens on port 80', and VAULT.md:54 and .env.example give `http://vault`. The server listens on 8000 (health on 3000) and reads VAULT_COMPRESSION_LEVEL (integer 1-9, default 6; invalid values fail startup). README:10 says open files are streamed, but open files return 404.

**Evidence.** index.ts:13 `const PORT = 8000;` (re-checked; the reviewer cited :74). compose maps `${VAULT_PORT:-}:8000`. config.ts validates 1-9. reader.ts:21 'Open files are not readable'.

**Fix.** services/vault/README.md Configuration: 'HTTP API on port 8000; health on port 3000. VAULT_COMPRESSION_LEVEL: gzip level, integer 1-9, default 6; any other value fails startup. Data directory fixed at /data/vault; mount it writable.' Do not use the F25 verifier's wording 'listens on port 80', which is wrong. README:10: 'streams sealed (closed) files back as NDJSON'. VAULT.md:54: 'All routes are relative to http://vault:8000.' Mention VAULT_COMPRESSION_LEVEL in VAULT.md's configuration (it is an env var, not a code constant). .env.example: VAULT_URL=http://vault:8000, or remove VAULT_URL, since no live service reads it.

**Tests to add.** None.

**Verifier notes.** Confirmed. The F25 verifier independently flagged README:26's 'No environment variables' as false, but their proposed text kept 'port 80'. Corrected here against index.ts:13.

## DCOL-06: VAULT.md HTTP API is wrong about listings, PUT and errors, and omits 429 and /stats

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F11
- **Locations:**
  - `docs/services/VAULT.md:56`
  - `docs/services/VAULT.md:67-79`
  - `docs/services/VAULT.md:108-118`
  - `services/vault/src/fs/reader.ts:50-61`
  - `services/vault/src/server/routes.ts:58-61`
  - `services/vault/src/server/routes.ts:94-97`
  - `services/vault/src/server/routes.ts:173-177`
  - `services/vault/src/server/routes.ts:256-282`
  - `services/vault/src/fs/writer.ts:37-38`
  - `services/vault/src/fs/writer.ts:111-118`

**Problem.** (1) Listings never mix bare and suffixed files: no ?suffix gives bare-date files only, and ?suffix=X gives files tagged X only. The doc's mixed example is wrong. (2) POST /rows returns 429 when 15 writes are pending (it clears at 5), and 400 for a table with no header definition; neither is documented. (3) A failed PUT removes its .tmp, so leftovers come only from a crash. A PUT onto a file being written by POST /rows discards its buffered rows. (4) GET /stats/:table/:date is undocumented and ignores ?suffix, which contradicts VAULT.md:56.

**Evidence.** reader.ts:59-61 suffix filter; routes.ts:58-61 status 429; writer.ts:37-38 MAX_INFLIGHT=15, INFLIGHT_RESUME=5; writer.ts:114-118 unlink on error; routes.ts:173-177 flush/remove/deleteFile; routes.ts:265 `req.params['date']` with no filenameOf.

**Fix.** GET /files/:table: 'Without ?suffix, only bare-date files; with ?suffix=X, only files tagged X.' Give two examples and drop 'additional keys'. POST /rows errors: add '429: too many writes pending for this file (throttled at 15 pending, cleared at 5)' and '400: table has no header definition'. PUT: 'A failed upload is removed. An open .csv.gz.tmp left by a crash, or one being written by POST /rows, is discarded together with that file's buffered rows.' Add a GET /stats/:table/:date section ({state,size,mtime,birthtime}, 404 when absent). Code: change routes.ts:265 to use filenameOf(req), so ?suffix works.

**Tests to add.** A test that GET /stats/:table/:date?suffix=X returns the suffixed file's stats.

**Verifier notes.** Confirmed. The verifier also found a latent race: in the PUT open-file branch, a queued zipper append can write into the .tmp that storeFile is streaming. Awaiting drainHandle before deleteFile would fix it. That is listed under unverified code observations, not implemented here.

## DCOL-07: Pipe README syntax and its 'type omitted' example are rejected at startup

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F7
- **Locations:**
  - `services/pipe/README.md:32`
  - `services/pipe/README.md:36`
  - `services/pipe/README.md:71-74`
  - `services/pipe/src/bindings.ts:83-84`
  - `shared/utils/src/routes.ts:123-129`
  - `services/pipe/docker/compose.yml:22`
  - `services/pipe/src/config.ts`

**Problem.** The README gives the syntax `[type:]source > [queue@][type:]destination`, says the type defaults to fanout, and gives the example `broadcast > ingest`. A bare name is a queue, and pipe rejects queues on both sides, so the example fails at startup and, with restart: on-failure, crash-loops. Only the `@name` form omits the type. The README also leaves out QUEUE_URL, which is required.

**Evidence.** Reproduced with dist/src/bindings.js: `broadcast > ingest` gives 'Pipe source must be an exchange, not a bare queue'; `@broadcast > @ingest` gives two fanout exchanges and one binding.

**Fix.** Syntax line: `source[(key:pattern)] > [queue]@[type:]destination`, where an exchange is written `type:name` or `@[type:]name` and a missing type means fanout. Line 36: 'type defaults to fanout only in the `@name` form; a bare name is a queue and is rejected.' Example: `PIPE_BINDINGS="@broadcast > @ingest"`. Mention `&` (cross product). Add QUEUE_URL as required. If DCOL-08 lands, keep only the pipe-specific restrictions and point to the grammar's home.

**Tests to add.** Optional pipe test: `broadcast > ingest` is rejected and `@broadcast > @ingest` is accepted, so the README example stays honest.

**Verifier notes.** Confirmed; downgraded high to medium because the failure is loud and clear and nothing is lost silently.

## DCOL-08: The shared rule grammar is documented twice, in two consumer docs that disagree with each other and the code

- **Severity:** medium
- **Category:** docs-structure
- **Decision:** IMPLEMENT
- **Source finding:** F8
- **Locations:**
  - `docs/services/ROUTER.md:7-64`
  - `services/pipe/README.md:29-51`
  - `services/pipe/README.md:107-118`
  - `shared/utils/src/routes.ts:23-41`
  - `services/router/src/config.ts:9`
  - `services/pipe/src/bindings.ts:18`

**Problem.** Router and pipe both use shared/utils parseRules. The grammar is explained in depth in ROUTER.md and again in the pipe README; both versions are wrong in different ways (DCOL-07, DCOL-18). The only accurate description is the routes.ts docblock. shared/utils has no README. This breaks 'each subject has one home'. The pipe README's 'Pipe vs Router' table also describes its neighbour, which breaks 'a doc is about its own subject'.

**Evidence.** ROUTER.md:35 'A colon without @ is treated as an error' versus routes.ts:28-29, which accepts the `type:exchange` shorthand. The pipe example fails (DCOL-07).

**Fix.** Create shared/utils/README.md with a 'Rule grammar' section as the single home, built from routes.ts:23-41: the item forms `[queue][@[type:]exchange][(modifiers)]` and `type:exchange[(modifiers)]`, `&` cross product, `|` rule sets, whitespace stripped, valid types (no type means fanout, `default` maps to direct), name charset [\w.-], key:value / key:value:replace / header:name=value, and the parse errors. ROUTER.md keeps only router specifics: a source must have a queue, replace is destination-only, key and header semantics on publish. The pipe README keeps only pipe restrictions: both sides are exchanges, the key only on the source, no replace or headers, direct needs a key, topic defaults to '#', `queue@` asserts a durable queue bound with '#'. Each points to the home. Replace the Pipe vs Router table with one line: 'For per-message transforms see router.'

**Tests to add.** Optional: a doc-example test that runs every rule in the README examples through parseBindings/loadConfig.

**Verifier notes.** Confirmed. This is independent of DCOL-26's convention choice: the grammar home is shared/utils whichever way the router docs go. Do DCOL-18 inside this rewrite.

## DCOL-09: HAULER.md goes as deep on the canonical key layout as CATALOG-API.md, and adds history, venue facts and stale measurements

- **Severity:** medium
- **Category:** docs-structure
- **Decision:** IMPLEMENT
- **Source finding:** F15
- **Locations:**
  - `docs/services/HAULER.md:25-112`
  - `docs/modules/CATALOG-API.md:202-232`
  - `services/catalog/src/listings/keys.ts:7-22`
  - `docs/DATA_PIPELINE.md:90`

**Problem.** HAULER.md says 'The key is the catalog's, not hauler's', then spends about 85 lines on the grammar, at the same depth as CATALOG-API.md. It calls the letter folder `FL` where CATALOG-API.md and keys.ts use `F`. It also describes a neighbour (the query engine reading the vault), states venue facts (bitget/gate part counts), measures 'every symbol in the catalog' from two venues out of seven, and quotes inode and file counts that will go stale.

**Evidence.** HAULER.md:29,56,69,95 `FL` versus CATALOG-API.md:205 and keys.ts:10 `F`. HAULER.md:46-47 vault/query engine; :64-66 venue facts; :74-75 bitget/okx only, while CATALOG-API.md:216-217 mentions gate symbols in Chinese. DATA_PIPELINE.md:90 is the only link to #the-layout-on-disk.

**Fix.** Replace 'The layout on disk' with a short section: hauler writes each listed object at `<archives>/<key>` and derives no name itself; one example path (e.g. `/data/archives/bitget/perp/klines,1m/B/BTCUSDT/202506/bitget|perp|klines,1m|BTCUSDT|20250601.zip`); grammar in CATALOG-API.md#listings. Move any rationale worth keeping into CATALOG-API.md on the catalog's own terms (positional rather than key=value, path for people and filename for programs, `F` as a filesystem device, `@` sorting first, provenance held by the catalog). Do not move the vault/query-engine sentence, the symbol measurement, the inode/file figures or the venue part counts. Re-point DATA_PIPELINE.md:90 to CATALOG-API.md. Afterwards, grep for '#the-layout-on-disk'.

**Tests to add.** None.

**Verifier notes.** Confirmed. CATALOG-API.md naming venue splits is allowed (the catalog consumes venues).

## DCOL-10: Two docs cover the archives module at the same depth, with a wrong pointer, a wrong link and a missing variable

- **Severity:** medium
- **Category:** docs-structure
- **Decision:** IMPLEMENT
- **Source finding:** F23
- **Locations:**
  - `docs/modules/ARCHIVES.md:12-17`
  - `docs/modules/ARCHIVES.md:42-73`
  - `docs/modules/ARCHIVES.md:57`
  - `modules/collect/archives/README.md:6-49`
  - `modules/collect/archives/.env.example`

**Problem.** Both docs carry the services list, the prospector/hauler split rationale, the CATALOG_DIR description with an identical mkdir/chown command, and how surveys start; they already contradict each other (DCOL-11). ARCHIVES.md says it is 'only what you need to run the module' yet carries design. Its variable table omits HAULER_MIN_FREE_GB. README:48-49 points to docs/services for variables, but HAULER.md defers to the service README. ARCHIVES.md:13 links the catalog README instead of docs/services/CATALOG.md.

**Evidence.** The identical command appears at ARCHIVES.md:67 and README:45. .env.example sets HAULER_MIN_FREE_GB=25. HAULER.md:314 'See the service README for the environment'.

**Fix.** (1) Make the module README the operational page: services table, `tb` commands, the full variable table moved from ARCHIVES.md:48-57 plus HAULER_MIN_FREE_GB (default 25), the empty-token paragraph, the CATALOG_DIR setup with mkdir/chown, the fresh-catalog note, and the survey curl examples with the enrolment semantics from DCOL-11. (2) Reduce ARCHIVES.md to the design: flow diagram, the four-service paragraph without the 'only what you need to run' sentence, 'Why it is split this way', enrolment semantics, token semantics in one sentence, and 'What it is for'. Replace 'Running it' and the operational half of 'Starting a survey' with a pointer. (3) Cut README:6-9 to one sentence plus a pointer. (4) README:48-49: 'each service's README for its variables'. (5) ARCHIVES.md:13 → ../services/CATALOG.md. Inbound links point to the page, not anchors, so nothing breaks.

**Tests to add.** None.

**Verifier notes.** Confirmed in every detail. Matches the warehouse module's convention.

## DCOL-11: Archives module README says surveys resume only when asked; prospector resumes enrolled venues on every start

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F22
- **Locations:**
  - `modules/collect/archives/README.md:30-32`
  - `docs/modules/ARCHIVES.md:77-83`
  - `services/prospector/src/index.ts:150-158`
  - `services/prospector/src/index.ts:199`
  - `services/prospector/src/index.ts:288-325`

**Problem.** The README says an interrupted job 'resumes when it is next asked to'. Prospector calls resume(db) at startup, re-surveys every enrolled, unpaused venue, and resumes an open job immediately. An operator expecting a quiet restart is surprised.

**Evidence.** index.ts:199 resume(db); dueFor returns 0 for an open job ('resumes immediately'). ARCHIVES.md:77-83 agrees with the code.

**Fix.** Replace README:30-32 with: 'Prospector surveys nothing until a venue is asked for. Once asked, a venue stays enrolled: on every start, an interrupted job resumes from its cursors, a venue between passes waits out its interval, and a paused venue stays paused. Surveys are started and paused from catalog-ui (`CATALOG_UI_PORT`); prospector publishes no API port.' Do it as part of DCOL-10, so only one doc carries these semantics.

**Tests to add.** None.

**Verifier notes.** Confirmed at medium.

## DCOL-12: Hauler README says a refusal pauses the whole venue, and misstates who rules on a failure and when a 404 fails a file

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F16
- **Locations:**
  - `services/hauler/README.md:33-38`
  - `services/hauler/src/hosts.ts:92-117`
  - `services/hauler/src/fetch.ts:166`
  - `services/hauler/src/fetch.ts:175-187`
  - `services/hauler/src/fetch.ts:301-313`

**Problem.** A 429, any Retry-After, or five 403s in a row takes only the refusing address out of rotation, and fetches wait only when every address of that server is out. Prospector, not the catalog, rules on reported failures. A 404 fails a file only after every address in rotation answers 404 or 410. HAULER.md states all of this correctly.

**Evidence.** hosts.ts refused() sets outUntil on one Host; fetch.ts:303 picks another address; :307-311 sleeps only when none is open; :175-187 tries the next address on GONE.

**Fix.** Line 38: 'A refusal (429, any Retry-After, or five 403s running) takes the refusing address out of rotation for a while; fetches wait only where every address of that server is out.' Lines 33-34: 'The catalog forwards the report to prospector, which checks the venue again and rules.' Line 35: '(404 or 410 from every address in rotation, or 403 from the listed address on every attempt)'. Optionally trim the .bak-numbering detail; do not rewrite the section.

**Tests to add.** None.

**Verifier notes.** Confirmed. The verifier judged the 'shorten What it does' sub-proposal discretionary, not required.

## DCOL-13: Hauler compose comments say the concurrency budget is per venue and that a stop leaves a .part

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F17
- **Locations:**
  - `services/hauler/docker/compose.yml:33`
  - `services/hauler/docker/compose.yml:57-61`
  - `services/hauler/src/venue.ts:177-199`
  - `services/hauler/src/fetch.ts:91-95`
  - `services/hauler/src/fetch.ts:269-273`
  - `services/hauler/src/index.ts:138-143`
  - `services/hauler/src/store.ts:48-49`

**Problem.** HAULER_CONCURRENCY is one budget shared by every venue (a single global counter), not a per-venue budget. On a normal stop, abandon() aborts each download after 15 s and discards its partial, so nothing is left behind; only a killed container leaves partials, and those live in `.hauler-tmp/<sha1>.part`, not beside the destination. This comment sits beside the knob an operator tunes.

**Evidence.** venue.ts:180 'config.concurrency is the machine's budget, not each venue's'; fetch.ts:270 `await discard(path)`. The verifier's nuance: mismatched downloads are held in .hauler-tmp and swept at the next start.

**Fix.** compose.yml:33 → '# Concurrent fetches across every venue together — one budget for the link'. compose.yml:57-60 → '# A stop gives files in flight 15 s, then gives them up (left owed, partials removed); the other 15 s are for the reports. A container killed mid-download leaves partials in .hauler-tmp, which the next start deletes, and the file is fetched again.'

**Tests to add.** None.

**Verifier notes.** Confirmed.

## DCOL-14: Hoarder's Binance futures note contradicts BINANCE.md and is written as a plan

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F20
- **Locations:**
  - `services/hoarder/README.md:40`
  - `services/hoarder/src/venues/binance.ts:20-23`
  - `docs/venues/BINANCE.md:568-573`

**Problem.** The hoarder README and the binance.ts docblock say futures 'delivers nothing from our network' and needs verifying. BINANCE.md (the provider) verified it live: the endpoint is wss://fstream.binance.com/public/ws, and /ws and /stream fail silently. The hoarder text gives the wrong cause, and 'needs verifying before being added' is a plan.

**Evidence.** BINANCE.md:570-573.

**Fix.** README:40 → 'Binance futures (`fstream.binance.com`) is not implemented; its endpoint path and the paths that fail silently are in [BINANCE.md](../../docs/venues/BINANCE.md#websocket).' binance.ts:20-23 → 'Futures is not implemented; see docs/venues/BINANCE.md#websocket for its endpoint.' Put any intent to add futures in ROADMAP's WebSocket section, not here.

**Tests to add.** None.

**Verifier notes.** Confirmed.

## DCOL-15: ROUTER.md health section describes responses the router never gives

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F4
- **Locations:**
  - `docs/services/ROUTER.md:171-181`
  - `services/router/src/service.ts:4-9`
  - `packages/service-kit/src/plugins/health.ts:32-37`
  - `shared/utils/src/services.ts:85-92`

**Problem.** ROUTER.md says /health lists the routes, is gated on topology, and returns 503 when the broker is down. The router registers no healthCheck listener and no trackMessages, so the service-kit plugin always answers 200 {"status":"ok"} once it starts. The compose healthcheck only checks that the process is alive.

**Evidence.** service.ts has no trackMessages; grep finds no healthCheck in services/router/src; health.ts:32-37 is the fallback answer.

**Fix.** Replace ROUTER.md:171-181 with: 'Port 3000 `/health` answers 200 `{"status":"ok"}` while the process runs. It does not report broker connectivity, topology or routes.'

**Tests to add.** None.

**Owner question.** Optional: do you want a real health signal (a healthCheck listener answering 503 when consumer.getChannel() is null)? If so, implement and document it separately.

**Verifier notes.** Confirmed.

## DCOL-16: Router config docs leave out QUEUE_URL and the whole backpressure feature

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F5
- **Locations:**
  - `docs/services/ROUTER.md:163-169`
  - `services/router/README.md:27-28`
  - `services/router/src/config.ts:8-30`
  - `services/router/src/backpressure.ts:1-89`
  - `services/router/src/consumer.ts:18-19`
  - `services/router/src/index.ts:11`
  - `services/router/docker/compose.yml`

**Problem.** Both docs list only ROUTER_RULES. The code requires QUEUE_URL (also used for a second, publishing connection) and supports ROUTER_MAX_READY/ROUTER_WATCH_QUEUES backpressure: a 2 s poll, a shared pause re-checked every 1 s, and prefetch 1000 when enabled versus unlimited otherwise. The compose file passes neither backpressure variable, so the feature cannot be enabled there.

**Evidence.** config.ts:8,13,14,28,30; consumer.ts:18-19 prefetch(1000) only with backpressure; index.ts:11 RabbitMQ.keepAlive.

**Fix.** ROUTER.md Configuration table: QUEUE_URL (required, AMQP URL, also used for the publisher connection); ROUTER_RULES (required); ROUTER_MAX_READY (default 0 = off); ROUTER_WATCH_QUEUES (comma-separated; required when ROUTER_MAX_READY > 0; checked passively, so the router does not need to declare them). Add a 'Backpressure' subsection as above. Router README points to the table. Add `ROUTER_MAX_READY: ${ROUTER_MAX_READY:-0}` and `ROUTER_WATCH_QUEUES: ${ROUTER_WATCH_QUEUES:-}` to services/router/docker/compose.yml.

**Tests to add.** None.

**Verifier notes.** Confirmed. The verifier added the compose gap.

## DCOL-17: 'Vault' names two different stores at one container path, and the vault service has no remaining producer

- **Severity:** medium
- **Category:** docs-structure
- **Decision:** DEFER
- **Source finding:** F14
- **Locations:**
  - `docs/services/VAULT.md:1-11`
  - `docs/VOCABULARY.md:93`
  - `docs/DATA_PIPELINE.md:82-93`
  - `modules/store/warehouse/README.md:3-5`
  - `modules/store/warehouse/README.md:22`
  - `.env.example:25`
  - `services/vault/src/fs/paths.ts:1`
  - `services/vault/docker/base.yml`
  - `services/vault/src/server/index.ts:88`
  - `services/vault/src/fs/writer.ts:5`
  - `services/vault/src/fs/writer.ts:100-104`
  - `services/vault/src/server/routes.ts:155`

**Problem.** VOCABULARY defines Vault as the Parquet folder at /data/vault (DATA_VAULT_DIR, mounted by stocker). The BitMEX CSV HTTP service is also called vault, also uses /data/vault, and leaves the mount to 'whoever wires the service in'. VAULT.md never says the two are distinct. DATA_PIPELINE.md:82 does tell them apart, but with history ('both historically called "vault"'). Nothing writes to the vault service any more: scribe and tardy are deprecated, 'courier' exists only in vault's own comments, and no module includes it. Yet VAULT.md documents a full write API as if it were in use.

**Evidence.** VOCABULARY.md:93; .env.example:25 'The Parquet vault'; paths.ts DATA_DIR='/data/vault'; no modules/*/*/compose.yml includes services/vault; services/.deprecated holds scribe and tardy.

**Fix.** Depends on the decision. Option A (keep as BitMEX CSV store): title VAULT.md 'Vault service (BitMEX CSV store)', open by saying it is not the Parquet vault (pointer to VOCABULARY.md), say its mount must never be DATA_VAULT_DIR or, better, change DATA_DIR to a distinct path such as /data/csv-store (paths.ts, base.yml, README, VAULT.md), and trim the write API to what docs/bitmex needs if nothing will write again. Option B: move services/vault to services/.deprecated and repoint docs/bitmex and DATA_PIPELINE.md. Either way: rewrite DATA_PIPELINE.md:82 without 'historically', and replace 'courier'/'journalist' in vault comments (index.ts:88, writer.ts:5,100-104, routes.ts:155, middleware.ts:19, data/headers.ts:9) with neutral wording ('a client').

**Tests to add.** None.

**Owner question.** What is the vault service's future? (A) keep it as the BitMEX CSV store: rename it in docs, move its container path off /data/vault, and possibly drop the write API; or (B) deprecate it. This decides whether DCOL-03/04/05/06/24 are worth doing.

**Verifier notes.** Confirmed at medium, with the 'neither doc distinguishes them' claim narrowed to VAULT.md and VOCABULARY.md. Deferred as an owner decision; the user asked for decisions to be collected, not taken.

## DCOL-18: ROUTER.md says a colon without @ is an error, but the shared grammar accepts it; rejection list incomplete

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F3
- **Locations:**
  - `docs/services/ROUTER.md:15-35`
  - `docs/services/ROUTER.md:153-161`
  - `shared/utils/src/routes.ts:28-29`
  - `shared/utils/src/routes.ts:83`
  - `shared/utils/src/routes.ts:105-122`
  - `shared/utils/src/routes.ts:161-164`
  - `services/router/src/config.ts`

**Problem.** parseRules accepts `type:name` without @ as exchange-only shorthand, and `@name` with no type (declared fanout). `header:` on a source is accepted and silently dropped by toSource. 'Unclosed parenthesis' and the invalid-name rejections are not listed. The doc is stricter than the code, so rules written from it still work.

**Evidence.** Ran parseRules: `a > fanout:broadcast` gives an exchange-only fanout destination; `a@x > b` gives an exchange with no type; `a@topic:x(header:x=1) > b` raises no error.

**Fix.** Do this inside DCOL-08. Delete ROUTER.md:35. In the rejection list, replace 'Colon without @' with 'a `type:` prefix that is not a known exchange type', and add 'unclosed parenthesis' and 'invalid queue or exchange name (allowed: letters, digits, _ . -)'. Preferred: make toSource throw on `item.headers`; otherwise document that they are ignored.

**Tests to add.** If toSource is made strict, add a test that a header modifier on a source is rejected.

**Verifier notes.** Confirmed; downgraded medium to low because rules written from the doc still work.

## DCOL-19: ROUTER.md misstates header merging, fan-out failure handling and routing-key modifiers

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F6
- **Locations:**
  - `docs/services/ROUTER.md:49-50`
  - `docs/services/ROUTER.md:57`
  - `docs/services/ROUTER.md:132-139`
  - `services/router/src/consumer.ts:30-44`
  - `services/router/src/consumer.ts:93`
  - `services/router/src/consumer.ts:102`

**Problem.** Injected headers override incoming headers of the same name; the doc says 'merged non-destructively'. Destinations are published in sequence, and a failure requeues the message, so earlier destinations get duplicates. `(key:match:replace)` replaces the first substring occurrence. A `(key:...)` on a default-exchange destination is ignored.

**Evidence.** consumer.ts:37 spread order; :32-44 awaited loop then nack(requeue); :102 String.replace; :93/:33 fixedRoutingKey wins.

**Fix.** ROUTER.md:57 and :132: 'An injected header overrides an incoming header of the same name; other headers are kept.' :135: 'Destinations are published in order; if any publish fails, the message is requeued, so destinations already published receive it again (at-least-once).' :49: 'replaces the first occurrence of the substring `match` with `replace`'. :139: 'A (key:...) modifier on a default-exchange destination has no effect.'

**Tests to add.** Optional: toDestination rejects `(key:...)` on a destination without an exchange (with a test).

**Verifier notes.** Confirmed.

## DCOL-20: Router and pipe examples name retired services; pipe README uses plan phrasing

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F9
- **Locations:**
  - `docs/services/ROUTER.md:70-111`
  - `services/pipe/README.md:49`
  - `services/pipe/README.md:62`
  - `services/pipe/README.md:93-95`
  - `services/vault/src/server/middleware.ts:19`
  - `services/vault/src/data/headers.ts:9`

**Problem.** The examples use writer, codec, archive, journalist and `x-writer-database=tradebot_collect` (the retired MongoDB writer). Pipe README:95 states that a journalist service exists, which is false. 'Header-based filtering is not yet supported' is plan phrasing.

**Evidence.** ls services: no writer, codec or journalist. DATA_PIPELINE.md:146 records that the MongoDB pipeline is gone.

**Fix.** Use neutral names (src, dst, events, audit) and a neutral header (`header:x-origin=router`). In pipe README:93-95 use `events@topic:events` and 'consumers can then read from the events queue without declaring it'. README:49: 'Header-based filtering is not supported; a headers exchange is bound with {} and forwards everything.' The vault comment cleanup is covered in DCOL-17. Fold this into the DCOL-08/DCOL-02 rewrites.

**Tests to add.** None.

**Verifier notes.** Confirmed. The verifier noted that the vault comments also mention journalist.

## DCOL-21: Hoarder README does not say collection is parked or name the exchange it publishes to

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F21
- **Locations:**
  - `services/hoarder/README.md:3-18`
  - `services/hoarder/README.md:61-67`
  - `services/hoarder/src/venues/channels.ts:13-17`
  - `services/hoarder/src/service.ts:12`
  - `services/hoarder/src/messages.ts:37-38`
  - `docs/DATA_PIPELINE.md:63-65`

**Problem.** The README presents hoarder as a working collector. It is parked, its channel lists are provisional two-symbol placeholders, and no module deploys it. The envelope section lists headers, but not the exchange (`hoarder`, topic, declared by hoarder) or contentType; the exchange name appears in no doc.

**Evidence.** service.ts:12 `exchanges: { hoarder: { type: 'topic' } }`; messages.ts:37-38 routing key = venue, contentType application/json; channels.ts:13 'provisional'.

**Fix.** After the intro: 'Status: the channel lists in src/venues/channels.ts are provisional (BTC and ETH only, written before the venue surveys), and no module deploys hoarder.' In 'Message Envelope', before the table: 'Every frame is published to the topic exchange `hoarder` (declared at startup), routing key = venue name, contentType `application/json`, body = the frame as received.' The last clause is true once DCOL-01 lands; if DCOL-01 is not done, say 're-serialised JSON' instead.

**Tests to add.** None.

**Verifier notes.** Confirmed; downgraded medium to low because the service is parked and has no consumer.

## DCOL-22: Hauler docs don't say venues and hosts are read once at startup, or that some state is in memory

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F19
- **Locations:**
  - `docs/services/HAULER.md:22-23`
  - `docs/services/HAULER.md:116`
  - `services/hauler/README.md:56`
  - `services/hauler/src/index.ts:36-39`
  - `services/hauler/src/fetch.ts:141-144`

**Problem.** The venue list and hosts are read once at startup, so a venue the catalog gains later is not walked until a restart. A HAULER_VENUES name that the catalog only learns about later has files but no address. 'Keeps no state' omits the in-memory held downloads and address scores. The /health endpoint on :3000 is never mentioned.

**Evidence.** index.ts:36-39 calls venues() once. Host lookup at startup is already stated at HAULER.md:210 (partial overstatement in the finding).

**Fix.** HAULER.md 'Walking a listing': 'The venue list and each venue's addresses are read once at startup: a venue the catalog gains later is walked only after a restart, and one named in HAULER_VENUES before the catalog knew it has no address, so its files stay owed (logged per file) until then.' HAULER.md:22 → 'It keeps no persistent state', adding that held downloads and address scores live in memory and start empty. README:56 → 'Hauler serves no API beyond /health on :3000, and keeps no persistent state other than the files on disk.'

**Tests to add.** None.

**Verifier notes.** Confirmed as mostly true; the verifier narrowed the HAULER_VENUES edge case.

## DCOL-23: HAULER.md and a hauler docblock carry history

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F18
- **Locations:**
  - `docs/services/HAULER.md:261-263`
  - `services/hauler/src/store.ts:20-22`

**Problem.** HAULER.md:261-263 tells the story that motivated the timeout rule, and the store.ts docblock compares against a past design. Both break 'only what is true today'.

**Evidence.** The quoted text at the cited lines.

**Fix.** Delete the sentence that starts 'Reporting them as failures had prospector...' (HAULER.md:261-263). store.ts:20-22 → 'What an interrupted hauler leaves behind is then one directory to delete, with no search of the archive.'

**Tests to add.** None.

**Verifier notes.** Confirmed.

## DCOL-24: Smaller VAULT.md issues: future framing, history in a docblock, and the 429 throttle constants missing

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Source finding:** F25
- **Locations:**
  - `docs/services/VAULT.md:30`
  - `docs/services/VAULT.md:207-218`
  - `services/vault/src/server/routes.ts:10-12`
  - `services/vault/src/fs/writer.ts:37-38`

**Problem.** 'one rule covers any future variant' is future framing. routes.ts:11-12 'match what existed before suffixes were introduced' is history. The tuning table omits MAX_INFLIGHT=15 and INFLIGHT_RESUME=5.

**Evidence.** The cited lines; writer.ts:37-38.

**Fix.** VAULT.md:30: drop 'and one rule covers any future variant'; optionally add '(sets defined in shared/utils tables.ts)'. Leave line 152 ('Retry up to 3 times') as it is; it is correct. Add rows `MAX_INFLIGHT | fs/writer.ts | 15` and `INFLIGHT_RESUME | fs/writer.ts | 5` (the 429 text itself is in DCOL-06). routes.ts:10-12 → 'Without `?suffix=`, the filename is the date alone.' VAULT_COMPRESSION_LEVEL is handled in DCOL-05.

**Tests to add.** None.

**Verifier notes.** Partly refuted: the retry 'miscount' is wrong (1 attempt plus 3 retries is exactly what the doc says), and the module-name complaint is weak (the lookups really are in decode.ts/parse.ts). The rest is confirmed.

## DCOL-25: Planning items on hauler have landed or are out of date

- **Severity:** low
- **Category:** docs-planning
- **Decision:** IMPLEMENT
- **Source finding:** F24
- **Locations:**
  - `docs/planning/CATALOG.md:58`
  - `docs/planning/CATALOG.md:60-62`
  - `docs/planning/BUGS.md:30`
  - `services/hauler/src/venue.ts:162-166`
  - `services/hauler/src/catalog.ts:101-125`
  - `services/hauler/src/index.ts:57-59`
  - `dev/tooling/src/tools/cold/legacy/README.md:11`

**Problem.** Item 4 (cold scripts and stocker on hauler's layout) has landed. The 30-minute paragraph is outdated: a listing that fails after the first page keeps its progress, and 5xx and connection errors are retried, so only a 4xx before the first page rests 30 minutes. The BUGS.md entry points to work that has happened; the one-page audit report it concerns is no longer produced.

**Evidence.** venue.ts:165-166; index.ts:57-59 `found = walked.progressed > 0 && ! walked.full`; the retry is in catalog.ts:101-125 (the reviewer cited :400-424, but the file has 167 lines).

**Fix.** (1) Delete planning/CATALOG.md:58. (2) Replace lines 60-62 with what is still open (only a listing failure before the first page, i.e. a 4xx, rests 30 minutes), or delete them. (3) BUGS.md: delete the 'audit's month counts' entry, or reword line 30 as 'When the one-page report is rebuilt (legacy/audit.ts), derive its first line from the vault ledger and the catalog.' (4) Leave items 1-3 for the owner to check against the live system.

**Tests to add.** None.

**Owner question.** Minor: are planning/CATALOG.md items 1-3 still open on the live system, and is the one-page cold audit report going to be rebuilt (keep or delete the BUGS.md entry)?

**Verifier notes.** Confirmed. The citation was corrected, and the live system was not checked.

## DCOL-26: RabbitMQ service docs are structured three different ways; choose one convention (hoarder and pipe need no docs/services article)

- **Severity:** low
- **Category:** docs-structure
- **Decision:** DEFER
- **Source finding:** F26
- **Locations:**
  - `docs/services/ROUTER.md:1-181`
  - `services/router/README.md:1-30`
  - `services/pipe/README.md:1-118`
  - `services/hoarder/README.md:1-67`

**Problem.** Router splits its docs into a 30-line README and a 181-line ROUTER.md that is mostly the shared grammar. Pipe and hoarder keep everything in their READMEs. None of the three is deployed by any module, and hoarder is parked. Articles for hoarder and pipe are not needed; the real problem is the inconsistency.

**Evidence.** There is no docs/services/PIPE.md or HOARDER.md, and no module compose references these services. The only inbound link to ROUTER.md is services/router/README.md:30.

**Fix.** If README-only is chosen: move the router-specific parts of ROUTER.md (message flow, default exchange and routing keys, validation, configuration, health) into services/router/README.md, delete docs/services/ROUTER.md, and fix the one link. Keep pipe and hoarder README-only; add docs/services/HOARDER.md only if hoarder is un-parked and grows real design. The grammar goes to shared/utils either way (DCOL-08).

**Tests to add.** None.

**Owner question.** Should the three small RabbitMQ services (router, pipe, hoarder) be README-only (fold ROUTER.md into the router README), or should every service have a docs/services article, as the others do? If DCOL-02/15/16/18/19 are applied first, they go into ROUTER.md and move with it.

**Verifier notes.** Confirmed; deferred because it sets a repo-wide convention.

## Deferred: decisions needed

- **DCOL-17** ('Vault' names two different stores at one container path, and the vault service has no remaining producer): What is the vault service's future? (A) keep it as the BitMEX CSV store: rename it in docs, move its container path off /data/vault, and possibly drop the write API; or (B) deprecate it. This decides whether DCOL-03/04/05/06/24 are worth doing.
- **DCOL-26** (RabbitMQ service docs are structured three different ways; choose one convention (hoarder and pipe need no docs/services article)): Should the three small RabbitMQ services (router, pipe, hoarder) be README-only (fold ROUTER.md into the router README), or should every service have a docs/services article, as the others do? If DCOL-02/15/16/18/19 are applied first, they go into ROUTER.md and move with it.

Optional owner questions on items being implemented (the docs fix proceeds either way):

- **DCOL-02**: Optional code change: should a destination queue on a topic exchange be bound with '#', or should destinations accept an explicit binding key (e.g. reuse `(key:X)`)? Direct exchanges have no wildcard and would need an explicit key. If you change it, also fix buildConsumerTopology (topology.ts:47-48), which defaults a direct-exchange source to '#' (a literal there), and add a direct-source test.
- **DCOL-03**: How should a post-quarantine file get its header? (a) add a zipper option (preamble/onFreshFile) that writes a header member before the re-append; (b) switch vault to recovery 'none' and handle quarantine itself (header + member); (c) track quarantined keys and rebuild the file at seal. This is moot if vault is deprecated (DCOL-17). The trigger is rare: both the append and the truncate must fail.
- **DCOL-15**: Optional: do you want a real health signal (a healthCheck listener answering 503 when consumer.getChannel() is null)? If so, implement and document it separately.
- **DCOL-25**: Minor: are planning/CATALOG.md items 1-3 still open on the live system, and is the one-page cold audit report going to be rebuilt (keep or delete the BUGS.md entry)?

## Rejected

- **F25 sub-claim: VAULT.md 'Retry up to 3 times' miscounts zipper's attempts**: Refuted by the verifier. zipper loops attempt 0..retries with retries=3, which is 1 attempt plus 3 retries, exactly what the doc says.
- **F25 sub-claim: VAULT.md:30 names the wrong modules for WS_TABLES/FREE_TEXT_TABLES**: Weak. The sentence is about where the membership lookups run (decode.ts, parse.ts), and that is correct. Naming tables.ts as the definition is optional.
- **F10 suggested code fix: delete the writers entry on quarantine so the header is re-added**: Would not work. zipper re-appends the member before onWriteFailure runs, so the .tmp exists and isInitialized stays true. Replaced by an owner design question (DCOL-03).
- **F25 verifier's README text 'the HTTP server listens on port 80'**: Wrong: index.ts:13 sets PORT = 8000. The DCOL-05 fix uses 8000.
