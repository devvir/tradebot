# Review: router-pipe (services/router, services/pipe)

## Overall assessment

The router does not deliver what its docs promise. Several of its documented rule forms lose data deterministically, and after an ordinary broker restart it stops routing while still reporting healthy. Main defects: (1) a destination `queue@exchange` is bound with its own queue name as the routing key, so on topic and direct exchanges every republished message is unroutable, dropped, and the source is still acked. (2) The source is acked before the broker confirms the publish (no confirm channel, no mandatory flag). (3) The consumer runs on a `managed: true` service-kit broker that never reconnects, and it uses raw `channel.consume`, so nothing re-registers it. /health always returns 200. (4) Exchange objects are cached and go stale after the second publisher recovery. Bare-queue targets publish on the consumer channel. (5) The backpressure poller crashes the process (an unhandled rejection) or wedges its gate forever, and its passive checkQueue on the consumer channel kills that channel on a 404. (6) Prefetch is unlimited unless backpressure is on. (7) Rules that share a source queue overwrite each other's binding keys. There is also a cluster of silent topology errors: '#' used as the binding key on direct exchanges (router sources, pipe destinations), first-mention-wins resolution of exchange types, and type 'default' or a source `queue@` accepted by pipe. Pipe exits 0 on any fatal error, so `restart: on-failure` never retries it. The docs (ROUTER.md, both READMEs) contain false claims and examples that drop data or throw, and they break CLAUDE.md rules: plan language, explaining a neighbour or a consumer, and the grammar described in three places. Coverage: backpressure.ts and pipe config/index are untested, and one topology test asserts the binding bug. Restructuring recommendation: (a) stop hand-rolling the consumer on raw amqplib. Either fail fast (exit 1 on consumer disconnect or cancel, and return 503 on health), or consume through Broker/Queue.consume on a non-managed broker with a raw-delivery option. Publish every target through the publisher broker, looking up the exchange per message. (b) Exchange-type and binding-key defaulting is implemented four times (router consumer, router publisher, pipe, and the rabbitmq `[queueName]` fallback). F1, F9 and F10 come from those copies drifting apart. Give it one helper (`resolveExchangeType`, `bindingKeyFor`), one home, and exhaustive tests. Out of scope, for the submodule owners: @devvir/rabbitmq needs confirm-channel support, should reuse Exchange instances in declareTopology, should stop forcing persistent and application/json in republish, and logs the AMQP URL with credentials at debug level (recovery.ts:143). service-kit `shutdown('ERROR')` exits 0, and `ProviderHandler.reconnect` is never called. Already fixed in HEAD and therefore not in this list: the prod Dockerfile path and package.json main (commit 96bb544), and the router compose backpressure env (e8c4612). Note: neither the router nor pipe is wired into an infra stack yet, so these defects are latent until deployment. Router unit tests pass 29/29. The pipe suite cannot run without Docker. Line numbers cited by lens B are partly stale; the locations below use the verifiers' corrected lines where they gave them. Repro scripts are under reviews/2026-11/units/scratch/.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| RTP-01 | critical | correctness | IMPLEMENT | Destination `queue@exchange` is bound with its own queue name as the routing key; republished messages are unroutable and dropped, and the source is still acked |
| RTP-02 | high | robustness | IMPLEMENT | The router consumer never recovers from channel or connection loss or a broker cancel, and /health stays 200, so it silently stops routing for good |
| RTP-03 | high | correctness | DEFER | The source is acked before the broker confirms the republish (no confirm channel, no mandatory flag, publisher never flushed or closed): messages are lost on a broker or connection fault |
| RTP-04 | high | robustness | IMPLEMENT | Backpressure poller: an unhandled rejection crashes the process, the passive checkQueue 404 kills the consumer channel, and one failed poll while paused wedges the gate forever |
| RTP-05 | high | efficiency | IMPLEMENT | Prefetch is unbounded unless backpressure is enabled; after downtime the whole backlog is pulled into router memory (OOM crash loop) |
| RTP-06 | high | robustness | IMPLEMENT | Cached Exchange objects go stale after the second publisher recovery (hot nack loop), and bare-queue targets publish on the consumer channel |
| RTP-07 | high | correctness | IMPLEMENT | Rules sharing a source queue overwrite each other's binding keys, and every destination of the queue receives every message |
| RTP-08 | high | robustness | IMPLEMENT | Pipe exits with code 0 on fatal errors, so `restart: on-failure` never retries it and the bindings are never declared |
| RTP-09 | medium | correctness | IMPLEMENT | Router direct and 'default' source exchanges are bound with '#' by default; on a direct exchange '#' is a literal key, so the queue receives nothing |
| RTP-10 | medium | correctness | IMPLEMENT | Pipe accepts topology that cannot work: a queue in a direct destination is bound with '#', type 'default' reaches assertExchange, and a source `queue@` is silently dropped |
| RTP-11 | medium | correctness | IMPLEMENT | Conflicting or omitted exchange types are resolved silently by the first mention, in both the router and pipe; the documented ROUTER.md:85 example fails with a 406 or self-loops |
| RTP-12 | medium | robustness | IMPLEMENT | Error path: ack/nack on a closed channel causes an unhandled rejection that crashes the process; systemic errors are requeued immediately in a hot loop; partial fan-out duplicates |
| RTP-13 | medium | docs | IMPLEMENT | docs/services/ROUTER.md is false and self-contradictory (syntax, defaults, header merge, ack semantics, health, config table) and has examples that drop data or fail |
| RTP-14 | medium | testing | IMPLEMENT | Router tests: backpressure.ts at 0%, consumer failure paths untested, a pass-through test that cannot detect a hard-coded key, a test that locks in RTP-01, no integration suite |
| RTP-15 | medium | robustness | DEFER | Backpressure keeps up to prefetch deliveries unacked for the whole pause; RabbitMQ 3.12 consumer_timeout (30 min) then closes the consumer channel |
| RTP-16 | medium | robustness | DEFER | No poison-message policy: failures are requeued forever with no retry limit and no dead-lettering |
| RTP-17 | low | correctness | IMPLEMENT | Republish is not property-faithful: it forces persistent, stamps a missing contentType as application/json, lets injected headers override existing ones, and key replace is unanchored and expands $-patterns |
| RTP-18 | low | config | IMPLEMENT | Router config validation gaps: numeric env values unvalidated, watch queues without a max, ignored `(key:)` modifiers, self-loops and duplicate rules accepted |
| RTP-19 | low | docs | IMPLEMENT | Router and pipe READMEs: false claims, failing examples, plan language, neighbour and consumer framing, the grammar triplicated, and a stale .env.testing comment |
| RTP-20 | low | testing | IMPLEMENT | Pipe tests: config.ts and index.ts untested, unit tests need Docker, helpers reimplement the service, no destination-queue cases, invalid PIPE_BINDINGS in .env.testing, the Recovery test checks the rabbitmq package |
| RTP-21 | low | robustness | IMPLEMENT | Pipe only adds bindings: removing or narrowing a rule in PIPE_BINDINGS leaves the old binding active (undocumented) |
| RTP-22 | low | code-quality | IMPLEMENT | Dead code, weak typing and duplicated topology helpers with inconsistent defaults (wrong type shown in the route log) |
| RTP-23 | low | robustness | DEFER | Graceful shutdown neither cancels the raw consumers nor drains in-flight handlers, and never closes the publisher |

## RTP-01 — Destination `queue@exchange` is bound with its own queue name as the routing key; republished messages are unroutable and dropped, and the source is still acked

