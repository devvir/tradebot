# Hoarder review (services/hoarder)

## Overall assessment

Hoarder is small and readable, and the Venue abstraction is clean, but it does not do what its README and docblocks promise, and its connection lifecycle loses data silently in ordinary operation. (1) Reconnect: Kraken resubscribes only `channels[0]`, so after any reconnect 3 of the 4 Kraken streams stop (HOA-01). A channel whose startup connect, subscribe or ack fails is never added to the tracked set, so the reconnected socket subscribes nothing, and the failure goes to a 'failure' event nobody listens to (HOA-03). On OKX and Kraken, one error frame fails every concurrent subscription on the socket (HOA-08). The reconnect resubscribe waits for no ack and logs rejections at debug (HOA-09). A late 'close' after an 'error' leaves two live sockets that publish every frame twice (HOA-10), and the backoff resets on every 'open', so an accept-then-close venue gets about 5 connects/s (HOA-11). (2) Fidelity: every frame goes through JSON.parse/JSON.stringify, so the archive is not byte-faithful (trailing zeros, exponent form, large integers, whitespace), and the test compares parsed objects so it cannot see this (HOA-02). (3) Liveness and lifecycle: no handshake timeout and no pong deadline, so hung handshakes and half-open sockets go unnoticed for about 15 minutes or forever, while the global health check stays green (HOA-05). 'Channel closed' is rethrown into a floating promise, which crashes the process with an unhandled rejection on any RabbitMQ loss and during a normal SIGTERM (HOA-06). `isShuttingDown` is never set and shutdown closes only the first socket (HOA-07). Sockets that open during a pause are never paused (HOA-18). (4) Deployment: the prod Dockerfile CMD runs dist/index.js, but every service builds to dist/src/index.js, so the default (prod) compose crash-loops. This is repo-wide (HOA-04). (5) Docs and tests: the README and docblocks claim verbatim relay, resubscription, full backpressure and graceful shutdown; the Binance futures text omits the working `/public/ws` path recorded in docs/venues/BINANCE.md and carries a plan; channels.ts carries history and plans (HOA-12, HOA-13, HOA-20). The reconnect/resubscribe path has no tests, the coverage gate fails (branches 58.28% < 60%), and tests are never type-checked and contain type errors (HOA-14, HOA-16). Practical exposure is lower today because docs/DATA_PIPELINE.md and docs/ROADMAP.md record WebSocket collection as parked, but these defects must be fixed before the vault is built on this data.

Restructuring recommendation (both lenses agree): connection and subscription state is split across websocket.ts (reconnect), pool.ts (swaps `entry.ws`, resubscribes) and subscriptions.ts (acks, confirmed channel set). Replace it with one per-socket connection object that holds the current ws, a generation counter (events from superseded sockets are ignored), the desired channel set, pause state, backoff with a stability window, and pong/liveness state; on every 'open' it resubscribes the desired set one channel at a time through a single correlated, rate-limited ack path with retry. That removes HOA-01, 03, 05, 07, 08, 09, 10, 11, 18 and 19 together. Suggested order: HOA-02 (one line) and HOA-04 first, then the connection object with HOA-14's tests, then HOA-06/07, then the docs (HOA-12, 13, 20) to describe the result.