- **Severity:** critical
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/topology.ts:80-82`
  - `packages/rabbitmq/src/topology.ts:52-56`
  - `services/router/src/consumer.ts:33-41`
  - `services/router/tests/config.test.ts:215-231`
  - `docs/services/ROUTER.md:91`
  - `docs/services/ROUTER.md:97`
  - `docs/services/ROUTER.md:148`

**Problem.** buildPublisherTopology declares a destination queue inside an exchange as `{ durable: true }` with no routingKey. declareTopology then falls back to `[queueName]`. consumer.ts republishes with the incoming key, the replaced key or a static key, which on a topic or direct exchange never matches the queue-name binding. No mandatory flag or alternate exchange is set, so the broker drops the message, and consumer.ts:41 acks the source. This is deterministic silent loss for every documented `queue@topic:`/`queue@direct:` destination. Fanout and headers destinations are unaffected. The test 'full exchange-on-both-sides topology' asserts the faulty spec.

**Evidence.** Reproduced independently by four verifiers against dist (reviews/2026-11/units/scratch/router/topo.js, reviews/2026-11/units/scratch/router2/t.cjs, reviews/2026-11/units/scratch/f1v2/repro.mjs, repro-topology.cjs). `broadcast@topic:broadcast > writer@topic:writer` gives bindQueue(writer, writer, 'writer'), while messages are published as e.g. 'trade.XBTUSD'. `collect@topic:broadcast > collect@topic:writer(key:message:collect)` gives binding 'collect' and publish key 'collect.trade'. `broadcast > writer@topic:out(key:collect)` gives binding 'writer' and publish key 'collect'.

**Fix.**

Add one helper `destinationBindingKey(dest, exType)` and share its exchange-type resolution with the consumer side (see RTP-11/RTP-22):
- topic: a static `(key:v)` with no replace binds `v`; otherwise `#`.
- direct (including 'default', which maps to direct): a static key binds it. A pass-through or replace key is rejected at config time ('a queue on a direct destination needs a static (key:...)').
- fanout and headers: `''` (explicit; the broker ignores it).
Use it at topology.ts:81. In config validation, reject a route whose destination queue equals its source queue. With '#' bound, the doc and test example `collect@topic:broadcast > collect@topic:writer(...)` would become an infinite loop, so change the examples to distinct names (e.g. `writer.in@topic:writer(key:message:collect)`). Making unroutable publishes fail visibly (mandatory plus basic.return) belongs to RTP-03.

**Tests to add.** Update config.test.ts:215-231 to expect `{ durable: true, routingKey: '#' }`. Add publisher-topology cases: topic with no key ('#'), static key (binds v), replace ('#'), direct without a static key (rejected), fanout (''), and a same-queue self-loop (rejected). Optionally drive packages/rabbitmq declareTopology with a recording channel and assert the bindQueue arguments match the key resolveRoutingKey produces for a sample incoming key.

**Verifier notes.** All four verifiers confirmed: lens A high/high, lens B critical/critical. Critical is kept because the loss is deterministic in documented usage, not dependent on any fault. Lens B's line citations (rabbitmq topology.ts:573) were stale. The '#' default for direct must not be copied from the consumer side, since that side has the same bug (RTP-09).

## RTP-02 — The router consumer never recovers from channel or connection loss or a broker cancel, and /health stays 200, so it silently stops routing for good

- **Severity:** high
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/index.ts:10`
  - `services/router/src/consumer.ts:13-25`
  - `packages/service-kit/src/providers/queue/rabbitmq.ts:21`
  - `packages/rabbitmq/src/broker.ts:372-387`
  - `packages/service-kit/src/plugins/health.ts:32-36`
  - `shared/utils/src/services.ts:51-59`
  - `services/router/README.md:13`

**Problem.** The consumer broker is `new Broker(url, { retries: 0, managed: true })`. In handleDisconnect, a managed broker skips both channel recovery and reconnect, and nothing in service-kit ever calls the provider's reconnect(). Even with recovery, the raw `channel.consume` on the channel captured at startup is not in Queue.registrations, so recoverConsumers would restore nothing. `if (! msg) return;` silently ignores a server-side cancel. There is no healthCheck listener, so health always answers 200, and the process stays alive, so Docker never restarts it. Common triggers are a RabbitMQ restart, a network blip, consumer_timeout (RTP-15), and the checkQueue 404 (RTP-04). One accidental exception: a disconnect while a handler is in flight crashes the process through an unhandled rejection (RTP-12), and Docker then restarts it.

**Evidence.** reviews/2026-11/units/scratch/f2/repro.cjs and reviews/2026-11/units/scratch/f3/repro.mjs: a managed broker after a channel or connection close ends with `state=disconnected, connects=1, recoveryAttempts=0`. The keepAlive control recovers. grep finds `reconnect` only in the provider definitions.

**Fix.**

Bounded option, recommended now: fail fast.
(a) In index.ts, add `consumer.on('disconnect', ...)` and `publisher.on('abort', ...)`. Each logs at error level and calls `process.exit(1)` directly, not service-kit shutdown, which exits 0.
(b) In consumer.ts, treat `msg === null` (server cancel) the same way: log an error and exit 1.
(c) Register a health check that answers 503 unless `consumer.getState()==='connected' && publisher.getState()==='connected'`, using `service.on('healthCheck', ...)` or an onHealthCheck passthrough in SKFactory.
(d) Fix README.md:13 to describe the actual behaviour, in present tense and with no conditional on future fixes.
Optional larger follow-up (in-process recovery): consume through `consumer.consume(queueName, cb, { prefetch })` on a non-managed `RabbitMQ.keepAlive` broker, with a raw-delivery option that skips JSON parsing. Capture the delivering channel per message: Queue's ack and nack use the *current* channel, and acking an old delivery tag on a new channel closes it with 406.

**Tests to add.** With a mocked broker, emitting 'disconnect' calls process.exit(1) (spy on it). A null delivery logs and exits. The health handler returns 503 while either broker is not 'connected' and 200 when both are.

**Verifier notes.** All four verifiers confirmed high/yes. They split on the recovery strategy: Queue.consume on keepAlive versus exiting. Exiting is chosen as the bounded, safe step because of the stale-ack caveat raised by lens B v1 and lens A v1. Plain Docker does not restart unhealthy containers, so the 503 is for monitoring and the exit is what triggers the restart.

## RTP-03 — The source is acked before the broker confirms the republish (no confirm channel, no mandatory flag, publisher never flushed or closed): messages are lost on a broker or connection fault

- **Severity:** high
- **Category:** correctness
- **Decision:** DEFER
- **Locations:**
  - `services/router/src/consumer.ts:32-41`
  - `services/router/src/index.ts:11`
  - `packages/rabbitmq/src/connection.ts:87-88`
  - `packages/rabbitmq/src/exchange.ts:202-228`
  - `packages/rabbitmq/src/drain.ts:20-33`
  - `packages/service-kit/src/plugins/shutdown.ts:29-35`
  - `docs/services/ROUTER.md:135`

**Problem.** republish resolves when amqplib accepts the frame into its in-process buffer, or on 'drain'. The publisher is a plain channel on a separate connection, so the source ack on the consumer connection can be processed before the broker has received or stored the copy. Loss windows: a publisher connection reset, a broker crash before persisting, a server close of the publisher channel, and unroutable messages (RTP-01; mandatory alone does not help without confirms, because basic.return would arrive after the ack). On shutdown the keepAlive publisher is never closed. That path is secondary: socket flushing usually wins the race. Bare-queue targets currently publish on the consumer channel, which preserves ordering but has no confirm either.

**Evidence.** connection.ts:88 `createChannel()` (no createConfirmChannel anywhere in packages/rabbitmq/src); drain.ts:27 `if (publish()) { drainCapture.discard(); return; }`; consumer.ts:41 `channel.ack(msg)` right after the loop; amqplib mux writes buffers on setImmediate.

**Fix.**

Preferred (submodule): add `confirm: true` to ConnectionOptions so that createChannel/recoverChannel use createConfirmChannel(), and make Exchange.publish settle from the confirm callback (reject on nack or channel close). Then in the router: publish to all targets with `mandatory: true`, await every confirm, then ack. On nack, return or error, nack the source. Correlate 'return' events per publish (e.g. by messageId or a header). A router-owned confirm channel from `publisher.getConnection().createConfirmChannel()` is possible, but it bypasses Broker recovery and must be recreated on reconnect. Cheap part that can land with RTP-23: close the publisher on shutdown.

**Tests to add.** Fake confirm channel: ack is not called until the confirm callback fires; a confirm error or a 'return' leads to nack and no ack; with several targets, ack happens only after all of them confirm. Integration (when a broker is available): mandatory publish to an unbound exchange leaves the source message in its queue.

**Verifier notes.** All four verifiers confirmed high (both reviewers said critical). Three of four said defer, because the proper fix needs confirm support in @devvir/rabbitmq (out of scope) and a throughput trade-off. Lens A v2 said yes using a router-owned confirm channel. That workaround is noted but not chosen, because it does not survive reconnects without extra wiring.

## RTP-04 — Backpressure poller: an unhandled rejection crashes the process, the passive checkQueue 404 kills the consumer channel, and one failed poll while paused wedges the gate forever

- **Severity:** high
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/backpressure.ts:13-14`
  - `services/router/src/backpressure.ts:24-32`
  - `services/router/src/backpressure.ts:46-50`
  - `services/router/src/backpressure.ts:59`
  - `services/router/src/backpressure.ts:72-86`
  - `services/router/src/index.ts:17`

**Problem.** (a) The async setInterval callback has no catch. A checkQueue rejection is unhandled, and Node 22 exits. No unhandledRejection handler exists anywhere. (b) getDepth runs a passive checkQueue on the consumer broker's only channel. For a watch queue that does not exist yet, the server answers 404 and closes that channel, and with it every source consumer, which never comes back (RTP-02). The result is a crash loop that duplicates the in-flight window each cycle. (c) In the paused loop, `gatePromise = null` runs only on success. One getDepth rejection leaves a rejected promise forever, so every later message throws and is nacked/requeued in a hot loop. That becomes fully live once (b) moves to a separate channel. (d) A synchronous-completion ordering bug: with NaN maxReady the IIFE clears gatePromise before it is assigned. (e) The gate returns after the first resumed queue without re-checking the others. (f) The docblock claims the queue need not exist. Since the router compose now passes ROUTER_MAX_READY/ROUTER_WATCH_QUEUES (e8c4612), this is reachable in a compose deployment.

**Evidence.** reviews/2026-11/units/scratch/router/bp.js and reviews/2026-11/units/scratch/router-v2/bp2.cjs: a 404 from checkQueue produces UNHANDLED REJECTION and the process exits with code 1 about 2 s after start. reviews/2026-11/units/scratch/router/bp-stuck.js and repro-gate.cjs: after one failure during a pause, every later call rejects.

**Fix.**

1) getDepth: use a dedicated depth channel opened lazily from the connection (`conn.createChannel()`), with an 'error' listener attached, dropped on 'close' and recreated on the next poll. Treat a 404 as depth 0 with a throttled warning. If there is no connection, return the last cached depth or 0, and document the fail-open choice. Alternatively, use the management-API backpressure already in packages/rabbitmq.
2) Wrap the interval body per queue in try/catch: log the error, keep the last cached depth, and skip a poll while the previous one is still running.
3) Gate: create the promise before starting the work and always clear it: `let release; gatePromise = new Promise(r => release = r); void (async () => { try { while (...) { await sleep; try { d = await getDepth(name) } catch { warn } } } finally { gatePromise = null; release(); } })();`.
4) After a resume, loop until no watched queue is at or above maxReady.
5) Optionally prime the cache with one awaited poll before consuming starts.
6) Return a stop() that clears the interval and closes the depth channel, for shutdown.
7) Fix the docblock: the queue must exist, and a missing one counts as depth 0.

**Tests to add.** Add tests/backpressure.test.ts with fake timers and an injected getDepth or mock broker: null when maxReady<=0 or there are no watch queues; pass-through below the threshold; concurrent callers share one promise and are released together; one rejection during a pause does not wedge later calls; an interval rejection produces no unhandled rejection (spy on process 'unhandledRejection'); a 404 never touches the consumer channel; with two queues where A recovers and B is still full, the gate keeps waiting; stop() clears the timers.

**Verifier notes.** Merged from lens A F4 (medium, yes) and F5 (high/high, yes), and lens B F5 (medium, yes). Lens A v1 noted that (c) is mostly masked today because a checkQueue failure means the shared channel is already dead, and that it becomes live once (b) is fixed, so (b) and (c) must be fixed together. Severity is high because the compose file now exposes the feature.

## RTP-05 — Prefetch is unbounded unless backpressure is enabled; after downtime the whole backlog is pulled into router memory (OOM crash loop)

- **Severity:** high
- **Category:** efficiency
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/consumer.ts:18-19`
  - `services/router/src/config.ts:13`
  - `services/router/src/types.ts`
  - `services/router/docker/compose.yml`

**Problem.** `channel.prefetch(1000)` runs only when the gate exists. ROUTER_MAX_READY defaults to 0, so by default there is no basic.qos and RabbitMQ pushes every ready message. amqplib does not await callbacks, so every delivery starts its own handler. When publishes wait on 'drain' or credit flow, the handlers pile up holding their messages until the 2 GB heap is exhausted. The prefetch call is also not awaited, and the value 1000 is hard-coded and applies per consumer.

**Evidence.** reviews/2026-11/units/scratch/f6/repro.ts: 200,000 pending handlers, 0 prefetch calls, heap delta 202 MB plus 228 MB external. reviews/2026-11/units/scratch/router/consumer-closed.js prints `prefetch calls with backpressure disabled: 0`.

**Fix.**

Add `prefetch` to Config, read from ROUTER_PREFETCH (default 500) and validated as a positive integer. Before the consume loop, call `await channel.prefetch(config.prefetch)` unconditionally (or pass it to Queue.consume if RTP-02's follow-up is adopted). Add `ROUTER_PREFETCH: ${ROUTER_PREFETCH:-500}` to services/router/docker/compose.yml next to the backpressure variables, which are already there. Document that the limit applies per source queue in ROUTER.md's config table.

**Tests to add.** consumer.test.ts: prefetch is called with the configured value when holdPublishing is null, and consume is not called until the prefetch promise resolves (deferred mock); a rejecting prefetch rejects consumeAndRepublish. config.test.ts: default 500; '0', '-1' and 'abc' are rejected.

**Verifier notes.** All four verifiers confirmed high/yes. OOM needs the publish side to lag, which is plausible when draining a backlog. The compose env gap mentioned in the findings is already fixed in HEAD (e8c4612); the default of 0 still leaves prefetch off.

## RTP-06 — Cached Exchange objects go stale after the second publisher recovery (hot nack loop), and bare-queue targets publish on the consumer channel

- **Severity:** high
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/consumer.ts:22`
  - `services/router/src/consumer.ts:78-96`
  - `packages/rabbitmq/src/topology.ts:43-45`
  - `packages/rabbitmq/src/topology.ts:93`
  - `packages/rabbitmq/src/broker.ts:375`

**Problem.** resolveTargets caches Exchange instances once. On recovery, declareTopology replaces the broker's map entries with new Exchange instances (it does not reuse them, unlike queues). The router's instance survives the first recovery, because setChannel runs before the replacement, but after the second one it keeps a closed channel. Every publish then throws 'Channel closed', and the catch nacks with requeue, a hot loop until restart. Bare-queue (default-exchange) targets are built with `new RabbitMQ.Exchange(channel, '')` on the consumer channel. They bypass the publisher connection, are owned by no broker, and are never re-channelled.

**Evidence.** reviews/2026-11/units/scratch/f4/repro.cjs with the dist @devvir/rabbitmq and fake amqplib: after drop 2, `held.republish FAILED: IllegalOperationError Channel closed`, while a fresh getExchange('dest') succeeds.

**Fix.**

Store only the destination exchange name in Target and resolve `publisher.getExchange(name)` per message, an O(1) Map lookup that throws if the exchange is missing. For bare-queue destinations, publish through the publisher broker: either use `publisher.getQueue(dest.queue)`, which the publisher topology already declares and which is reused and re-channelled on recovery, or keep one default `new RabbitMQ.Exchange(publisher.getChannel()!, '')`, re-channelled on the publisher's 'connect'/'disconnect' events. Do NOT declare '' in the publisher topology: assertExchange('') is refused with ACCESS_REFUSED, so the first fix suggested by lens A F16 would crash at startup. Remove the `channel` parameter from resolveTargets. Upstream (submodule): declareTopology should reuse existing Exchange instances.