Cross-unit notes: HOA-04 changes docker/prod.node.Dockerfile, docker/README.md and every services/*/package.json `main`. HOA-21 changes shared/utils/src/security.ts (also used by pipe and router). HOA-12 also needs docs/DATA_PIPELINE.md:60-61 ('verbatim'). HOA-25 is a repo-wide compose convention. Outside hoarder: docs/venues/BINANCE.md:568 frames the venue doc around a would-be consumer, and docs/venues has no KRAKEN.md. Repro scripts: reviews/2026-11/units/scratch/hoarder/ (repro1.mts, race.test.ts, startup.test.ts, vitest.config.mts; run `npx vitest run --config <file>` from services/hoarder), reviews/2026-11/units/scratch/hoarder-F3v3/, reviews/2026-11/units/scratch/hoarder-tests/, reviews/2026-11/units/scratch/f2b/, reviews/2026-11/units/scratch/f7v2/, reviews/2026-11/units/scratch/f12/, reviews/2026-11/units/scratch/resub.mts, reviews/2026-11/units/scratch/cov-hoarder2 (coverage report). The 76 existing tests pass.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| HOA-01 | critical | correctness | IMPLEMENT | Reconnect resubscribes only the first Kraken channel; the other Kraken streams stop silently after every reconnect |
| HOA-02 | high | correctness | IMPLEMENT | The relay is not byte-faithful: every frame is JSON.parse'd and re-serialised before publishing, and the test cannot see it |
| HOA-03 | high | robustness | IMPLEMENT | A failed startup connect, subscribe or ack drops the channel for good: the reconnected socket subscribes nothing and the failure is debug-only |
| HOA-04 | high | config | IMPLEMENT | The prod container runs dist/index.js, but every service builds to dist/src/index.js, so the default compose crash-loops |
| HOA-05 | high | robustness | IMPLEMENT | No liveness detection: hung handshakes, half-open and silent sockets go unnoticed while health stays green |
| HOA-06 | medium | robustness | IMPLEMENT | 'Channel closed' is rethrown from a floating promise: any RabbitMQ loss, and a normal SIGTERM, crash the process with an unhandled rejection |
| HOA-07 | medium | robustness | IMPLEMENT | Shutdown is not graceful: isShuttingDown is never set and only the first socket of each key is closed |
| HOA-08 | medium | correctness | IMPLEMENT | On OKX and Kraken one error frame fails every concurrent subscription on the socket; the docblocks claiming nothing else is in flight are false |
| HOA-09 | medium | robustness | IMPLEMENT | The reconnect resubscribe is fire-and-forget: rejected resubscriptions are logged at debug only |
| HOA-10 | medium | correctness | IMPLEMENT | A late 'close' after 'error' opens a second replacement socket: two live sockets, every frame published twice |
| HOA-11 | medium | robustness | IMPLEMENT | Backoff resets on every 'open': an accept-then-close venue causes a reconnect storm; 418 is not treated as a rate limit |
| HOA-12 | medium | docs | IMPLEMENT | README and docblocks describe behaviour the code does not have |
| HOA-13 | medium | docs | IMPLEMENT | Binance futures text in binance.ts and the README omits the working /public/ws path, carries a plan, and puts a venue quirk in a service doc |
| HOA-14 | medium | testing | IMPLEMENT | Reconnect/resubscribe and failure paths have no tests, and the coverage gate fails |
| HOA-15 | medium | correctness | IMPLEMENT | Binance data frames without an `e` field (bookTicker, partial depth, array streams) would be dropped and warn-logged per frame |
| HOA-16 | medium | testing | IMPLEMENT | Tests are never type-checked and contain type errors and stale fixtures |
| HOA-17 | medium | robustness | DEFER | Frames are published to an exchange with no bound queue, no mandatory flag and no publisher confirms, so they are discarded until a consumer binds |
| HOA-18 | low | robustness | IMPLEMENT | Backpressure misses sockets that are connecting or reconnecting while paused, and a long pause gets sockets dropped by the venue |
| HOA-19 | low | robustness | IMPLEMENT | Two pongs per server ping, and an unthrottled SUBSCRIBE burst against Binance's per-connection message limit |
| HOA-20 | low | docs | IMPLEMENT | channels.ts docblock carries history and plans and points to a Kraken venue doc that does not exist |
| HOA-21 | low | security | IMPLEMENT | config.rabbitmqUrl is sanitised but unused, and sanitizeUrl/redactUrl log the full credentialed URL on failure |
| HOA-22 | low | testing | IMPLEMENT | Weak, tautological and stale tests |
| HOA-23 | low | code-quality | IMPLEMENT | Dead code and unused state |
| HOA-24 | low | correctness | DEFER | Envelope has no connection epoch, so reconnect gaps are invisible; HOARDER_REPLICAS duplicates every stream |
| HOA-25 | low | security | DEFER | Compose bind-mounts the whole repository read-write into the container in every environment |
| HOA-26 | low | code-quality | DEFER | Venue.unsubscribeFrame is required and implemented four times but never called |

## HOA-01: Reconnect resubscribes only the first Kraken channel; the other Kraken streams stop silently after every reconnect

- **Severity:** critical
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/pool.ts:57-61`
  - `services/hoarder/src/venues/kraken.ts:96-100`
  - `services/hoarder/src/venues/types.ts:22-23`
  - `services/hoarder/src/venues/binance.ts:63-64`
  - `services/hoarder/src/venues/bybit.ts:59-60`

**Problem.** On reconnect pool.ts sends one frame for every tracked channel: `newWs.send(v.subscribeFrame([...e.channels]))`. Kraken's `frame()` reads only `channels[0]` (`const { name, symbol } = split(channels[0] ?? '')`), and Kraken v2 takes one `channel` per request anyway. All four Kraken channels share one socket (no socketKey, endpoint 'public'), so after any reconnect only trade:BTC/USD comes back; book:BTC/USD, trade:ETH/USD and book:ETH/USD are gone until the process restarts, with no log above debug and a green health check. OKX, Binance and Bybit put every channel in the frame, but Binance and Bybit derive the request id from channels[0] only, so the multi-channel contract is only half honoured.

**Evidence.** Reproduced by three independent runs: `kraken.subscribeFrame([...VENUE_CHANNELS.kraken])` -> `{"method":"subscribe","params":{"channel":"trade","symbol":["BTC/USD"]}}`. pool.ts:52-61 is the only resubscribe path and is uncovered by tests.

**Fix.** Resubscribe one channel per frame on reconnect, through the same path as startup. (1) In subscriptions.ts extract `subscribeOn(ws, venue, channel, timeoutMs)` = send `v.subscribeFrame([channel])` then await `waitForSubscription`; `subscribe()` uses it. (2) In pool.ts onReconnect, on the new socket's 'open', loop sequentially over `[...e.channels]` awaiting `subscribeOn` for each; log per-channel failures at error and continue with the rest. Sequential is required (see HOA-08). Avoid a pool<->subscriptions import cycle by injecting the resubscribe function into getOrConnect or moving waitForSubscription to a neutral module. (3) Then narrow the Venue contract to `subscribeFrame(channel: string): string` and drop the channels[0] id derivation in binance.ts/bybit.ts, or, if the array signature stays, make Kraken group by channel name or throw for more than one channel name. Minimal stop-gap if the larger change waits: `for (const ch of e.channels) newWs.send(v.subscribeFrame([ch]))`. Best done as part of the per-socket subscription manager (see assessment), together with HOA-03, HOA-08, HOA-09.

**Tests to add.** pool.test.ts: mock './websocket' connect to capture onReconnect; build a Kraken entry with all four VENUE_CHANNELS.kraken channels; call onReconnect(fakeWs), emit 'open', reply with acks; assert the frames sent cover all four (channel, symbol) pairs. A failed resubscribe ack for one channel is logged at error and the others are still resubscribed. venues-protocols.test.ts: each venue's frame names every channel it is given (or the signature becomes single-channel).

**Verifier notes.** 4/4 verdicts confirmed. Severity: critical x3, high x1 (data already stored is not corrupted; it is a collection gap). Kept critical: silent, permanent, unrecoverable loss on a routine event.

## HOA-02: The relay is not byte-faithful: every frame is JSON.parse'd and re-serialised before publishing, and the test cannot see it

- **Severity:** high
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/messages.ts:5-9`
  - `services/hoarder/src/messages.ts:26`
  - `services/hoarder/src/messages.ts:37`
  - `services/hoarder/tests/messages.test.ts:86-97`
  - `services/hoarder/README.md:3`
  - `services/hoarder/README.md:12`
  - `docs/DATA_PIPELINE.md:60-61`

**Problem.** The docblock and README promise a verbatim, byte-faithful archive, but messages.ts publishes `Buffer.from(JSON.stringify(frame))` of the parsed value instead of the received `buffer`. This drops trailing zeros, switches small numbers to exponent form, rounds integers above 2^53, normalises whitespace, \uXXXX escapes and duplicate keys, and costs a full stringify plus allocation per frame. Kraken v2 sends prices and quantities as JSON numbers, and its book checksum is computed over the decimal text, so archived Kraken books can no longer be validated. The test 'publishes the original message verbatim' compares `JSON.parse(content)` with the input, so it passes.

**Evidence.** Repros: `{"qty":0.10000000,"p":0.00000010,"big":123456789012.12345678}` -> `{"qty":0.1,"p":1e-7,"big":123456789012.12346}`; `{"id":12345678901234567890}` -> `{"id":12345678901234567000}`; `{ "topic" : "a",  "data":[] }` -> `{"topic":"a","data":[]}`. packages/rabbitmq/src/exchange.ts:213-216 passes Buffers through unchanged, so the re-serialised bytes are what reaches the archive.

**Fix.** In messages.ts keep `JSON.parse` only for classification (isData/describeControl) and publish the received `buffer`: `await broker.getExchange()!.publish(buffer, venue, { contentType: 'application/json', headers: {...} })`. The control-frame log path may keep stringifying. Once fixed, 'verbatim' in README/docblock/DATA_PIPELINE becomes true (see HOA-12).

**Tests to add.** messages.test.ts: build the raw input as a literal string with `0.10000000`, `45283.50`, `1e-8`, a 19-20 digit integer, a `\u00e9` escape and insignificant whitespace (a frame the twin venue classifies as data), and assert `content.equals(Buffer.from(raw))`; optionally assert `content === buffer`.

**Verifier notes.** 5/5 verdicts confirmed. Severity spread: critical (reviewer A, 2nd verifier A), high (1st verifier A), high (reviewer B), medium (1st verifier B, arguing Binance/Bybit/OKX send strings and Kraken values keep the same double). Chose high: it breaks the service's core invariant, the textual form Kraken's checksum needs is unrecoverable, and large integers do change; but no current venue's values are measurably corrupted in normal traffic. Fix is one line.

## HOA-03: A failed startup connect, subscribe or ack drops the channel for good: the reconnected socket subscribes nothing and the failure is debug-only

- **Severity:** high
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/subscriptions.ts:27-45`
  - `services/hoarder/src/subscriptions.ts:66-70`
  - `services/hoarder/src/pool.ts:58`
  - `services/hoarder/src/index.ts:22-26`
  - `packages/service-kit/src/core/service.ts:50-55`
  - `shared/utils/src/services.ts:86-88`

**Problem.** `entry.channels.add(channel)` runs only after waitForOpen and waitForSubscription both resolve. A DNS/egress error on the first connect, a slow TLS handshake past the 5 s deadline, a socket that drops during the ack wait, or a late ack all leave the channel out of the set. websocket.ts reconnects successfully, but pool.ts resubscribes only when `e.channels.size > 0`, so the new socket opens with nothing subscribed, forever. index.ts routes the rejection to `service.emit('failure', err)`; nothing listens for 'failure' anywhere, and Service.emit logs only at debug (default LOG_LEVEL is info). The health check treats `lastMessageAt === null` as healthy and is satisfied by any venue, so it stays green. Variant: an ack that arrives after the deadline leaves the venue streaming on the current socket, but the channel is lost at the next reconnect.

**Evidence.** Three independent repros with real pool/subscriptions/websocket code (scratch/hoarder/startup.test.ts, scratch/hoarder-F3v3/f3.test.ts and f3b.test.ts, scratch/f2b/f2.test.ts): subscribe against a closed port rejects with ECONNREFUSED; after the server starts, hoarder reconnects (`Connected to main`) and the server receives `frames: []`. Ack-wait variant: socket terminated on subscribe, reject after 5006 ms, connection #2 receives `[]`. grep finds no 'failure' listener in service-kit, shared/utils or hoarder.

**Fix.** (1) Make the pool's set mean desired channels: `entry.channels.add(channel)` right after getOrConnect, before any await. (2) In pool.ts register the 'open' handler on every reconnected socket unconditionally and read the set inside it (`if (e.channels.size) ...`), so channels added between reconnect and open are covered. (3) Treat connect errors, ack timeouts and an ack wait on a since-replaced socket as retryable: log at warn and retry with capped backoff (1 s doubling to 60 s), stopping when the socket is replaced (the reconnect path takes over). Let waitForSubscription reject early when its socket emits 'close'. (4) A definitive venue rejection (matchAck 'failed', e.g. OKX 60018) is logged at error, removed from the desired set and not retried in a loop. Optionally keep a `confirmed` set cleared on reconnect so a late ack cancels its retry. (5) index.ts: replace `service.emit('failure', err)` with `logger.error({ err, venue, channel }, 'Subscription failed')`. Implement together with HOA-01 and HOA-09 in the subscription manager.

**Tests to add.** subscriptions.test.ts / pool.test.ts with the mocked connect: (a) first socket emits 'error' before 'open', then onReconnect(next) + next 'open' -> next.send called with subscribeFrame(['<channel>']); (b) ack timeout on an open socket -> resend after backoff and resubscribe after reconnect; (c) late ack after timeout -> no duplicate subscribe once confirmed; (d) explicit 'failed' ack -> logger.error, no retry, not resent after reconnect; (e) channel added after onReconnect but before 'open' is included.

**Verifier notes.** 4/4 verdicts confirmed, all high. Second verifiers agree the socket error itself is logged at warn; what is invisible is that the subscription is permanently lost while the log shows 'Connected'.

## HOA-04: The prod container runs dist/index.js, but every service builds to dist/src/index.js, so the default compose crash-loops

- **Severity:** high
- **Category:** config
- **Decision:** IMPLEMENT
- **Locations:**
  - `docker/prod.node.Dockerfile:62`
  - `services/hoarder/docker/compose.yml:9`
  - `services/hoarder/docker/compose.yml:41`
  - `services/hoarder/package.json:5`
  - `services/hoarder/package.json:9`
  - `services/hoarder/tsconfig.json:3-6`
  - `docker/README.md:83`

**Problem.** compose.yml builds `docker/${APP_ENV:-prod}.node.Dockerfile` (prod by default) with no command override. The prod CMD is `exec node --max-old-space-size=${NODE_MEMORY_MB} dist/index.js` from WORKDIR /app/services/hoarder. tsconfig has composite:true, no rootDir and include src/**, so output is dist/src/index.js; the container exits with MODULE_NOT_FOUND and `restart: unless-stopped` loops it. package.json `main` is dist/index.js (wrong) while `start` is dist/src/index.js (right); the dev entrypoint (docker/node/entrypoint.sh:23) uses dist/src. docker/README.md:83 documents the wrong path. Every service has the same layout, so this affects all Node services in prod.

**Evidence.** `ls services/hoarder/dist` -> `src tsconfig.tsbuildinfo`; a clean scratch compile produced only src/index.js and `require.resolve('./index.js')` threw MODULE_NOT_FOUND. `.dockerignore` excludes dist/ so the image builds from scratch with the same layout. `ls services/*/dist/index.js` finds nothing. (Reviewer B cited compose.yml:76; the file has 41 lines; correct lines are 9 and 41.)

**Fix.** Change docker/prod.node.Dockerfile:62 to `CMD ["/bin/sh", "-c", "exec node --max-old-space-size=${NODE_MEMORY_MB} dist/src/index.js"]`. Do NOT add `rootDir: src`: the dev entrypoint, every start script and prospector's build (copies seeds into dist/src, schedule.ts:35) depend on dist/src. Set `main` to `dist/src/index.js` (or drop it; these are private apps) in every services/*/package.json (catalog, catalog-ui, hauler, hoarder, pipe, prospector, router, stocker, vault). Fix docker/README.md:83. This is a shared file outside hoarder's scope; coordinate with the other units' reports.

**Tests to add.** Smoke check after `pnpm build`: for each service with a start script, `test -f services/<svc>/dist/src/index.js`; or `docker build -f docker/prod.node.Dockerfile --build-arg SERVICE_NAME=hoarder .` then `docker run --rm <img> sh -c 'test -f dist/src/index.js'`.

**Verifier notes.** 4/4 verdicts confirmed, all high. Both verifiers reject the rootDir alternative from the reviewers' suggested fix as harmful.

## HOA-05: No liveness detection: hung handshakes, half-open and silent sockets go unnoticed while health stays green

- **Severity:** high
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/websocket.ts:51`
  - `services/hoarder/src/websocket.ts:58`
  - `services/hoarder/src/websocket.ts:64-65`
  - `services/hoarder/src/websocket.ts:147-150`
  - `services/hoarder/src/messages.ts:23`
  - `shared/utils/src/services.ts:85-92`