**Tests to add.** Mock publisher whose map entry is replaced by a new Exchange: the next message publishes through the new instance. A bare-queue destination publishes through the publisher, never the consumer channel.

**Verifier notes.** Lens B F4 was confirmed high/yes by both verifiers and reproduced. It is merged with lens A F16 (low/medium). The consumer-channel half of the stale problem is moot, because a lost consumer channel stops all consumption (RTP-02).

## RTP-07 — Rules sharing a source queue overwrite each other's binding keys, and every destination of the queue receives every message

- **Severity:** high
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/topology.ts:43-52`
  - `services/router/src/consumer.ts:21-22`
  - `services/router/src/consumer.ts:64-76`
  - `services/router/src/config.ts:27-31`
  - `docs/services/ROUTER.md:109-112`

**Problem.** buildConsumerTopology assigns `queues[source.queue]` once per route, so only the last binding key survives. groupBySource keys only on the queue name, so all destinations of all rules on that queue get everything. `q@topic:ex(key:trade.*) > d1 | q@topic:ex(key:book.*) > d2` binds only book.*, and d1 receives book messages. The documented multi-source form `q@topic:ex(key:a) & q@topic:ex(key:b) > d` loses binding a, and because it creates duplicate targets, each message is republished to d twice. Bindings from earlier runs persist on the durable queue.

**Evidence.** reviews/2026-11/units/scratch/router/samequeue.js and reviews/2026-11/units/scratch/router-v2/f8.cjs: spec `{"ex":{"type":"topic","queues":{"q":{"durable":true,"routingKey":"book.*"}}}}`.

**Fix.**

Decision made here: accumulate keys for the same queue and the same destination set, and reject different destination sets.
1) buildConsumerTopology: collect binding keys per (exchange, queue) into a deduplicated array (QueueSpec.routingKey accepts string[]). This makes the `&` multi-source form work.
2) resolveTargets: deduplicate targets by (destination exchange or queue, routingKey config, headers), so a message is published once per distinct destination.
3) validateConfig: group routes by source.queue. Throw if routes on one queue name different source exchanges or effective types, or if they carry different binding keys while having different destination sets. Message: 'Source queue "q" is bound differently by rules with different destinations; a queue cannot filter per rule — use distinct source queues'.
4) ROUTER.md: state that every rule on a source queue receives every message of that queue, and that the router never removes bindings from the broker.

**Tests to add.** config.test.ts: two rules on the same queue with different keys and different destinations throw; the same queue with a different exchange throws; `q@topic:ex(key:a) > d1 & d2` is accepted and binds a once. Topology test: `q@topic:ex(key:a) & q@topic:ex(key:b) > d` yields routingKey ['a','b']. Consumer test: duplicate targets are published once.

**Verifier notes.** Lens A: high/high. Lens B v1: medium. The verifiers disagreed on the fix: lens A v1 and lens B v1 wanted rejection only (and warned that combining accumulation with rejection is contradictory), while lens A v2 found that the documented `&` multi-source syntax needs accumulation. The resolution is to accumulate only where the destination set is identical (no misrouting possible) and reject otherwise. That is consistent and supports both. Severity is high because the documented `&` form is broken.

## RTP-08 — Pipe exits with code 0 on fatal errors, so `restart: on-failure` never retries it and the bindings are never declared

- **Severity:** high
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/pipe/src/index.ts:4-12`
  - `services/pipe/docker/compose.yml`
  - `packages/service-kit/src/core/runner.ts:37-48`
  - `packages/service-kit/src/plugins/shutdown.ts:35`
  - `services/pipe/README.md:12`
  - `services/pipe/README.md:105`

**Problem.** When the run function throws (provider connect exhausts its 10 retries in about 2 minutes, or declares fails with 406 or with an invalid type), the runner calls shutdown('ERROR'), which always ends in `process.exit(0)`. Docker's on-failure policy then treats pipe as finished, and the source exchanges route nothing. Config errors at module load are the exception: they do exit non-zero. Setting `process.exitCode = 1` does not help, because the explicit exit(0) overrides it. The README claims 'restarts only on failure' and talks about a 'next run' that nothing triggers.

**Evidence.** A real run of `node dist/src/index.js` against a closed port retried for about 2 minutes, logged 'fatal error — shutting down', and exited 0 (reviews/2026-11/units/scratch/pipe-exit.log). repro-exit.cjs gives the same result.

**Fix.**

In services/pipe/src/index.ts, wrap the body in try/catch. On error, call `service.logger.error({ err }, 'Failed to declare bindings')` and then `process.exit(1)` directly. Do not rethrow and do not call shutdown, both of which exit 0. On success, `await service.shutdown()`. Upstream (service-kit submodule, separate owner): `process.exit(signal === 'ERROR' ? 1 : 0)`. Fix README.md:12 (exits 0 on success and non-zero on a broker or declare failure, and is then restarted) and :105 (bindings are re-declared only when pipe is started again).

**Tests to add.** services/pipe/tests/index.test.ts: mock ./service so that run invokes the function with a fake service whose declares rejects; spy on process.exit and expect 1. A success case awaits shutdown. This needs no Docker.

**Verifier notes.** Merged lens A F11 (medium, yes) and lens B F7 (high/high, yes). Lens B v2 reproduced it with the real entrypoint. High is taken, because a one-shot service that dies permanently without its bindings means total silent loss for those exchanges.

## RTP-09 — Router direct and 'default' source exchanges are bound with '#' by default; on a direct exchange '#' is a literal key, so the queue receives nothing

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/topology.ts:39`
  - `services/router/src/topology.ts:47-48`
  - `services/router/src/config.ts (toSource)`
  - `docs/services/ROUTER.md:44`

**Problem.** When no `(key:...)` is given, the binding key defaults to '#' for both topic and direct, and 'default' maps to direct. `src@direct:ex > writer` and `broadcast@default:events > writer` bind a key that matches only the literal '#'. ROUTER.md:44 documents '#' as the catch-all for direct. Pipe already requires an explicit key for direct sources.

**Evidence.** reviews/2026-11/units/scratch/router/topo.js: `consumer bindQueue src <- ex key="#"` on a direct exchange; reproduced again by lens A v1 against dist.

**Fix.**

topology.ts: `routingKey: source.bindingKey ?? (exType === 'topic' ? '#' : undefined)`. config.ts toSource: throw when the source exchange is direct and has no key (`Direct exchange "x" needs an explicit binding key: queue@direct:x(key:...)`). Reject type 'default' on router sources ('the default exchange cannot be bound; use a bare queue name'). Update ROUTER.md:44 and its Rule Validation list.

**Tests to add.** config.test.ts: 'q@direct:ex > d' throws; 'q@direct:ex(key:collect) > d' gives bindingKey 'collect'; 'q@default:ex > d' throws; 'q@topic:ex > d' still binds '#'.

**Verifier notes.** Lens A F10 confirmed medium/yes. Also noted by lens A v1 under F3 and lens B v2 under F1. Keeping 'default' as an alias for direct is possible, but it is confusing next to the AMQP default exchange, so it is rejected.

## RTP-10 — Pipe accepts topology that cannot work: a queue in a direct destination is bound with '#', type 'default' reaches assertExchange, and a source `queue@` is silently dropped

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/pipe/src/bindings.ts:10-11`
  - `services/pipe/src/bindings.ts:65-68`
  - `services/pipe/src/bindings.ts:82-98`
  - `services/pipe/src/bindings.ts:100-108`
  - `services/pipe/README.md:9`
  - `services/pipe/README.md:39`
  - `shared/utils/src/routes.ts:86`

**Problem.** (a) Destination `q@direct:x` is always bound with '#', so it never receives forwarded messages, which keep their original key. Binding with the source key does not work either: a topic pattern is literal on a direct exchange, and several bindings into one destination collide. (b) The shared parser allows 'default', and the casts in toBinding pass `{type:'default'}` to assertExchange, which RabbitMQ rejects at runtime (and then pipe exits 0, RTP-08). (c) Source `q@topic:src` passes validation and the queue is dropped. The docblock grammar even documents `[queue@]` on sources.