**Problem.** `new WebSocket(endpoint.url)` sets no handshakeTimeout, so an upgrade that never completes stays CONNECTING forever with no reconnect. startHeartbeat pings every 30 s but never checks for a pong (the 'pong' handler only logs at debug), and nothing calls `ws.terminate()`. A half-open TCP connection is noticed only when kernel retransmission gives up (about 15 min); a peer that keeps answering at TCP level but sends no data is never detected. `lastMessageTime` is written on every frame but never read. Health is one global `lastMessageAt`, so one live venue keeps /health at 200 while another is dead, and plain Docker does not restart unhealthy containers anyway.

**Evidence.** Repro scratch/f7v2/repro.mts: real connect() against a local server with autoPong:false, heartbeat shortened to 100 ms: after 3 s `{"pingsSeen":29,"readyState":1,"closed":false,"reconnects":0}`. grep: `lastMessageTime` only written (websocket.ts:58, messages.ts:23). services.ts:88 `healthy = lastMessageAt === null || ...`.

**Fix.** Now, all inside doConnect so state is per socket: (1) `new WebSocket(endpoint.url, { handshakeTimeout: 10_000 })`; on timeout ws emits error+close and the existing reconnect runs. (2) Pong deadline: `awaitingPong` flag; each tick, skip if not OPEN or `ws.isPaused` (a paused socket reads no pongs, see HOA-18); if still awaiting, log warn and `ws.terminate()` (close -> reconnect -> resubscribe); else set the flag and ping. Clear it on 'pong' and on any inbound frame; reset on resume. (3) Remove the unused `lastMessageTime` (service.ts, types.ts, messages.ts:23, websocket.ts:58) or turn it into the per-socket last-frame time used below. Deferred to the owner: a per-venue silence deadline (optional `staleAfterMs` on the venue/endpoint, short for Kraken's 1 s heartbeat, ~2-3 min default, none for legitimately quiet channels) and per-venue staleness in the health response (needs a custom onHealthCheck or a shared/utils change).

**Tests to add.** websocket.test.ts with fake timers (mock needs `terminate` and `isPaused`): constructor receives handshakeTimeout; two intervals with no pong -> terminate once; pong between ticks -> no terminate; isPaused -> no ping and no terminate; after terminate, 'close' schedules exactly one reconnect. If the silence deadline is adopted: no 'message' for longer than staleAfterMs -> terminate.

**Verifier notes.** 4/4 confirmed. Severity: medium (reviewer A, 1st verifier A), high (reviewer B, both verifiers B). Chose high: unbounded loss on a silent socket is plausible (NAT/LB idle timeouts). First verifier B splits the per-venue thresholds and health reporting into an owner decision; one verifier advised against a generic idle timeout because quiet channels exist.

**Owner question.** Should hoarder adopt per-venue silence deadlines (and what values), and should /health report unhealthy when any configured venue is stale rather than only when all are? The latter touches shared/utils/src/services.ts used by other services.

## HOA-06: 'Channel closed' is rethrown from a floating promise: any RabbitMQ loss, and a normal SIGTERM, crash the process with an unhandled rejection

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/messages.ts:47-49`
  - `services/hoarder/src/websocket.ts:66`
  - `services/hoarder/src/types.ts:37`
  - `services/hoarder/tests/messages.test.ts:235-242`
  - `packages/rabbitmq/src/broker.ts:365-386`
  - `packages/service-kit/src/providers/queue/rabbitmq.ts:21`

**Problem.** The message handler is async but typed `(msg, venue) => void`; websocket.ts:66 drops its promise. The handler rethrows `Channel closed` 'so the broker can recover', but nothing catches it: no unhandledRejection handler exists in hoarder, service-kit, rabbitmq or shared/utils, so on Node 22 the process exits with code 1. Hoarder's broker is built `managed: true, retries: 0`, so on any channel or connection loss handleDisconnect takes the else branch: exchanges keep the stale closed channel, publish hits amqplib's `invalidOp('Channel closed')`, and the process crashes. During SIGTERM, disconnectAll closes the channel while sockets keep delivering (HOA-07), so a normal deploy often ends with exit 1 and a stack trace. Nothing listens for 'disconnect' or calls the provider's reconnect(), so the crash plus container restart is in fact the only recovery today.

**Evidence.** Repro: an async EventEmitter listener that throws 'Channel closed' exits with code 1 on Node v22. broker.ts:371 nulls exchange channels only when `!this.connectionOptions.managed`; service-kit rabbitmq.ts:21 constructs `new Broker(spec.url, { retries: 0, managed: true })`. amqplib channel.js:155-156.

**Fix.** Make the restart explicit and bounded. (1) types.ts: `MessageHandler = (msg: Buffer, venue: string) => Promise<void>`. (2) websocket.ts:66: `ws.on('message', (msg: Buffer) => { onMessage(msg, venue).catch(err => logger.error({ err, venue }, 'relay failed')); })`. (3) messages.ts: replace the rethrow. If the error is amqplib's IllegalOperationError ('Channel closed'/'Channel closing') and isShuttingDown is false, log once at error and call `service.shutdown('RABBITMQ_LOST')`, guarded by a module flag; while shutting down, drop silently (optionally counted). Do not just delete the rethrow: with no reconnect the service would then log errors forever and publish nothing. (4) Fix the docblock and test name to say a lost broker channel ends the process and the container restart reconnects.

**Tests to add.** messages.test.ts (replace 235-242): a publish rejecting with 'Channel closed' calls service.shutdown exactly once across several frames and the handler resolves; with isShuttingDown=true no shutdown call and no error log. websocket.test.ts: a rejecting handler produces no unhandledRejection (vitest fails on them by default).

**Verifier notes.** Lens B F9 confirmed (medium; reviewer said high). Also raised in lens A by F10's evidence and F7's verifier. The first verifier B refuted the 'drop the rethrow' option as harmful; adopted their explicit-shutdown fix over lens A's 'logged drop'.

## HOA-07: Shutdown is not graceful: isShuttingDown is never set and only the first socket of each key is closed

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/service.ts:4-8`
  - `services/hoarder/src/websocket.ts:47`
  - `services/hoarder/src/websocket.ts:105`
  - `services/hoarder/src/pool.ts:45`
  - `services/hoarder/src/pool.ts:66`
  - `packages/service-kit/src/plugins/shutdown.ts:24-35`
  - `services/hoarder/README.md:16`

**Problem.** Nothing in production sets `isShuttingDown` (only tests), so the guards in websocket.ts never fire. pool.ts:66 `service.on('shutdown', () => ws.close())` captures the socket from the first connect; after a reconnect it closes an already-dead socket and the live one stays open. Each close schedules a reconnect 200 ms later (mostly beaten by process.exit). The shutdown plugin runs all listeners concurrently with the providers' disconnect, so live sockets keep delivering into a closed channel (crash: HOA-06). The `null!` returns in doConnect and getOrConnect hide a real nullable that would crash `waitForOpen(null)` if the flag were set. README:16 claims graceful shutdown.

**Evidence.** grep isShuttingDown: initial false (service.ts:6), reads at websocket.ts:47 and :105, test overrides only. pool.ts:49-66 `const ws = connect(...)` ... `service.on('shutdown', () => ws.close())`.

**Fix.** In pool.ts register one shutdown listener at module level (or lazily once): `service.setState('isShuttingDown', true); for (const e of pool.values()) { e.ws?.pause(); e.ws?.terminate(); }` and clear pending reconnect timers (connect() returns or registers a cancel/close handle). Delete pool.ts:66. Listeners run in the same tick, so the synchronous close lands before any AMQP round trip completes; do not promise a drain beyond that without a service-kit change. Type PoolEntry.ws as `WebSocket | null`, make doConnect return null honestly and have subscribe() throw a clear error on null. messages.ts ignores channel errors while shutting down (HOA-06). Rewrite README:16 to what shutdown does.

**Tests to add.** After onReconnect swaps entry.ws, emitting 'shutdown' terminates the current socket; a 'close' after shutdown schedules no reconnect (fake timers); an index-level test drives the real service-kit shutdown path.

**Verifier notes.** Both lenses (A-F10, B-F10), 2/2 confirmed medium. Verifiers note the stray reconnect is minor; the real harm is the interplay with HOA-06.

## HOA-08: On OKX and Kraken one error frame fails every concurrent subscription on the socket; the docblocks claiming nothing else is in flight are false

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/venues/okx.ts:27-36`
  - `services/hoarder/src/venues/kraken.ts:30-44`
  - `services/hoarder/src/index.ts:22-26`
  - `services/hoarder/src/subscriptions.ts`

**Problem.** index.ts subscribes every channel concurrently with Promise.all, and getOrConnect creates the entry synchronously, so all of a venue's channels wait for acks on one socket at once. OKX matchAck returns 'failed' for any `event:'error'`, Kraken for any `method:'subscribe', success:false`, whatever the channel. One bad channel or transient error rejects every waiter; none is tracked, although the venue accepted the good ones, which stream until the next reconnect and then stop (HOA-03). The docblocks' 'nothing else is in flight on the socket at that moment' is false.

**Evidence.** okx.matchAck({event:'error',code:'60018'}, c) for three different channels -> ['failed','failed','failed']; kraken.matchAck({method:'subscribe',success:false,symbol:'FOO/USD'}, c) for trade:BTC/USD and book:BTC/USD -> ['failed','failed'].

**Fix.** Serialise subscribe acks per pool entry: add `subscribeChain: Promise<void>` (or a queue) to PoolEntry and chain each channel's send-and-wait so only one ack is pending per socket; start each channel's 5 s deadline when its turn begins, not when queued. The reconnect resubscribe (HOA-01/09) uses the same queue, which also spaces frames for Binance (HOA-19). The docblocks then become true. Alternative correlation (Kraken integer `req_id` per request; OKX client `id`) is possible but OKX's echo should be checked against the live endpoint first. Optionally match Kraken failures on the top-level `symbol` when present.

**Tests to add.** Two concurrent subscribes on one mocked OKX socket: an `{event:'error'}` frame rejects only the in-flight one and the other resolves on its own ack. Each channel's deadline starts when it is sent.

**Verifier notes.** Both lenses (A-F4 high->medium, B-F3 medium), 2/2 confirmed medium. Damage shrinks to misreporting once HOA-03's desired-set fix lands.

## HOA-09: The reconnect resubscribe is fire-and-forget: rejected resubscriptions are logged at debug only

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/pool.ts:58-61`
  - `services/hoarder/src/messages.ts:34-35`
  - `services/hoarder/src/messages.ts:56-58`
  - `services/hoarder/src/venues/types.ts:46`

**Problem.** On reconnect the subscribe frame is sent with no ack wait. The venue's answer goes through the relay, isData() is false, and logControlFrame logs at debug whenever describeControl recognises it, which every venue does for rejections (OKX `error 60018`, Bybit `success=false`, Kraken `error:`, Binance `error`). A rejected resubscription (rate limit, temporarily unknown instrument) leaves a connected, empty socket with nothing at info or above, and the channel stays 'tracked'. A single-venue outage does not trip the global health check.

**Evidence.** scratch/f12/f12.test.ts feeds real rejection frames from all four venues into createMessageHandler with a spied logger: 5/5 hit logger.debug and never warn or error.

**Fix.** Run the reconnect resubscribe through the per-channel, sequential, ack-checked helper from HOA-01 on the new socket's 'open'; on failure or timeout log at error with venue/socket/channel and retry with capped backoff (1 s doubling to 60 s), dropping retries for a socket that is no longer `pool.get(key).ws`. In logControlFrame, log failed acks at warn: either `describeControl` returns `{ text, level }` or the Venue gains `isFailure?(frame)`.

**Tests to add.** A twin-venue reconnect whose ack is a rejection calls logger.error and schedules a retry; messages.test.ts: a rejection frame from each venue is logged at warn, not debug.

**Verifier notes.** Lens A F12 only; 2/2 confirmed. Severity high (1st, which folded in the Kraken bug) vs medium (2nd). The Kraken part is HOA-01, so this item stays medium. Share the implementation with HOA-01/03/08.

## HOA-10: A late 'close' after 'error' opens a second replacement socket: two live sockets, every frame published twice

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/websocket.ts:27-29`
  - `services/hoarder/src/websocket.ts:68-93`
  - `services/hoarder/src/websocket.ts:103-119`
  - `services/hoarder/src/pool.ts:51-63`

**Problem.** 'error' and 'close' both call the shared scheduleReconnect, whose single-flight guard holds only while the timer is pending. On a receiver-level error on an open socket (invalid opcode, invalid UTF-8, oversize payload) ws starts a closing handshake and emits 'close' only when the peer closes TCP or after 30 s. If that exceeds the 200 ms delay, socket #2 is created, then the late close creates #3. The pool points at #3; #2 stays subscribed, publishes every frame again, is invisible to pause/resume and is never closed. The docblock 'only one reconnect attempt is ever in flight' is false. Network errors (ECONNRESET) and handshake failures do not trigger it, so the trigger is narrow, but the duplication is permanent.

**Evidence.** scratch/hoarder/race.test.ts (local ws server, invalid-opcode frame, TCP close 1 s later): `server connections ever: 3 still open on server: 2,3`, `client sockets OPEN: 2 of 3`. scratch/hoarder-tests/repro.test.ts with the ws mock: onReconnect called 2 times.

**Fix.** In websocket.ts keep a per-connection `current` socket (or generation counter). Schedule a reconnect only from 'close', only if `ws === current` and a per-socket `reconnected` flag is unset. In 'error', log, apply the rate-limit cap, and `ws.terminate()` when OPEN or CLOSING so 'close' follows immediately. Before creating a replacement, terminate the previous socket if not CLOSED. Fix the docblock. Shutdown closing the current socket is HOA-07.

**Tests to add.** ws mock: open, error, advance 200 ms, emit 'close' on the original, advance 1 s -> onReconnect called exactly once. Optionally the local-server repro: exactly one client socket OPEN after 2.5 s.

**Verifier notes.** Both lenses (A-F5 high->medium, B-F5 medium), 2/2 confirmed medium.

## HOA-11: Backoff resets on every 'open': an accept-then-close venue causes a reconnect storm; 418 is not treated as a rate limit

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/websocket.ts:55-62`
  - `services/hoarder/src/websocket.ts:78-80`
  - `services/hoarder/src/websocket.ts:144-145`

**Problem.** `reconnect.delayMs = RECONNECT_DELAY_MS` runs in the 'open' handler, so a venue that completes the handshake and then closes (Binance 1008 policy close, which binance.ts:66-70 itself records; OKX maintenance; a rejected resubscribe) keeps the loop at the 200 ms floor forever, about 2-5 connects/s. docs/venues/OKX.md:1140 records 3 connection requests/s per IP. isRateLimited matches only 429; HTTP 418 ramps normally to the 15 s cap. Retry-After is ignored. (The 418 ladder in BINANCE.md is documented for REST; treating it like 429 on the WS handshake is cheap but not evidenced.)

**Evidence.** scratch/hoarder-tests/repro.test.ts: 10 cycles of open -> close(1008) -> advance 200 ms => 11 sockets in about 2 s.

**Fix.** Stop resetting on 'open': start a stability timer on open (`setTimeout(() => { reconnect.delayMs = RECONNECT_DELAY_MS }, 30_000)`) cleared on 'close', or reset on the first data frame. Add jitter (e.g. +-20% or `delay * (0.5 + Math.random())`, capped). Extend isRateLimited to `/Unexpected server response: (418|429)\b/`. Optional: read `retry-after` via the 'unexpected-response' event (then ws no longer emits the error itself, so abort and schedule by hand).

**Tests to add.** Fake timers: repeated open->close(1008) doubles the delay up to the cap; open for 30 s then close -> 200 ms; 'Unexpected server response: 418' schedules at MAX_RECONNECT_DELAY_MS.

**Verifier notes.** Both lenses (A-F8, B-F6), 2/2 confirmed medium.

## HOA-12: README and docblocks describe behaviour the code does not have

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/README.md:3`
  - `services/hoarder/README.md:12`
  - `services/hoarder/README.md:14-16`
  - `services/hoarder/README.md:22`
  - `services/hoarder/README.md:33`
  - `services/hoarder/src/messages.ts:5-9`
  - `services/hoarder/src/subscriptions.ts:11-15`
  - `services/hoarder/src/websocket.ts:27-29`
  - `services/hoarder/src/venues/okx.ts:27-32`
  - `services/hoarder/src/venues/kraken.ts:30-34`
  - `services/hoarder/tests/venues-protocols.test.ts:4-8`
  - `docs/DATA_PIPELINE.md:60-61`

**Problem.** False today: 'verbatim'/'byte-faithful'/'published exactly as received' (HOA-02; also DATA_PIPELINE.md:60-61); 'resubscription of tracked channels' (HOA-01, HOA-03); 'a paused publisher pauses every socket' (HOA-18); 'graceful shutdown' (HOA-07); okx/kraken 'nothing else is in flight on the socket' (HOA-08); subscriptions.ts 'Called only at startup and on reconnect' (reconnect never calls subscribe()); websocket.ts 'only one reconnect attempt is ever in flight' (HOA-10); README:33 and the test docblock call the fixtures 'those captures' although they are hand-trimmed (`conn_id: 'd8bu…'`).

**Evidence.** Quoted lines at the cited locations; pool.ts:59-61 is the reconnect path that bypasses subscribe().

**Fix.** Write the docs last, after the code fixes, stating only current behaviour (CLAUDE.md 'Only what is true today'); where a fix is deferred, state the limitation plainly. With HOA-02 fixed 'verbatim' stays and becomes true; otherwise say 're-serialised from the parsed frame'. subscriptions.ts: describe what it does after HOA-01/03 (e.g. 'Subscribe one channel, opening its socket if needed'). okx/kraken: true once HOA-08 serialises acks, otherwise say an uncorrelated error fails every pending subscription. websocket.ts: describe the guard that exists. README:33 and the test docblock: 'trimmed from frames captured against the live endpoints'. README:15-16 after HOA-07/HOA-18. Also fix docs/DATA_PIPELINE.md:60-61.

**Tests to add.** None (docs).

**Verifier notes.** Lens A F18 and lens B F13, all confirmed medium. The user asked for a documentation fresh start, so this is in scope now.

## HOA-13: Binance futures text in binance.ts and the README omits the working /public/ws path, carries a plan, and puts a venue quirk in a service doc

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/venues/binance.ts:20-23`
  - `services/hoarder/README.md:35-40`
  - `docs/venues/BINANCE.md:570-573`

**Problem.** binance.ts and README:40 say futures 'accepts a subscribe and then delivers nothing from our network, on both the /ws and combined-stream paths ... Add it once it can be verified'. docs/venues/BINANCE.md:570-573 records that `wss://fstream.binance.com/public/ws` streams and that /ws and /stream acknowledge but send nothing, i.e. the hoarder text tested the wrong paths. A reader following binance.ts concludes futures cannot be streamed. It states a plan (forbidden in tech docs) and explains venue endpoint behaviour, which belongs only in docs/venues/BINANCE.md (dependency direction).

**Evidence.** binance.ts:20-23 and README.md:40 vs BINANCE.md:570 '**The futures endpoint is `wss://fstream.binance.com/public/ws`, and a wrong path fails silently.**'

**Fix.** Delete binance.ts:20-23 and README.md:40; state hoarder's own fact on its own terms ('Spot only (`wss://stream.binance.com:9443/ws`); Binance futures is not collected') with a pointer to docs/venues/BINANCE.md#websocket. Move protocol traps (Binance not validating subscriptions, acks without the channel name) to the venue docs, keeping in the README only how hoarder correlates acks. No statement about future support. Out of scope, noted: BINANCE.md:568 frames the venue doc around a would-be collector.

**Tests to add.** None (docs).

**Verifier notes.** Lens B F12 confirmed medium; lens A F18 verifier says it is not a direct factual contradiction (BINANCE.md also says /ws delivers nothing) but misleading framing plus misplaced venue facts. Either way the fix is the same.

## HOA-14: Reconnect/resubscribe and failure paths have no tests, and the coverage gate fails

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/tests/pool.test.ts:140-190`
  - `services/hoarder/tests/websocket.test.ts:190-280`
  - `services/hoarder/tests/messages.test.ts:86-97`
  - `services/hoarder/tests/websocket.test.ts:128-136`
  - `services/hoarder/src/pool.ts:43`
  - `services/hoarder/src/pool.ts:52-60`
  - `services/hoarder/src/subscriptions.ts:32`
  - `services/hoarder/src/subscriptions.ts:39`
  - `services/hoarder/src/subscriptions.ts:53-73`
  - `services/hoarder/src/config.ts:13-49`
  - `services/hoarder/src/websocket.ts:134-149`
  - `services/hoarder/src/index.ts:9-27`
  - `vitest.config.ts:17-22`

**Problem.** `npx vitest run --coverage` gives 75.44% lines and 58.28% branches, below the 60% branch threshold, so `pnpm test:coverage` fails (no CI enforces it). The uncovered code is the risky code: onReconnect resubscribe (why HOA-01 went unnoticed), getOrConnect, waitForOpen timeout/error, config.ts (0%, `_test_*` exports with no tests), describeError branches; index.ts is excluded and untested. The 'verbatim' test compares parsed objects (HOA-02); the ping test asserts the duplicate manual pong (HOA-19); tests set `isShuttingDown` by hand, hiding HOA-07.

**Evidence.** Coverage run, report in scratch/cov-hoarder2: 'ERROR: Coverage for branches (58.28%) does not meet global threshold (60%)'. `grep -n getOrConnect tests/` -> only a module mock.

**Fix.** Add the tests listed per item (HOA-01, 03, 05, 07, 10, 11, 18) plus: pool.test.ts — untracked key is a no-op, getOrConnect throws `Venue 'x' has no endpoint 'y'`, concurrent getOrConnect share one entry, resubscribe checked with real okx and kraken adapters as well as twin. subscriptions.test.ts — rejects (httpStatus 503) when the socket errors before open and when open exceeds the deadline. config.test.ts — config.ts loads at import, so set process.env and use `vi.resetModules()` + dynamic import: empty HOARDER_VENUES -> all; ' OKX ,binance,okx' -> ['okx','binance']; unknown name throws; missing QUEUE_URL throws 'QUEUE_URL is required'. websocket.test.ts — describeError for ECONNRESET, 'Unexpected server response: 503', 'socket hang up' (warn not error). Optionally extract index.ts's backpressure callback into a testable function.

**Tests to add.** As described in fix.

**Verifier notes.** Lens A F19 (low) and lens B F17 (medium), confirmed. Merged at medium because the reconnect path is the core reliability feature.

## HOA-15: Binance data frames without an `e` field (bookTicker, partial depth, array streams) would be dropped and warn-logged per frame

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/venues/binance.ts:48-49`
  - `services/hoarder/src/messages.ts:34-35`
  - `services/hoarder/src/messages.ts:60`
  - `docs/venues/BINANCE.md:589`

**Problem.** `isData: (frame) => typeof frame.e === 'string'`. Spot `<symbol>@bookTicker`, partial-depth `@depth5/10/20` (`{lastUpdateId,bids,asks}`) and array streams (`!miniTicker@arr`) carry no top-level `e`. describeControl returns null for them, so every frame is discarded and logged at warn ('Unrecognized message received') at the stream's rate. Latent: none of the 4 current channels is affected, but channels.ts calls the list provisional and book feeds are the likely additions.

**Evidence.** BINANCE.md:589 bookTicker capture `{"u":97856816298,"s":"BTCUSDT","b":"64511.88",...}` has no `e`.

**Fix.** Classify by exclusion: `isData: (f) => { if (Array.isArray(f)) return true; if (typeof f !== 'object' || f === null) return false; const o = f as Record<string, unknown>; if ('error' in o) return false; if ('id' in o && 'result' in o) return false; return true; }` (any frame with `error` is control even without `id`, so errors never enter the archive). Update the docblock at line 48.

**Tests to add.** venues-protocols.test.ts: bookTicker (from BINANCE.md:589), a depth20 frame and an array frame -> data; ack `{result:null,id:'x'}` and error `{error:{code:2,msg:'...'},id:'x'}` -> control.

**Verifier notes.** Lens A F13, 1/1 confirmed medium; verifier refined the rule to treat any `error` frame as control.

## HOA-16: Tests are never type-checked and contain type errors and stale fixtures

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/tsconfig.json:7`
  - `services/hoarder/tests/websocket.test.ts:3`
  - `services/hoarder/tests/websocket.test.ts:32-45`
  - `services/hoarder/tests/websocket.test.ts:58`
  - `services/hoarder/tests/messages.test.ts:28-29`

**Problem.** tsconfig includes only src/**, and vitest strips types, so tests never pass through tsc. They contain real errors: a State fixture with `realtime`, `platform`, `apiVersion` (from an older service shape), an unused `ws` helper that indexes State with an invalid key, an unused `Config` import, and rejected direct casts. Stale fixtures give false confidence.

**Evidence.** Scratch tsconfig extending hoarder's and including tests/ (scratch/tsconfig.hoarder-tests.json): TS2353 websocket.test.ts:34, TS6133 and TS7053 :58, TS6196 :3, TS2352 messages.test.ts:28-29 and websocket.test.ts:44-45.

**Fix.** Add services/hoarder/tsconfig.test.json: `{ "extends": "./tsconfig.json", "compilerOptions": { "noEmit": true, "composite": false, "incremental": false, "declaration": false, "declarationMap": false }, "include": ["src/**/*", "tests/**/*"] }` and a `"typecheck": "tsc -p tsconfig.test.json"` script (tests import from 'vitest' explicitly, so no globals types). Drop realtime/platform/apiVersion from makeService, delete the `ws` helper and unused import, cast via `unknown`. Repo-wide follow-up for other services.

**Tests to add.** `pnpm --filter hoarder typecheck` passes.

**Verifier notes.** Lens B F18, 1/1 confirmed (verifier: medium-low, maintainability).

## HOA-17: Frames are published to an exchange with no bound queue, no mandatory flag and no publisher confirms, so they are discarded until a consumer binds

- **Severity:** medium
- **Category:** robustness
- **Decision:** DEFER
- **Locations:**
  - `services/hoarder/src/service.ts:12`
  - `services/hoarder/src/messages.ts:37-44`
  - `packages/rabbitmq/src/recovery.ts:40`
  - `packages/rabbitmq/src/types.ts:31-54`

**Problem.** The topology declares only `exchanges: { hoarder: { type: 'topic' } }`; no queue, publishes not mandatory, plain (non-confirm) channel. With no bound queue RabbitMQ discards every frame, and `await publish()` does not prove the broker accepted it. No code outside hoarder references the exchange today; WS collection is parked with no consumer.

**Evidence.** service.ts:12; recovery.ts:40 `createChannel`; no createConfirmChannel or mandatory in packages/rabbitmq (grep).

**Fix.** When the consumer is designed: either declare a capped durable queue under the exchange, `exchanges: { hoarder: { type: 'topic', queues: { 'hoarder.raw': { durable: true, routingKey: '#', arguments: { 'x-max-length-bytes': <cap>, 'x-overflow': 'reject-publish' } } } } }` (QueueSpec uses `routingKey`, not `bindings` as the reviewer wrote), or let the consumer own its queue and document that frames are dropped until it binds. Document in the README's envelope section where frames go. Confirms or mandatory+return logging need an API addition in packages/rabbitmq (separate repo).

**Tests to add.** Topology test for whichever queue is declared.

**Verifier notes.** Lens B F16, confirmed medium, defer. An uncapped durable `#` queue with no consumer would fill the broker disk, worse than dropping.

**Owner question.** Who owns durability of hoarder's output: should hoarder declare its own capped durable queue (what cap and overflow policy), or should the future consumer own its queue with frames dropped until it binds? Are publisher confirms wanted in packages/rabbitmq?

## HOA-18: Backpressure misses sockets that are connecting or reconnecting while paused, and a long pause gets sockets dropped by the venue

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/pool.ts:51-55`
  - `services/hoarder/src/pool.ts:75-85`
  - `services/hoarder/src/index.ts:13-16`
  - `services/hoarder/README.md:15`

**Problem.** pauseAll/resumeAll act only on sockets OPEN at the moment of the call (ws.pause() is a no-op while CONNECTING) and no paused state is kept. A socket that opens or is created by a reconnect during a pause streams unpaused, contrary to README:15. A paused socket reads no control frames, so venue pings go unanswered; Binance drops it after about a minute, and the replacement is unpaused.

**Evidence.** pool.ts:77 `if (ws?.readyState === WebSocket.OPEN) ws.pause();`; pool.ts:55 `e.ws = newWs;` with no pause check; pool.test.ts:166 'skips connections that are not open'.

**Fix.** Module-level `let paused = false` in pool.ts, set by pauseAll/resumeAll. In getOrConnect and onReconnect register `ws.once('open', () => { if (paused) ws.pause(); })` before the resubscribe listener (the subscribe still goes out; reads stop). resumeAll resumes every entry where `ws.isPaused`. Record when a pause started and warn past ~30 s. If an in-flight limit is ever added, combine reasons (`drainPaused || inFlightOverLimit`). HOA-05's pong check must skip paused sockets.

**Tests to add.** pauseAll while a socket is CONNECTING, then 'open' -> pause called; reconnect during pause -> new socket paused on open; resumeAll resumes it.

**Verifier notes.** Both lenses (A-F6 high->medium, B-F11 medium->low), confirmed. Chose low per B's reasoning: drain backpressure normally lasts milliseconds to seconds, and an extra unpaused socket adds load but does not lose data.

## HOA-19: Two pongs per server ping, and an unthrottled SUBSCRIBE burst against Binance's per-connection message limit

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/websocket.ts:64`
  - `services/hoarder/src/index.ts:22-26`
  - `services/hoarder/src/subscriptions.ts:41`
  - `services/hoarder/src/venues/channels.ts:117-122`
  - `services/hoarder/tests/websocket.test.ts:128-136`

**Problem.** ws 8.22 auto-pongs every ping with its payload (autoPong: true), and `ws.on('ping', () => ws.pong())` sends a second, empty pong. At startup all of a venue's SUBSCRIBE frames go out in one tick on one socket. Binance counts subscribes, pings and pongs toward 5 incoming messages/s per connection (per Binance's public docs, not recorded in BINANCE.md) and disconnects violators; 4 channels today stay under it, so this is latent until the placeholder list grows, and then the disconnect feeds HOA-03.