**Evidence.** Dist repros (repro-pipe.cjs; lens A v1, lens B v1): `topic:x > q@direct:y` gives `queues:{q:{routingKey:'#'}}`; `default:a > fanout:b` gives `a:{type:'default'}`; `q@topic:src > fanout:dst` produces no queue anywhere.

**Fix.**

validatePipeItem: throw on `exchange.type === 'default'` ('the default exchange cannot be used in pipe bindings'); throw on `side === 'source' && item.queue` ('pipe sources are exchanges; a queue prefix is only valid on the destination'); throw on a destination queue on a direct exchange ('a queue inside a direct destination cannot match forwarded keys; use a topic or fanout destination'). Keep '#' for topic, fanout and headers (switching to '' for fanout/headers is optional). Fix the docblock grammar to `(type:exchange | @exchange)[(key:pattern)] > [queue@](type:exchange | @exchange)`. Replace the `as` casts with a PipeExchange type that excludes 'default' (see RTP-22). README :9 and :39: list the supported destination types.

**Tests to add.** bindings.test.ts: 'topic:src > q@direct:dst' throws; 'topic:src > q@topic:dst' still gives '#'; 'default:a > fanout:b' throws; 'q@fanout:src > fanout:d' throws; a fanout-destination queue is accepted.

**Verifier notes.** Merged lens A F12 (medium, yes), the pipe parts of lens A F13, and lens B F10 (medium, yes). Rejecting is preferred over binding with the source key (lens A v1).

## RTP-11 — Conflicting or omitted exchange types are resolved silently by the first mention, in both the router and pipe; the documented ROUTER.md:85 example fails with a 406 or self-loops

- **Severity:** medium
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/topology.ts:37-41`
  - `services/router/src/topology.ts:71-75`
  - `services/pipe/src/bindings.ts:31-47`
  - `services/pipe/src/bindings.ts:56-59`
  - `docs/services/ROUTER.md:85`

**Problem.** Both ensureExchange helpers return early if the name is already recorded. In pipe, withDefaults looks at each binding's own type, so `topic:x > fanout:y | @x > fanout:z` declares x as topic but binds x to z with '' (topic: only an empty key matches), and z gets nothing. `fanout:a > fanout:b | topic:b(key:trade.*) > fanout:c` declares b as fanout and the trade.* filter is ignored, so c gets everything. The router builds its consumer and publisher topologies independently on the same broker. `broadcast@topic:broadcast > @fanout:broadcast` asserts the exchange as both topic and fanout (406 at startup), and it would loop into its own source.

**Evidence.** repro-pipe.cjs and repro-topology.cjs; lens A v1 and lens B v1 both reproduced against dist. (The reviewer's original pipe example `fanout:a > b` was invalid, because a bare `b` is a queue, but the corrected forms reproduce.)

**Fix.**

Resolve the types before building, in config load so the error surfaces at startup. Build one name→type map over all items (for the router, consumer and publisher sides together). Throw on two different explicit types for one name. Apply the resolved type to untyped mentions before withDefaults and binding-key derivation, and default to fanout only for names that are never typed. In the router, also reject a route whose destination exchange equals its source exchange. Put `resolveExchangeType` in one shared helper (RTP-22). Fix or remove the ROUTER.md:85 example.

**Tests to add.** Pipe: `topic:x > fanout:y | @x > fanout:z` gives x→z key '#'; `fanout:x > fanout:a | topic:x > fanout:b` throws. Router: the ROUTER.md:85 rule throws; `q@topic:e > d | q2@fanout:e > d2` throws.

**Verifier notes.** Merged lens A F13 (medium, yes) and lens B F9 (medium, yes).

## RTP-12 — Error path: ack/nack on a closed channel causes an unhandled rejection that crashes the process; systemic errors are requeued immediately in a hot loop; partial fan-out duplicates

- **Severity:** medium
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/consumer.ts:27-45`

**Problem.** If the consumer channel is closed, channel.ack throws IllegalOperationError, the nack in the catch throws again, and amqplib ignores the async callback's promise, so Node 22 exits. Every error leads to an immediate `nack(requeue=true)` with no delay or throttling, which becomes a CPU- and log-burning loop while the publisher is disconnected or a stale Exchange (RTP-06) or a wedged gate (RTP-04) is present. Targets are published one after another, so a retry re-publishes to targets that already succeeded.

**Evidence.** reviews/2026-11/units/scratch/router/consumer-closed.js: `UNHANDLED REJECTION -> Channel closed` after 'Failed to route message'.

**Fix.**

Add a `settle(fn)` helper that wraps ack and nack in try/catch and logs at warn on a closed channel (the broker redelivers anyway). Before nacking a systemic failure (publisher `getState() !== 'connected'`), wait for the publisher's 'connect' event, or apply a short backoff, so the requeue cannot spin. Throttle the 'Failed to route message' log, e.g. once per N failures per source. Document in ROUTER.md that fan-out is at-least-once per destination. The poison-message/DLX policy is RTP-16.

**Tests to add.** consumer.test.ts: ack that throws and nack that throws produce no rejection; with two targets where the second rejects, nack happens once and there is no ack; a publisher-disconnected error waits before nacking.

**Verifier notes.** Merged lens A F7 (medium, yes) and the bounded part of lens B F11 (medium, defer for DLX). Lens B v1 corrected the scenario: oversized messages or a user_id mismatch do not throw on a non-confirm channel, they are acked and lost (RTP-03); the hot loop comes from publisher disconnects and RTP-06.

## RTP-13 — docs/services/ROUTER.md is false and self-contradictory (syntax, defaults, header merge, ack semantics, health, config table) and has examples that drop data or fail

- **Severity:** medium
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `docs/services/ROUTER.md:35`
  - `docs/services/ROUTER.md:44`
  - `docs/services/ROUTER.md:57`
  - `docs/services/ROUTER.md:75`
  - `docs/services/ROUTER.md:85`
  - `docs/services/ROUTER.md:91`
  - `docs/services/ROUTER.md:97`
  - `docs/services/ROUTER.md:104-106`
  - `docs/services/ROUTER.md:130-135`
  - `docs/services/ROUTER.md:148`
  - `docs/services/ROUTER.md:157`
  - `docs/services/ROUTER.md:166-181`

**Problem.** Lines 35 and 157 say a colon without '@' is an error, but the `type:name` shorthand parses (it is exchange-only, so valid on destinations and rejected as a source for lack of a queue). Line 44: '#' is not a catch-all on direct (RTP-09). Lines 57 and 132 call the header merge 'non-destructive', but injected headers win (RTP-17). Line 85 conflicts and self-loops (RTP-11). Lines 91, 97 and 148 drop every message (RTP-01). Lines 130 and 135 overclaim property preservation and acking on publish (RTP-03, RTP-17). The health section claims 503 and a route list, but health always returns 200 {status:'ok'} (until RTP-02 lands). The config table lists only ROUTER_RULES and omits QUEUE_URL, ROUTER_MAX_READY and ROUTER_WATCH_QUEUES (and ROUTER_PREFETCH from RTP-05). Backpressure is undocumented. The grammar is re-described here, breaking the one-home rule.

**Evidence.** shared/utils/src/routes.ts:29 and 131 (shorthand); config.test.ts 'accepts type:name shorthand'; health.ts:32-36; router service spec registers no health listener.

**Fix.**

Rewrite ROUTER.md from the code, in the same change as the code fixes it describes (RTP-01, 02, 05, 07, 09, 11, 12, 17, 18), so that it describes only the current behaviour: no 'until fixed', no history, no plans (CLAUDE.md). Contents: router-specific restrictions plus a pointer to the grammar's single home (the parseRules docblock in shared/utils/src/routes.ts); binding-key defaults per exchange type, and the binding a destination queue gets; header precedence and key-replace semantics; delivery semantics (as decided in RTP-03); a backpressure section; a complete env table; actual health behaviour; working examples with neutral queue names that do not self-loop.

**Tests to add.** None (docs). Optionally run each documented example through loadConfig plus the topology builders in a test, so that broken examples fail CI.

**Verifier notes.** Merged lens A F20 (medium, yes) and the ROUTER.md part of lens B F14 (medium, yes). Lens A v1: names like codec.in or writer in examples are cosmetic, not a rule violation, but neutral names are preferred.

## RTP-14 — Router tests: backpressure.ts at 0%, consumer failure paths untested, a pass-through test that cannot detect a hard-coded key, a test that locks in RTP-01, no integration suite

- **Severity:** medium
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/backpressure.ts`
  - `services/router/tests/consumer.test.ts:10-18`
  - `services/router/tests/consumer.test.ts:93-108`
  - `services/router/tests/config.test.ts:215-231`
  - `services/router/tests/.env.testing:1-15`
  - `services/router/vitest.config.ts`

**Problem.** Coverage: backpressure.ts 0%; consumer.ts 78% of branches (prefetch and gate uncovered); index.ts untested. The named-exchange test uses incoming key '' and asserts '', so it cannot tell pass-through from a hard-coded ''. The 'full exchange-on-both-sides topology' test asserts the RTP-01 bug. service-kit is fully mocked, so channel-close, recovery and ack-throws behaviour never surface. .env.testing mentions a globalSetup and RabbitMQ ports that the router does not have. pino output bypasses `onConsoleLog`.

**Evidence.** cov-router and cov-router-v: `backpressure.ts | 0 | 0 | 0 | 0`; `consumer.ts | 90 | 78.12 | 100 | 95.45 | 16,19`.

**Fix.**

Add the tests alongside each fix (backpressure: RTP-04; prefetch: RTP-05; ack/nack: RTP-12; topology: RTP-01/07/09/11). Change the named-exchange test to use incoming key 'trade.btc' and assert pass-through. Add: no-channel throw; getExchange returning undefined throws; replace with no match leaves the key unchanged; null msg handling (RTP-02). Remove the globalSetup sentence and the port variables from .env.testing, or add the integration suite. Integration suite (it can follow separately and needs Docker): copy pipe's global-setup and test topic→topic with a destination queue, key replace, header injection, a shared source queue, and a channel close. Optionally set LOG_LEVEL=silent in tests.

**Tests to add.** As listed in the fix.

**Verifier notes.** Merged lens A F22 (router part, low) and lens B F15 (medium). Lens B v1: config.test.ts has 233 lines, so the cited 430-446 is really 215-231.

## RTP-15 — Backpressure keeps up to prefetch deliveries unacked for the whole pause; RabbitMQ 3.12 consumer_timeout (30 min) then closes the consumer channel

- **Severity:** medium
- **Category:** robustness
- **Decision:** DEFER
- **Locations:**
  - `services/router/src/backpressure.ts:72-79`
  - `services/router/src/consumer.ts:28`
  - `services/rabbitmq/docker/base.yml:6`

**Problem.** The gate blocks inside the delivery handler, before the ack, with no upper bound on the pause. A downstream outage longer than 30 minutes trips consumer_timeout, the channel is closed with PRECONDITION_FAILED, the messages are requeued, and (RTP-02) the consumer never comes back. Once RTP-02's fail-fast lands, the process restarts instead, but it then crash-loops for as long as the pause lasts.

**Evidence.** rabbitmq:3.12-management-alpine image; there is no consumer_timeout override in services/rabbitmq/docker/rabbitmq.conf or advanced.config.

**Fix.**

Gate before taking deliveries: when paused, `channel.cancel(tag)` for every source consumer and let the handlers already holding messages publish and ack (overshoot of at most one prefetch; maxReady is a soft limit) or nack-requeue them; re-consume on resume. Alternatively, nack the held deliveries before about 25 minutes. Fallback: a consumer-timeout policy larger than any expected outage, documented in ROUTER.md.

**Tests to add.** A fake gate that stays paused: cancel is called, no handler is still awaiting the gate, and consume is called again on resume.

**Verifier notes.** Lens A F9 confirmed medium/defer: it belongs with the consumer-lifecycle redesign and is a design choice.

## RTP-16 — No poison-message policy: failures are requeued forever with no retry limit and no dead-lettering

- **Severity:** medium
- **Category:** robustness
- **Decision:** DEFER
- **Locations:**
  - `services/router/src/consumer.ts:42-45`
  - `services/router/src/topology.ts:50`
  - `services/router/src/topology.ts:54`

**Problem.** A message that fails every time is redelivered at the head of the queue indefinitely and blocks the messages behind it. Source queues have no dead-letter configuration. Adding `x-dead-letter-exchange` through assertQueue arguments would break existing durable queues with 406 PRECONDITION_FAILED (inequivalent args).

**Evidence.** consumer.ts:44 `channel.nack(msg, false, true)` unconditionally; source queues declared `{ durable: true }` only.

**Fix.**

Choose one of the following. (a) Configure dead-lettering with a RabbitMQ policy (`rabbitmqctl set_policy ... dead-letter-exchange`), not queue arguments; on a redelivered failure, nack with requeue=false. (b) A bounded retry count carried in a header on a republished copy (`fields.redelivered` is only a boolean), with backoff, then drop or park the message. Add stable message ids for downstream deduplication once confirms exist (RTP-03).

**Tests to add.** A redelivered failing message is nacked without requeue (or parked) after N attempts; a first failure is requeued with backoff.

**Verifier notes.** Split out of lens A F7 and lens B F11. Lens B v1 deferred this part as needing an owner decision and a migration.

## RTP-17 — Republish is not property-faithful: it forces persistent, stamps a missing contentType as application/json, lets injected headers override existing ones, and key replace is unanchored and expands $-patterns

- **Severity:** low
- **Category:** correctness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/consumer.ts:35-38`
  - `services/router/src/consumer.ts:102`
  - `packages/rabbitmq/src/exchange.ts:211`
  - `packages/rabbitmq/src/exchange.ts:239-245`
  - `docs/services/ROUTER.md:57`
  - `docs/services/ROUTER.md:130-132`

**Problem.** Exchange.publish defaults `persistent = true` and `contentType = 'application/json'`. amqplib lets `persistent` win over deliveryMode, so every message becomes persistent, and a message without a contentType gets application/json. userId is copied unchanged (a 406 if it differs from the router's user). `{...existing, ...target.headers}` lets injected headers win, although the docs say the merge is non-destructive. `incoming.replace(value, replace)` replaces the first occurrence anywhere ('bitmex.trade' with key:trade:t gives 'bitmex.t') and expands `$&`/`$1`. contentEncoding is actually preserved (lens B's claim corrected).

**Evidence.** amqplib api_args.js:213-214; defs.js decodeBasicProperties gives explicit undefined keys; consumer.ts:102.

**Fix.**

Router side, now: pass `persistent: msg.properties.deliveryMode === 2` and `userId: undefined` in the republish overrides (passing deliveryMode has no effect). Implement key replace as an anchored prefix: `incoming === value || incoming.startsWith(value + '.') ? replace + incoming.slice(value.length) : incoming`, with no $ expansion. Keep 'injected header wins' and document it. Do not call `publisherChannel.publish` directly: that bypasses the channelReadyPromise and drain handling. ContentType preservation needs the submodule: Exchange.republish should publish only the defined original properties without defaults.

**Tests to add.** consumer.test.ts: deliveryMode 1 in gives persistent false out; 'bitmex.trade' with key:trade:t is unchanged; 'message.trade' with key:message:collect gives 'collect.trade'; a replacement 'a$&' is applied literally; a header collision follows the documented precedence.

**Verifier notes.** Merged lens A F15 (low, yes) and lens B F12 (low, defer, because the full fix is in the submodule). The bounded router-side parts are implemented; contentType is an upstream request. Both verifiers flagged the suggested `deliveryMode:` override and the raw channel publish as ineffective or harmful.

**Open question (non-blocking).** (Upstream) Should @devvir/rabbitmq Exchange.republish preserve the original properties exactly, without the persistent/contentType defaults? That is the only way to keep a missing contentType missing.

## RTP-18 — Router config validation gaps: numeric env values unvalidated, watch queues without a max, ignored `(key:)` modifiers, self-loops and duplicate rules accepted