**Evidence.** node_modules/ws/lib/websocket.js:683 `autoPong: true` and :1265 `if (websocket._autoPong) websocket.pong(data, ...)`; hoarder websocket.ts:64.

**Fix.** Delete websocket.ts:64 and replace the 'responds to ping with pong' test with one asserting no manual pong (`ws.listenerCount('ping') === 0` or pong not called). Pacing comes from HOA-08's per-socket serialisation; if a hard rate is needed, add optional `maxControlPerSecond` on Venue (Binance 4) with a per-entry token bucket, starting each ack deadline at actual send time. Batching Binance channels into one SUBSCRIBE would need ack-model changes, so prefer the throttle.

**Tests to add.** No manual ping listener remains; with maxControlPerSecond=4 and fake timers, 10 subscribes send at most 4 frames in any 1 s window and all resolve.

**Verifier notes.** Lens A F14 (medium) and lens B F21 (low), confirmed. Chose low: the double pong is cheap to remove and the limit is not reached with today's channels.

## HOA-20: channels.ts docblock carries history and plans and points to a Kraken venue doc that does not exist

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/venues/channels.ts:4-7`
  - `services/hoarder/src/venues/channels.ts:12-17`

**Problem.** 'The lists below are provisional. They were written before the venues were surveyed ... book feeds ... that this service cannot yet take' is history plus a plan (CLAUDE.md forbids both in tech docs; plans go in docs/planning/). It points to 'the WebSocket section of each venue doc under docs/venues/', but there is no KRAKEN.md. The parked status already has its home in docs/DATA_PIPELINE.md:63-65 and docs/ROADMAP.md:122.

**Evidence.** `ls docs/venues` -> BINANCE BITGET-SEED BITGET BYBIT GATE HTX KUCOIN OKX.

**Fix.** Replace lines 12-17 with a present-tense statement (e.g. 'Two symbols per venue. Book channels are diff streams, archived without snapshots; for what each venue streams, see the WebSocket section of its doc under docs/venues/ where one exists.') or drop it and leave the parked status to DATA_PIPELINE.md. Move any provisional note to docs/planning/. Do not write KRAKEN.md as part of this fix unless someone surveys the venue.

**Tests to add.** None (docs).

**Verifier notes.** Lens A F18 (part) and lens B F14, confirmed low.

## HOA-21: config.rabbitmqUrl is sanitised but unused, and sanitizeUrl/redactUrl log the full credentialed URL on failure

- **Severity:** low
- **Category:** security
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/config.ts:16`
  - `services/hoarder/src/config.ts:22-28`
  - `shared/utils/src/services.ts:41`
  - `shared/utils/src/security.ts:17`
  - `shared/utils/src/security.ts:32-33`