- **Severity:** low
- **Category:** config
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/config.ts:13-14`
  - `services/router/src/config.ts:27-31`
  - `services/router/src/config.ts:43-54`
  - `services/router/src/consumer.ts:33`
  - `services/router/src/consumer.ts:93`

**Problem.** `parseInt` reads 'abc' as NaN, which disables backpressure silently while logging pause/resume per message, and reads '50k' as 50. Watch queues with maxReady 0 are silently ignored. `(key:)` on a bare-queue source is dropped, and on a bare-queue destination it is ignored (fixedRoutingKey = queue name), contrary to ROUTER.md:47-49. `a > a` or `a > b | b > a` cycle forever. Duplicate rules double every message. A same-exchange self-loop (`q@fanout:x > @fanout:x`) is also accepted.

**Evidence.** reviews/2026-11/units/scratch/router/bp-nan.js: 1000 gate calls in 1 ms at depth 999999. config.test.ts 'no bindingKey when source has no exchange' asserts the silent drop.

**Fix.**

Parse maxReady (and prefetch) with `Number()` and require `Number.isInteger(n) && n >= 0`, otherwise throw with the raw value in the message. Throw when watchQueues is set and maxReady is 0. In validateConfig, collect the errors and throw them together: (1) a bare destination queue equal to the source queue; (2) a destination exchange equal to the source exchange when the source binding matches everything (fanout or headers, or topic with no key or '#'); (3) duplicate routes (compare formatRoute strings); (4) `(key:)` on a bare-queue source; (5) `(key:)` on a bare-queue destination. Update the existing config test to expect the error.

**Tests to add.** config.test.ts cases for 'abc', '10k', '1e5', '-1', watch queues without a max, each of the rejections (1) to (5), and an `&`-expanded identical source still accepted.

**Verifier notes.** Merged lens A F14 and F19, and lens B F18 (all low, yes). The compose env part of lens B F18 is already fixed in HEAD. Lens A v1: `a > a` is a cycle, not amplification. The gate first-queue issue is folded into RTP-04.

## RTP-19 — Router and pipe READMEs: false claims, failing examples, plan language, neighbour and consumer framing, the grammar triplicated, and a stale .env.testing comment

- **Severity:** low
- **Category:** docs
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/README.md:12-13`
  - `services/router/README.md:27-28`
  - `services/pipe/README.md:3`
  - `services/pipe/README.md:9`
  - `services/pipe/README.md:12`
  - `services/pipe/README.md:32`
  - `services/pipe/README.md:36`
  - `services/pipe/README.md:39`
  - `services/pipe/README.md:49`
  - `services/pipe/README.md:71-74`
  - `services/pipe/README.md:95`
  - `services/pipe/README.md:105`
  - `services/pipe/README.md:107-118`
  - `services/router/tests/.env.testing:2`

**Problem.** Router README: 'Automatic reconnection' is false, and the config list omits QUEUE_URL and the backpressure variables. Pipe README: the `[type:]source`/'defaults to fanout' grammar and the `broadcast > ingest` example throw ('Pipe source must be an exchange'); `@broadcast > @ingest` is the working form. ':12 restarts only on failure' is false (RTP-08). ':49 not yet supported' is plan language. ':3' and ':107-118' explain the Router (a neighbour). ':95' explains the offering through a nonexistent 'journalist service' consumer. ':115' claims the router preserves headers. The grammar is described in three places. router .env.testing:2 mentions a nonexistent globalSetup.

**Evidence.** Node against dist: `broadcast > ingest => THROWS Pipe source must be an exchange, not a bare queue`.

**Fix.**

Pipe README: syntax `(type:exchange | @exchange)[(key:pattern)] > [queue@](type:exchange | @exchange)`, saying that an untyped `@name` is declared fanout, together with pipe's restrictions and defaults (after RTP-10/11) and a pointer to the grammar home. Replace the example with `@broadcast > @ingest`. ':49' becomes 'Header-based filtering is not supported.' Describe destination-queue assertion without naming a consumer. Delete the 'Unlike the Router' clause and the Pipe vs Router section; at most a one-line pointer to ROUTER.md. Describe the exit codes as they are after RTP-08, and add the additive-only note (RTP-21). Router README: describe reconnection as it is after RTP-02 (exit on disconnect, then a container restart), list every env var or point to ROUTER.md. Delete the .env.testing comment line. All text in present tense, with no reference to pending fixes.

**Tests to add.** None (docs).

**Verifier notes.** Merged lens A F21 (low, yes) and the README part of lens B F14 (medium, yes).

## RTP-20 — Pipe tests: config.ts and index.ts untested, unit tests need Docker, helpers reimplement the service, no destination-queue cases, invalid PIPE_BINDINGS in .env.testing, the Recovery test checks the rabbitmq package

- **Severity:** low
- **Category:** testing
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/pipe/vitest.config.ts:8`
  - `services/pipe/src/config.ts`
  - `services/pipe/src/index.ts`
  - `services/pipe/tests/integration.test.ts:20-35`
  - `services/pipe/tests/integration.test.ts:255`
  - `services/pipe/tests/integration.test.ts:284`
  - `services/pipe/tests/integration.test.ts:290-300`
  - `services/pipe/tests/integration.test.ts:319-354`
  - `services/pipe/tests/.env.testing:15`

**Problem.** The unconditional globalSetup makes even the pure bindings.test.ts fail without Docker. config.ts and index.ts have 0% coverage, because the integration helpers reimplement them. No case covers `queue@` destinations. `PIPE_BINDINGS=test-queue` throws 'Rule missing >', so importing config.ts in a test would fail. The Recovery test exercises the Broker's channel recovery on keepAlive, while pipe is one-shot, so it does not test pipe, and its comment narrates history. The headers test comment uses plan language.

**Evidence.** `npx vitest run` fails in tests/global-setup.ts:18 before any test runs; coverage config.ts 0, index.ts 0.

**Fix.**

Split vitest into a 'unit' project (bindings, config and index tests, no globalSetup) and an 'integration' project (globalSetup). Add a `test:unit` script. Set .env.testing PIPE_BINDINGS to `fanout:int.pipe.env.src > fanout:int.pipe.env.dst`. Export loadConfig (as the router does) and add config tests (missing QUEUE_URL, empty PIPE_BINDINGS, topic gets '#'). Add the index test from RTP-08. Add integration cases `fanout:s > q@fanout:d` and `fanout:s > q@topic:d` that consume from q. Move the Recovery test to packages/rabbitmq (submodule owner) or delete it. Do not switch it to the provider path. Reword the comments in present tense.

**Tests to add.** As listed in the fix; `npx vitest run --project unit` passes with Docker stopped.

**Verifier notes.** Merged the pipe part of lens A F22 and lens B F16 (low, yes). Lens A v1 corrected the suggested fix for the Recovery test: pipe never needs in-process recovery, so pointing the test at the managed provider would be meaningless. Lens B line numbers corrected per lens B v1.

## RTP-21 — Pipe only adds bindings: removing or narrowing a rule in PIPE_BINDINGS leaves the old binding active (undocumented)

- **Severity:** low
- **Category:** robustness
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/pipe/src/index.ts:7`
  - `packages/rabbitmq/src/topology.ts:76-79`
  - `services/pipe/README.md:105`

**Problem.** Exchange-to-exchange and destination-queue bindings are durable and only ever added. Narrowing `(key:#)` to `(key:trade.*)` keeps the '#' binding, so the destination still receives everything. The README describes persistence but not this.

**Evidence.** There is no unbind path in pipe; Queue.unbindFromExchange is never used.

**Fix.**

Now: a present-tense paragraph in the pipe README saying that pipe only adds exchanges and bindings, that a binding removed from or changed in PIPE_BINDINGS stays on the broker, and how to remove one (`rabbitmqctl list_bindings ...`, the management UI, or `DELETE /api/bindings/{vhost}/e/{src}/e/{dst}/{props}`). Deferred: automatic reconciliation (see owner question).

**Tests to add.** None for the doc. If reconciliation is built later: declare `(key:#)`, re-run with `(key:trade.*)`, and assert that a message with key 'other' no longer arrives.