**Problem.** config.ts computes `sanitizeUrl(process.env.QUEUE_URL)`, used only for an emptiness check and a redacted log; SKFactory connects with raw `process.env.QUEUE_URL`, so the sanitising has no effect. With a password containing `%zz`, `decodeURIComponent` throws and the catch logs `{ error, url }` with the password; redactUrl does the same on failure. pipe and router also use sanitizeUrl.

**Evidence.** Reproduced the leak with 'amqp://u:p%zz@h:5672'. config.ts:16 vs services.ts:41.

**Fix.** Either drop `rabbitmqUrl` from Config/types and validate QUEUE_URL directly, or let SKFactory accept an explicit `rabbitmq: { url }` overriding the env and pass config.rabbitmqUrl. In shared/utils/src/security.ts, change both catch blocks to log without the URL (error only, or a regex-parsed host).

**Tests to add.** A config test asserting the warn call never contains the password for 'amqp://u:p%zz@h:5672'; if threaded through, a services test that the provider url equals the passed value.

**Verifier notes.** Lens A F17, 1/1 confirmed low. Whether amqplib then fails with the raw URL is unverified and irrelevant to the fix.

## HOA-22: Weak, tautological and stale tests

- **Severity:** low
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/tests/venues-protocols.test.ts:171-178`
  - `services/hoarder/tests/venues.test.ts:16-29`
  - `services/hoarder/tests/websocket.test.ts:66-73`
  - `services/hoarder/tests/pool.test.ts:45`
  - `services/hoarder/tests/websocket.test.ts:151`
  - `services/hoarder/tests/messages.test.ts:131-132`

**Problem.** 'produces a JSON subscribe frame referencing the channel' only checks the frame parses. The typeof-surface test duplicates the Venue type. A URL test is named for credentials that no longer exist and duplicates the next test. Comments call venues 'exchange' against the README vocabulary rule. messages.test.ts:131-132 records history.

**Evidence.** venues-protocols.test.ts: `expect(() => JSON.parse(frame)).not.toThrow()`. (Reviewer cited lines 236-247; the file has 191 lines; the test is at 171-178.)

**Fix.** Assert each venue's parsed frame contains the channel's identifiers via a per-venue expectation table (binance stream name in params, bybit topic in args, okx {channel,instId}, kraken channel+symbol), plus a multi-channel case if the array contract stays. Delete venues.test.ts:16-29 and websocket.test.ts:66-73. Reword pool.test.ts:45 and websocket.test.ts:151 to 'venue'. Replace messages.test.ts:131-132 with 'The envelope is exactly these three headers.'

**Tests to add.** As described in fix.

**Verifier notes.** Lens B F19, confirmed low; location corrected by verifier.

## HOA-23: Dead code and unused state

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/hoarder/src/pool.ts:21-23`
  - `services/hoarder/src/pool.ts:88-89`
  - `services/hoarder/src/config.ts:48-49`
  - `services/hoarder/src/types.ts:14-18`
  - `services/hoarder/src/service.ts:4-8`
  - `services/hoarder/src/messages.ts:23`
  - `services/hoarder/src/websocket.ts:58`

**Problem.** knip: unused exports `get`, `remove`, `_test_reset` (pool.ts), `_test_loadConfig`, `_test_parseVenues` (config.ts); `set` only used by tests. State fields `broker` and `lastMessageTime` are never read, while `lastMessageTime` is written per frame on the hot path.

**Evidence.** `npx knip --workspace services/hoarder` -> 5 unused exports; grep confirms no reads.

**Fix.** Delete pool.ts get, remove and _test_reset. Use `_test_parseVenues` in HOA-14's config tests or delete the `_test_` exports if tests use env + re-import. Remove `broker` and `lastMessageTime` from State, the initial state, the two setState calls and the tests asserting them (messages.test.ts:155-163, websocket.test.ts:110-119), unless HOA-05 repurposes lastMessageTime. Leave `setMaxListeners(0)` (concurrent subscribes add listeners) unless replaced with a documented bound. unsubscribeFrame is HOA-26.

**Tests to add.** Existing suite passes; knip reports no unused exports for hoarder.

**Verifier notes.** Lens B F20, confirmed low; verifier split out unsubscribeFrame as an owner call and argued to keep setMaxListeners(0).

## HOA-24: Envelope has no connection epoch, so reconnect gaps are invisible; HOARDER_REPLICAS duplicates every stream

- **Severity:** low
- **Category:** correctness
- **Decision:** DEFER
- **Locations:**
  - `services/hoarder/src/messages.ts:38-43`
  - `services/hoarder/src/websocket.ts:111-116`
  - `services/hoarder/docker/compose.yml:5`
  - `services/hoarder/README.md:66`