**Verifier notes.** Lens A F23 confirmed low: implement the doc and defer reconciliation.

**Open question (non-blocking).** Should pipe reconcile its bindings (tag them with an argument such as x-declared-by=pipe and unbind tagged bindings that are no longer configured, through the management API, which needs credentials and a host), or stay additive with a documented manual cleanup? Note that adding the tag changes binding identity, so existing untagged bindings would not match.

## RTP-22 — Dead code, weak typing and duplicated topology helpers with inconsistent defaults (wrong type shown in the route log)

- **Severity:** low
- **Category:** code-quality
- **Decision:** IMPLEMENT
- **Locations:**
  - `services/router/src/types.ts:37`
  - `services/router/src/types.ts:40-43`
  - `services/router/src/service.ts:8`
  - `services/router/src/config.ts:8`
  - `services/router/src/index.ts:11`
  - `services/router/src/consumer.ts:78`
  - `services/router/src/consumer.ts:107-112`
  - `services/router/src/topology.ts:13`
  - `services/router/src/topology.ts:25`
  - `services/router/src/topology.ts:37-41`
  - `services/router/src/topology.ts:71-75`
  - `services/pipe/src/bindings.ts:57-74`
  - `services/pipe/src/bindings.ts:100-106`
  - `services/pipe/src/config.ts:10`
  - `shared/utils/src/services.ts:41`

**Problem.** RouterResources is unused. `state: { counter: 0 }` is never read. `config.rabbitmqUrl` is sanitised but neither connection uses it (both read process.env.QUEUE_URL), in the router and in pipe. `channel: any`. Two identical ensureExchange closures. formatDestination prints `@default:` for an untyped exchange that is declared as fanout (and 'default' for one declared as direct), so the 'Route established' log is wrong. formatRoute is used only in tests. Redundant `as TopologySpec` casts. The Config index signature disables excess-property checks. Pipe's optional ExchangeSpec.name forces six `name!`, and `as` casts hide 'default'.

**Evidence.** knip reports RouterResources unused; consumer.ts:110 `d.exchange.type || 'default'` vs topology.ts:39 `ex.type || 'fanout'`.

**Fix.**

Delete RouterResources and the unused state. Extract `resolveExchangeType(ex)` (default→direct, missing→fanout) and a shared `ensureExchange` used by both builders, the formatter and the RTP-11 conflict check. Log routes with formatRoute (or a formatter that resolves types). Remove the `channel` parameter (RTP-06), or type it as the broker's channel type. Drop the redundant casts. Remove the Config index signature if nothing relies on it. Pipe: a `PipeExchange { name: string; type?: 'fanout'|'topic'|'direct'|'headers' }` type for Binding. Deferred: routing the sanitised URL through SKFactory affects every service; either do that in shared/utils or drop sanitizeUrl and keep redactUrl.

**Tests to add.** An untyped destination exchange is logged as fanout; tsc passes with the stricter pipe types.

**Verifier notes.** Lens B F17 confirmed low/yes. Corrections from lens B v1: `!` on QUEUE_URL cannot be empty (validateConfig runs first); `name!` occurs six times, not four; the connection impact of the unsanitised URL is only an edge case.

**Open question (non-blocking).** Should SKFactory accept an explicit RabbitMQ URL (so services can pass their sanitised config URL), or should sanitizeUrl be removed from service configs? This affects every service.

## RTP-23 — Graceful shutdown neither cancels the raw consumers nor drains in-flight handlers, and never closes the publisher

- **Severity:** low
- **Category:** robustness
- **Decision:** DEFER
- **Locations:**
  - `services/router/src/index.ts:9-17`
  - `packages/rabbitmq/src/broker.ts:144-146`
  - `packages/service-kit/src/plugins/providers.ts:19`
  - `packages/service-kit/src/plugins/shutdown.ts:24-35`

**Problem.** Broker.disconnect cancels only Queue-registered consumers, so the router's raw consumers are not cancelled. The channel closes while handlers are mid-publish, so republished-but-unacked messages are duplicated after the restart (mostly multi-target routes), late ack/nack calls throw (RTP-12), and the keepAlive publisher is never closed (RTP-03). service-kit runs all 'shutdown' listeners concurrently, together with the provider disconnect, so a router listener cannot be ordered before the provider disconnect.

**Evidence.** shutdown.ts: `Promise.all(shutdownCbs.map(...))` then `process.exit(0)`; providers.ts:19 registers disconnectAll as a 'shutdown' listener.

**Fix.**

Keep the consumer tags and an in-flight counter. Then either (a) add an ordered pre-shutdown/drain phase to service-kit (submodule), in which the router cancels its consumers, waits for in-flight handlers with a bounded timeout (e.g. 10 s) and closes the publisher; or (b) have the router create and own its consumer broker (keepAlive) and close both brokers in its own listener after draining. The ack/nack try/catch from RTP-12 lands now regardless.

**Tests to add.** The shutdown listener cancels the consumer tags, waits for an in-flight handler to finish, and closes the publisher before resolving.

**Verifier notes.** Lens A F18 confirmed low/defer. Lens A v1: the magnitude was overstated (single-target windows are tiny), and correct ordering is impossible without a service-kit change or the router owning its broker.

## Deferred — decisions needed

- **RTP-03** (The source is acked before the broker confirms the republish (no confirm channel, no mandatory flag, publisher never flushed or closed): messages are lost on a broker or connection fault): Which delivery guarantee should the router give: at-least-once with publisher confirms (needs a `confirm` option in @devvir/rabbitmq, plus mandatory/return handling and some throughput cost), or the current at-most-once on faults, documented as such? If at-least-once, will the rabbitmq submodule owner add confirm channels, or should the router own a confirm channel itself?
- **RTP-15** (Backpressure keeps up to prefetch deliveries unacked for the whole pause; RabbitMQ 3.12 consumer_timeout (30 min) then closes the consumer channel): While downstream queues are full, should the router stop consuming (cancel and re-consume, so no delivery is held), nack and requeue held deliveries periodically, or keep holding them under a raised consumer_timeout policy? And is maxReady a soft limit (overshoot of up to one prefetch is acceptable)?
- **RTP-16** (No poison-message policy: failures are requeued forever with no retry limit and no dead-lettering): What should happen to a message that keeps failing: dead-letter it (through a RabbitMQ policy, with an exchange or queue to be named), drop it after N retries, or keep retrying forever with backoff? Who owns the DLX and its consumers?
- **RTP-23** (Graceful shutdown neither cancels the raw consumers nor drains in-flight handlers, and never closes the publisher): Should service-kit gain an ordered pre-shutdown (drain) phase that runs before providers disconnect, or should the router stop using the provider broker and own both broker lifecycles? Decide together with RTP-02's follow-up and RTP-03.

Partially deferred (the bounded part is implemented now):
- **RTP-17**: (Upstream) Should @devvir/rabbitmq Exchange.republish preserve the original properties exactly, without the persistent/contentType defaults? That is the only way to keep a missing contentType missing.
- **RTP-21**: Should pipe reconcile its bindings (tag them with an argument such as x-declared-by=pipe and unbind tagged bindings that are no longer configured, through the management API, which needs credentials and a host), or stay additive with a documented manual cleanup? Note that adding the tag changes binding identity, so existing untagged bindings would not match.
- **RTP-22**: Should SKFactory accept an explicit RabbitMQ URL (so services can pass their sanitised config URL), or should sanitizeUrl be removed from service configs? This affects every service.

## Rejected

- **Production Dockerfile runs dist/index.js but tsc emits dist/src/index.js; package.json main is wrong; router compose omits the backpressure env (lens A F17, lens B F13)** — Already fixed in HEAD. docker/prod.node.Dockerfile now runs dist/src/index.js and the builder checks that the file exists (commit 96bb544, guarded by tests/entrypoints.test.ts); router and pipe package.json `main` is dist/src/index.js; services/router/docker/compose.yml passes ROUTER_MAX_READY and ROUTER_WATCH_QUEUES (commit e8c4612). Lens B v2 refuted it; I re-checked HEAD and confirmed the refutation, so it outweighs the earlier confirmations made against the pre-fix tree.