**Problem.** Headers are x-venue, x-hoarder-uuid (one per process) and x-collected-at; a reconnect leaves no trace. Book streams carry their own continuity markers (Binance U/u, OKX seqId, Bybit/Kraken snapshots on resubscribe), but trade streams with non-contiguous ids (Bybit `i`, OKX tradeId) cannot distinguish a gap from a quiet market. compose `scale: ${HOARDER_REPLICAS:-1}` runs identical replicas with the same HOARDER_VENUES, so N replicas publish every frame N times with no dedup key; README:66 suggests several collectors on one exchange were intended.

**Evidence.** messages.test.ts:133 asserts 'exactly the three envelope headers'; nothing consumes these headers today.

**Fix.** When WS collection is un-parked, decide with the consumer: add `x-connection-id` (UUID per doConnect, passed through onMessage); optionally publish a non-market control message on open/close under a distinct routing key; pick a replica policy (remove `scale:`, document disjoint HOARDER_VENUES, or define per-venue dedup keys).

**Tests to add.** messages.test.ts: header changes per reconnect; update the 'exactly three headers' test.

**Verifier notes.** Lens A F15, confirmed low (reviewer medium), defer: an envelope-contract decision, not a bounded fix.

**Owner question.** What envelope contract should the future normaliser get: a per-socket connection id and/or explicit open/close control messages? And is running several hoarder replicas meant for redundancy (then define dedup keys) or not (then remove `scale:` or require disjoint HOARDER_VENUES)?

## HOA-25: Compose bind-mounts the whole repository read-write into the container in every environment

- **Severity:** low
- **Category:** security
- **Decision:** DEFER
- **Locations:**
  - `services/hoarder/docker/compose.yml:31-32`

**Problem.** `../../../:/live` mounts the monorepo root (including any .env and git metadata) read-write even in prod, where the image runs from /app and never uses /live; only dev.node.Dockerfile uses WORKDIR /live and the pnpm store under /live. A compromised container can read host secrets and write files owned by uid 1000. The same mount is in every service's compose, so it is a repo-wide convention.

**Evidence.** compose.yml:32; prod.node.Dockerfile WORKDIR /app/services/${SERVICE_NAME}; dev.node.Dockerfile:17 WORKDIR /live.

**Fix.** At repo level, move the mount into a dev-only override (per-service compose.dev.yml or one root dev override) applied when APP_ENV=dev. Not `:ro` (dev writes /live/.pnpm-store). Verify with `docker compose config` under both APP_ENV values.

**Tests to add.** `docker compose config` under APP_ENV=prod shows no /live mount; dev entrypoint still starts.

**Verifier notes.** Lens A F16, confirmed low, defer: repo-wide convention; changing hoarder alone would be inconsistent. Same item exists in other units' reports (e.g. CAT-26).

**Owner question.** Adopt a repo-wide dev-only compose override for the /live source mount (and which form: per-service compose.dev.yml or one root override)?

## HOA-26: Venue.unsubscribeFrame is required and implemented four times but never called

- **Severity:** low
- **Category:** code-quality
- **Decision:** DEFER
- **Locations:**
  - `services/hoarder/src/venues/types.ts:25-26`
  - `services/hoarder/src/venues/binance.ts`
  - `services/hoarder/src/venues/bybit.ts`
  - `services/hoarder/src/venues/okx.ts`
  - `services/hoarder/src/venues/kraken.ts`
  - `services/hoarder/tests/twin.ts:24`
  - `services/hoarder/tests/venues.test.ts:25`
  - `services/hoarder/README.md:22`

**Problem.** Every adapter and the twin implement `unsubscribeFrame`, the README mentions 'subscribe/unsubscribe frames', and subscriptions.ts says nothing unsubscribes at runtime; grep finds only definitions and a typeof test.

**Evidence.** `grep -rn unsubscribeFrame services/hoarder/src` -> definitions only.

**Fix.** Either remove it from types.ts, the four adapters, twin.ts, venues.test.ts:25 and README:22 together, or keep it for planned runtime channel changes and, if HOA-01 narrows subscribeFrame to one channel, narrow unsubscribeFrame the same way.

**Tests to add.** Suite passes after removal, or a test exercises the caller if kept.

**Verifier notes.** Raised by lens A F18 and lens B F20; both confirmed it is unused. First verifier B left removal to the owner because more functionality is to be implemented next.

**Owner question.** Will hoarder change channels at runtime (keep unsubscribeFrame, narrowed to one channel), or should it be removed?

## Deferred — decisions needed

- **HOA-05** (No liveness detection: hung handshakes, half-open and silent sockets go unnoticed while health stays green) (implement the bounded part now; this sub-decision is open): Should hoarder adopt per-venue silence deadlines (and what values), and should /health report unhealthy when any configured venue is stale rather than only when all are? The latter touches shared/utils/src/services.ts used by other services.
- **HOA-17** (Frames are published to an exchange with no bound queue, no mandatory flag and no publisher confirms, so they are discarded until a consumer binds): Who owns durability of hoarder's output: should hoarder declare its own capped durable queue (what cap and overflow policy), or should the future consumer own its queue with frames dropped until it binds? Are publisher confirms wanted in packages/rabbitmq?
- **HOA-24** (Envelope has no connection epoch, so reconnect gaps are invisible; HOARDER_REPLICAS duplicates every stream): What envelope contract should the future normaliser get: a per-socket connection id and/or explicit open/close control messages? And is running several hoarder replicas meant for redundancy (then define dedup keys) or not (then remove `scale:` or require disjoint HOARDER_VENUES)?
- **HOA-25** (Compose bind-mounts the whole repository read-write into the container in every environment): Adopt a repo-wide dev-only compose override for the /live source mount (and which form: per-service compose.dev.yml or one root override)?
- **HOA-26** (Venue.unsubscribeFrame is required and implemented four times but never called): Will hoarder change channels at runtime (keep unsubscribeFrame, narrowed to one channel), or should it be removed?

## Rejected

- **No limit on in-flight publishes: a broker channel outage buffers every frame until OOM (lens A F7 / lens B F8)**: Lens A's first verifier confirmed it (medium) assuming broker.ts nulls exchange channels; lens B's verifier refuted it. Code read settles it for refutation: hoarder's broker is created `new Broker(spec.url, { retries: 0, managed: true })` (packages/service-kit/src/providers/queue/rabbitmq.ts:21), and broker.ts handleDisconnect nulls exchange channels only when `!this.connectionOptions.managed`. So publish() never parks on channelReadyPromise; it rejects at once with 'Channel closed', which is the crash in HOA-06. Revisit only if hoarder moves to a non-managed, self-recovering broker (then pause on 'disconnect', resume on 'connect').
