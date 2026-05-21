# Service-kit `Net` plugin

A single new service-kit plugin — `Net` — exposing two APIs, `service.servers` and
`service.clients`, that do for HTTP/WS endpoints and outbound connections what the
existing `providers` plugin does for databases and queues: declare them in the spec, get
a uniform handle anywhere in the service, and let the kit own the boilerplate
(bootstrapping, lifecycle, reconnection, retries, clean logs).

This describes the delivered plugin — its shipped APIs, defaults, and behaviour.

---

## 1 — Context

### 1.1 What service-kit gives us today

Service-kit assembles a `Service` object from three declarative inputs — `spec` (data),
`bindings` (`onEventName` handlers), `plugins` — and exposes it everywhere through a
global registry, so no module needs a reference passed down to it. A `Service` is an
`EventEmitter` (the event bus) carrying `config`, `state` (the `state` plugin),
`providers` (the `providers` plugin), and lifecycle (`health` + `shutdown` plugins, with
`created` / `started` / `complete` / `shutdown` events).

The `providers` plugin is the template this proposal copies:

- A **handler registry** — `registerProvider(name, type, handler)`, populated by
  side-effect imports. A handler is `{ validate, connect, disconnect, reconnect }`.
- **Spec-driven declaration** — `spec.providers: Record<string, ProviderSpec>`.
- **Plugin `init`** — validates configured providers (fail fast), wires per-name lifecycle
  events, builds the `service.providers` API, registers teardown on `shutdown`.
- **Lazy connect with retry** — `connect()` runs through `withRetry` (capped backoff) and
  emits `providerConnected` / `${name}Connected`.

The `Net` plugin mirrors this shape exactly. A reader who knows `providers` already knows
`servers` and `clients`.

### 1.2 The problem

The same server and client code is hand-written, slightly differently, in service after
service. §2 documents this from a survey of the actual codebase; it is the core
justification for the plugin and the source of its requirements. The short version:
~9 services hand-roll the same express server, 7 sites hand-roll the same fetch-retry
loop (each with its own bugs), 3 services hand-roll divergent WS reconnection loops, and
the one WS server is missing a heartbeat. The reconnection pile-up just fixed in
`broadcast/src/websocket.ts` — `error` and `close` both scheduling a reconnect, attempts
forking `2^n` — is the kind of bug this duplication breeds and hides.

### 1.3 Goal

Make "I need a WS client with reconnection" or "an HTTP server with routes" a
**declaration plus a handle**, not a from-scratch implementation. The good behaviour —
single-flight reconnect, capped backoff, `429` handling, retry policy, clean transition
logs, graceful drain on shutdown — becomes the default, owned in one place, fixed once.

---

## 2 — Requirements from the existing codebase

A survey of every server and outbound-client site in the monorepo. Each subsection lists
what is duplicated and what the plugin must therefore provide.

### 2.1 Fetch clients

Seven independent retry wrappers, each reinventing the same loop differently:

| Site | Retry | Backoff | Status policy | Down/up logging |
|---|---|---|---|---|
| `farmer/write/flush.ts` | forever | exp 1s→30s | throw on `!ok` | per-retry `warn` |
| `farmer/read/vault.ts` | forever | fixed 5s | 404 pass-through | `vaultDown` flag |
| `scribe/vault/store.ts` | forever | fixed 5s | 429/503 retry, 404→`{}` | per-retry log |
| `journalist/persistence/vault.ts` | returns `false` | shared `recoveryGate` | 409/418 drop, 429/503 distinct | `vaultDown` flag |
| `courier/download.ts` | forever / capped 5 | fixed 5s / exp | 404 skip, 409 skip | `vaultDown` flag |
| `tardy/vault.ts` | forever | exp 1s→30s, per-call | `passThrough[]` list | per-backoff log |
| `trader/rest/client.ts` | capped 3 | linear / `Retry-After` | 429 + `x-ratelimit-*`, 5xx, 404 stale | per-error log |

**The `fetch` client must provide:**

1. **Transition logging, built-in.** The "log *unreachable* once, *recovered* once"
   behaviour is hand-rolled as a `vaultDown` boolean in three services; the other four
   *spam* a line per retry attempt. This is the original broadcast complaint — "clean
   logs, not spam" — generalised. The client tracks per-target reachability and logs only
   the transitions, automatically (§7).
2. **Status-class policy as declarative config.** Every site hand-codes which statuses
   retry (429, 503, 5xx) and which pass through to the caller as non-errors (404, 409,
   418). Must be `retryOn` / `passThrough` lists with defaults.
3. **Retry shape: forever *or* capped**, with per-call backoff state (sharing module
   state across calls is the same bug class as the broadcast pile-up — `tardy` is the only
   site that gets this right).
4. **`429` first-class** — honour `Retry-After` / `x-ratelimit-reset`; proactively pause
   on low `x-ratelimit-remaining`.
5. **Stack-stripped error description** — pull `.cause.code` (`ECONNREFUSED`,
   `UND_ERR_BODY_TIMEOUT`, …), drop the trace. Reinvented in `farmer/read/vault.ts` and
   in the `websocket.ts` we just wrote.
6. **Per-request timeout** (`AbortController`).
7. **Not get in the way of streaming** — `courier` streams an S3 body into a vault `PUT`
   (`duplex: 'half'`); `farmer` streams an NDJSON response with `bodyTimeout: 0`. The
   client exposes the raw `Response` and accepts stream bodies. Mid-stream *resume*
   (`?skip=`) stays caller logic.
8. **A request-signing hook** — `trader` HMAC-signs every request; `proxy/bouncer.ts`
   adds a `Bearer` header. Auth is service-specific; the client provides the seam.

### 2.2 HTTP servers

Eight express servers (`vault`, `bouncer`, `registry`, `writer`, `digger`, `rest`,
`proxy`, `teller`). The recurring error middleware is a *partial, drifting* copy of one
block — each service handles a different subset of `ZodError → 400`,
`SyntaxError → 400` ("Invalid JSON"), `request.aborted → 499`, `entity.too.large → 413`,
`→ 500`, all guarded by `headersSent`.

**The `express` server kind must provide:**

1. **One complete default error handler**, written once — keying off *generic* signals
   only: an error's `status`/`statusCode` → that status; body-parser `SyntaxError` →
   `400`; `entity.too.large` → `413`; `request.aborted` → `499`; else → `500`. No
   validation-library coupling: a `ZodError` reaches `400` by carrying a `status` (set by
   whatever validated it — §10 Q1), not by the kit importing Zod.
2. **Body parsing as config** — `json` with a `limit` (services use 50mb, 32mb, default),
   `raw` (`proxy` needs raw bytes), or off.
3. **`createApp` / `startServer` split** — `bouncer`, `writer`, `registry` all split it so
   supertest can hit the app with no bound port. The handle exposes `.app`; tests skip
   `start()`.
4. **Request logging** (`rest` + `proxy` both add the same debug middleware) and
   **graceful `server.close()` on shutdown** (only `vault` does this correctly today).
5. **Bind-error fail-fast** (port in use) and **router mounting** at a base path
   (`digger` mounts two routers).
6. Hard-coded ports everywhere (`80`, `8000`, `3000`) → spec'd `port`.

`Bearer`-token auth and Zod validation recur (`bouncer`) — offered as built-in middleware
factories is an open question (§10 Q1).

### 2.3 WS server

One implementation — `ws/server/websocket.ts` + `ws/subs/clients.ts`. It hand-rolls a
client registry (per-client state + subscription set + `?api-key=` identity), a
`welcome()` greeting, JSON parse, `ping`→`pong`, op dispatch, and close/error→disconnect.
**It has no heartbeat / dead-connection sweep** — a gap `pingable: true` closes for free.

**The `ws` server kind must provide:** a client registry behind `handle.clients()`
(connected sockets, identity, subscription set), heartbeat + dead-connection sweep,
JSON-frame parsing with a `ping`→`pong` shortcut, op→command dispatch, connection
lifecycle hooks, `broadcast()`, and graceful close.

### 2.4 WS clients

Three divergent reconnect loops — `broadcast` (just fixed), `trader/source/ws.ts`,
`ui/WsClient.ts` — each subtly different, each carrying its own variant of the pile-up
risk. The fixed `broadcast` version is the reference implementation; the survey adds no
new requirements beyond confirming it.

### 2.5 Headline features the survey elevates

Three things the survey shows matter more than a feature list would suggest:

- **Down/up transition logging** — reinvented or botched in 5 of 7 fetch sites. The
  literal generalisation of the task that started this work. Built-in (§7).
- **Status-class policy** (`retryOn` / `passThrough`) — the single most-varied thing
  across fetch sites. Declarative config.
- **The complete express error handler** — eight partial copies collapse to one.

---

## 3 — Design principles

1. **Mirror `providers`.** Same handler-registry, spec-driven declaration,
   `validate`-on-init fail-fast, per-name lifecycle events, everywhere-access.
2. **Sane defaults, less code.** A declaration with nothing but a port (server) or URL
   (client) produces something production-grade. Defaults are chosen wherever there is a
   clear winner among the use cases in §2.
3. **Cumulative, imperative wiring.** Route and command handlers are registered on the
   *handle*, imperatively — not because functions are barred from the spec (they are not),
   but because handlers are *cumulative*: they come from many modules and call sites,
   which a single `declare()` cannot express.
4. **Spec bootstraps; the API completes.** The spec carries stable config in one place;
   the runtime API adds routes, brings things up, and creates transient/pooled instances.
   Spec-only, runtime-only, and hybrid are all first-class (§9).
5. **Explicit `start()`; automatic teardown.** Bringing a server or stateful client up is
   an explicit call after registration. Teardown is automatic on `shutdown`.
6. **Escape hatches everywhere.** The handle always exposes the underlying object (the
   express `app`, the `WebSocketServer`, the raw `Response`/`ws`).
7. **All optional.** Like everything in SK — if it does not help, ignore it and do it
   yourself.
8. **One plugin, inert until used.** `servers` and `clients` ship as a single default
   plugin, `Net`. With nothing declared its `init` does nothing beyond wiring the (empty)
   APIs; the only thing that can fail is validation of a spec that *is* declared, and that
   fails fast at boot — never a surprise later. So `Net` is added repo-wide in one line
   and then adopted service by service.
9. **Familiar surface, augmented.** A handle mirrors the well-known names and signatures
   of what it wraps — the `fetch` client's init `extends RequestInit` (standard fields
   forwarded verbatim, a real `Response` returned); the `ws` client keeps `on()` /
   `send()` / `close()`. A newcomer uses the handle like the native client and gets
   retries, reconnection, and base URL for free. Done by explicit mirroring, not a
   transparent `Proxy`: the `ws` client replaces its socket on every reconnect, so a
   Proxy would bind callers to a stale instance. The raw object (`.app`, `.server`, the
   `Response`) is always one property away for the genuine long tail.
10. **Generic, not monorepo-coupled.** Service-kit ships as a standalone npm library. The
    §2 survey is *evidence* for generic features — never a license to bake in tradebot or
    BitMEX shapes. Anything protocol- or service-specific is a caller-supplied seam: the
    `sign` hook (§6.1), the opaque payload handed to `sendOnOpen` (the kit never inspects
    it), a validator the caller chooses (§10 Q1). The kit assumes only what holds for
    *every* Node HTTP/WS server and client.

---

## 4 — The spec model

`servers` and `clients` each accept a **single spec object or an array** of them. Each
spec is `{ name?, type, ...config }`:

```ts
SK.declare({
  servers: { type: 'express', port: 8000 },          // one → name defaults to 'express'

  clients: [                                         // many → array
    { name: 'bitmex',  type: 'ws', url: () => signWsUrl(realtimeUrl) },
    { name: 'bouncer', url: 'http://bouncer' },       // type inferred from scheme → fetch
  ],
});
```

- **`name` defaults to `type`.** With one server you omit it entirely. Two of the same
  type without explicit names collide on `name` — caught by the same duplicate-name check
  the registry already does, no special handling.
- **`type`** selects the handler. Server types: `express` (default), `ws`. Client types:
  `fetch`, `ws` — **inferred from the URL scheme** (`ws(s)://`→`ws`, `http(s)://`→`fetch`)
  when omitted; an explicit `type` always wins.
- **Spec carries config, not handlers.** `SK.declare()` rejects *top-level* spec fields
  that are functions — those are event handlers and belong in `bindings`. Nested config
  values may be functions where a function *is* the config — the `url` factory above, or
  the `sign` hook (§6.1). Route/command handlers still never go in the spec, for the
  cumulative reason in §3.

### 4.1 Defaults

| | Option | Default | Notes |
|---|---|---|---|
| `express` | `type` / `name` | `'express'` / `=type` | |
| | `port` | `NET_DEFAULT_PORT` env, else `80` | overridable host-wide — §4.2 |
| | `json` | `true` | `{ limit }` to size it; `false` or `raw: true` to opt out |
| | `basePath` | `''` | prefixes every route |
| | `pingable` | `true` | mounts `GET /ping` → `200` |
| | `rateLimit` | `null` | string `'60/m'` or `{ max, unit, rolling }` — §4.3 |
| `ws` (server) | `port` | `NET_DEFAULT_PORT` env, else `80` | §4.2 |
| | `pingable` | `true` | heartbeat + dead-connection sweep + `ping`→`pong` |
| `fetch` | `retry` | retry **forever**, capped exponential backoff | retries network errors + `retryOn` statuses; transition-logged so "forever" is never silent. `attempts: N` to cap |
| | `retryOn` | `[429, 502, 503, 504]` | + all network errors |
| | `passThrough` | `[]` | statuses returned to the caller as non-errors |
| | `timeout` | `30_000` (30s) | per request; skipped for streaming-body requests |
| `ws` (client) | `reconnect` | on, single-flight, capped exponential | the `broadcast` behaviour (§6.2) |
| | `heartbeat` | `30_000` | |

### 4.2 Default server port

`80` is the *default default* — with it, container-internal URLs need no `:port`. Some
hosts, though, disallow low ports even for a container's own internal port, so the
default itself is overridable. A server's port resolves in precedence order:
explicit `spec.port` → `NET_DEFAULT_PORT` (env var) → `80`.

A host that bans low ports sets `NET_DEFAULT_PORT=8000` once in its environment, and every
server that does not name an explicit port follows — no per-service code change. The
plugin holds `80` as a single fallback constant; it is never hardcoded per server.
`broadcast`'s command server is exactly this case: today it hardcodes port `8000` only
because it deploys to a remote that disallows low ports. Under the plugin it declares no
port — that remote sets `NET_DEFAULT_PORT=8000` and broadcast follows. An explicit
`spec.port` is then only for a server that needs a *particular* port — chiefly a service
exposing two HTTP servers, where the second cannot also take the default.

The default lives in the environment, not in `skDefaults` or a spec field, because which
ports a host permits is a deployment fact, not application config.

### 4.3 The `rateLimit` option

Two forms; `null` (the default) disables it entirely.

- **String — `'<max>/<unit>'`.** The terse common case: `'60/m'`, `'10/s'`, `'1000/h'`,
  `'5/d'`. A **fixed window** — the count resets on each window boundary, i.e.
  `rolling: false`.
- **Object — `{ max, unit, rolling? }`.** The explicit form. `max` (number) and `unit`
  (`'d' | 'h' | 'm' | 's'`) are required; `rolling` defaults to `false`. This is the only
  way to get a **rolling window** (`rolling: true`) — a sliding trailing window with no
  burst at the boundary, at the cost of per-request timestamp tracking.

On an `express` server it is request-rate middleware; on a `ws` server it caps inbound
messages per client.

### 4.4 Templates

A spec entry marked `template: true` is **registered as a named template, not started**.
The plugin does not instantiate it — no port bound, no connection dialed — it records the
config under its `name` for later use. This keeps the static config of a pooled
server/client in `service.ts` alongside every other spec, instead of scattered through the
service as inline objects, and says outright "this is not something we start — it is a
shape we spawn instances from."

```ts
clients: { name: 'bitmex', template: true, type: 'ws', heartbeat: 30_000 },
```

Instances are minted from a template with `clone(name, overrides?)` — the `overrides`
partial spec is merged over the template, supplying whatever it intentionally left out (a
per-instance `url`) and, optionally, the instance `name` (auto-generated from the template
name otherwise):

```ts
service.clients.clone('bitmex', { name: `bitmex:${id}`, url: () => sign(acct) });
```

`create()` is the same operation over an *implicit* template — the kind's defaults and
nothing else. `create(spec)` is `clone` of that defaults-only template with `spec` as the
overrides; `clone(name, …)` only swaps the implicit base for a declared one. One primitive
— instantiate from a template with overrides — spelled two ways: `create` when the base is
just defaults, `clone` when it is a named template.

Because a template is deliberately incomplete, it is only **partially validated at boot**
(present fields well-typed, `type` valid); the **full** validation — required fields, URL
scheme — runs on each `clone()`, against the merged concrete spec. `clone()` targets
template entries only; `clone()` of a non-template name, or `get()` of a template name,
throws.

---

## 5 — The `servers` API

`service.servers` API:

```ts
interface ServersAPI {
  get(name?): ServerHandle;                // no arg → the sole server; throws if ambiguous
  create(spec?, routes?): ServerHandle;    // runtime; spec optional (→ defaults), type string, or object
  clone(name, overrides?): ServerHandle;   // instantiate from a `template: true` spec entry
  all(): ServerHandle[];
  has(name): boolean;
}
```

Handlers register via `registerServer(kind, handler)`, mirroring `registerProvider`. A
handler is `{ validate, create }`; `create` is called at plugin `init` and returns the
handle immediately — the handle accepts route/command registration straight away, but no
socket is bound until `start()`.

### 5.1 The `express` server handle

```ts
interface ExpressServerHandle {
  addRoutes(routes): this;                       // cumulative — a Router, an (app)=>void builder, or an array of those
  addRoute(method, path, ...handlers): this;     // cumulative — single route
  use(...middleware): this;                      // cumulative
  mount(basePath, router): this;
  setBase(path): this;

  start(): Promise<this>;     // bind the port, begin accepting
  stop(): Promise<this>;      // graceful drain (server.close), reusable afterwards
  dispose(): Promise<void>;   // stop + drop from the registry (terminal)
  isUp(): boolean;  isDown(): boolean;
  readonly status: 'down' | 'starting' | 'up' | 'closing';

  configure(partialSpec): this;  // throws if called while up — stop() first
  readonly app: express.Application;      // escape hatch
  readonly server: http.Server | null;    // escape hatch — null until start()
}
```

Built in, on by default: `express.json()` body parsing (`json` option; `raw: true`
switches to raw-bytes parsing, for a proxy), request logging through `service.logger`, the
`/ping` route (`pingable`), `rateLimit` middleware, the complete error handler (§5.3)
appended at `start()`, graceful `server.close()` on `shutdown`, and bind-error fail-fast.
`tls: { cert, key }` upgrades the listener to HTTPS in place — there is no separate
`https` type. `requestTimeout` / `headersTimeout` set the Node `http.Server` deadlines
(`0` disables either — for an endpoint that receives large streamed uploads).

### 5.2 The `ws` server handle

```ts
interface WsServerHandle {
  addCommands(commands): this;          // cumulative — { subscribe: fn, unsubscribe: fn, ... }
  addCommand(op, handler): this;
  onConnect(handler): this;             // per-connection setup (e.g. read ?api-key=)
  onDisconnect(handler): this;
  onMessage(handler): this;             // raw frames, for non-op protocols

  broadcast(data): void;
  clients(): Iterable<ClientInfo>;      // the built-in registry: socket, identity, subscriptions

  start(): Promise<this>;  stop(): Promise<this>;  dispose(): Promise<void>;
  isUp(): boolean;  isDown(): boolean;
  configure(partialSpec): this;         // throws while up
  readonly server: WebSocketServer;     // escape hatch
}
```

Built in: heartbeat ping/pong with a dead-connection sweep, JSON parse with a `ping`→`pong`
text shortcut, the client registry, per-client error isolation, op→command dispatch, and
graceful close-all on `shutdown`.

### 5.3 The built-in error handler

Appended automatically at `start()`, this is the one place the §2.2 block lives. It keys
off **generic signals only** — never a validation library: an error carrying
`status`/`statusCode` → that status; `SyntaxError`/body-parser → `400` ("Invalid JSON
body"); `entity.too.large` → `413`; `request.aborted` → `499`; anything else → `500`
logged via `service.logger`. Every branch is guarded by `headersSent`. A `ZodError` (or
any validator's error) reaches `400` because the validation middleware that produced it
attaches `status: 400` — see §10 Q1. A service that wants different behaviour appends its
own handler via `use()`.

---

## 6 — The `clients` API

`service.clients` API — the same shape as `ServersAPI`: `get(name?)`, `create(spec?)`,
`clone(name, overrides?)`, `all()`, `has(name)`. Handlers register via
`registerClient(kind, handler)`.

### 6.1 The `fetch` client handle

```ts
interface FetchClientHandle {
  get<T>(path, opts?): Promise<T | null>;      // + post / put / patch / delete
  request(input, init?): Promise<Response>;    // exact fetch() signature; init extends RequestInit
  configure(partialSpec): this;                // stateless — always allowed
  dispose(): void;
}
```

Configuration: `url` (base URL), default `headers`, `timeout`, `retry` (forever or capped,
capped exponential backoff), `retryOn` / `passThrough` status lists, and outbound auth.

Auth has two tiers. **Well-known schemes are pure spec, no callback** — `auth: { bearer }`,
`auth: { basic: { user, pass } }`, `auth: { apiKey: { header, value } }` — the kit
attaches the header (the `ws` client takes the same `auth` on its upgrade request).
Anything bespoke uses the **`sign?: (req) => headers`** hook. HMAC request signing
(api-key + expires + signature) stays a hook on purpose: the concept is common but the
recipe — what is concatenated, the hash, the header names — is per-API, not a standard, so
a spec form would bake in one vendor's scheme. Tradebot factors its BitMEX recipe into one
shared `sign` helper reused by every service — the recipe lives once, the kit stays generic.

**Return shape** (decided): `get<T>()` and friends resolve to **parsed JSON** on a 2xx;
resolve to **`null`** on a `passThrough` status; **retry** on a `retryOn` status or
network error; **throw** on any other non-2xx.

`request(input, init)` carries the exact Node `fetch` signature, and `init` **extends
`RequestInit`** — `method`, `headers`, `body`, `signal`, and the rest are forwarded
verbatim; the client only intercepts its own additions (`retry`, `passThrough`,
base-URL-relative paths) and returns a real `Response`. A newcomer uses it exactly like
`fetch`, with retries and `baseUrl` as a free bonus (§3.9) — `get<T>()` and friends are
the augmented sugar on top.

Built-in behaviour, all from §2.1: capped or uncapped retry with per-request backoff
state; `429` handling that honours `Retry-After` and `x-ratelimit-reset`; transition
logging (§7); stack-stripped error descriptions; and a per-request `AbortController`
timeout, skipped for streaming-body uploads. Proactive pacing on low
`x-ratelimit-remaining` is not built — retry is reactive to the `429` itself.

### 6.2 The `ws` client handle — the `broadcast` reference

This is the fixed `broadcast/src/websocket.ts` reconnection work, promoted to a reusable
handler. Nothing in `broadcast`, `trader`, or `ui` hand-rolls this loop again.

```ts
interface WsClientHandle {
  start(): Promise<this>;          // dial; resolves on first open
  stop(): this;                    // close, stop reconnecting; reusable
  dispose(): void;                 // stop + drop from registry (terminal)

  send(data): void;
  sendOnOpen(message | message[]): { stop(): void };  // one or many; (re)sent on every open
  onMessage(handler): this;
  on(event, handler): this;        // lifecycle events + any native ws event — durable across reconnects
  off(event, handler): this;

  isUp(): boolean;  isDown(): boolean;
  readonly status: 'down' | 'connecting' | 'open' | 'reconnecting';
  readonly socket: WebSocket | null;   // the current raw socket — escape hatch
  configure(partialSpec): this;    // throws while up
}
```

Built-in behaviour, lifted from the fixed `broadcast` implementation:

- **Single-flight reconnect** — `error` + `close` (and repeats during an outage) collapse
  into exactly one in-flight attempt. Attempts never pile up.
- **Capped exponential backoff**, per-connection, reset on a successful open.
- **`429` and known statuses** jump straight to the backoff cap.
- **Classified, transition-aware logs** (§7) — known network failures log one concise
  `warn`; unknown errors log with a stack.
- **Heartbeat** ping/pong; **re-establish state on reconnect** — messages registered with
  `sendOnOpen()` are re-sent once each replacement connection opens; `on('open', …)` is
  the durable hook for anything more involved.
- **Shutdown-aware** — stops reconnecting once the service is shutting down.

`on()`, `send()`, and `close()` mirror the native `ws` API — `on()` takes any `ws` event
(`message`, `ping`, `pong`, …) on top of the lifecycle events above. The difference: they
are **durable**, re-applied to each replacement socket, so a newcomer writes
`on('message', …)` as usual and reconnection stays transparent (§3.9).

The `url` may be a **factory** `() => string | Promise<string>`, re-invoked on every
(re)connect — this is what carries freshly-signed, expiring credentials (`broadcast`'s
per-connection signed URL).

---

## 7 — Shared foundations

### 7.1 Backoff

`providers/retry.ts` already implements `RetryConfig`, `withRetry`, and `computeDelay` —
none of it provider-specific. It moves to `src/support/` and backs `providers` and `Net`.
`withRetry` (a promise-retry loop) fits the `fetch` client and `providers.connect()`. The
event-driven WS reconnection needs the backoff math without the loop, so a small cursor
is extracted alongside it:

```ts
class Backoff {
  constructor(config: RetryConfig) {}
  next(): number;   // delay for the next attempt; advances + caps
  peek(): number;   // what next() would return, without advancing
  reset(): void;    // back to the floor — call on a successful open
  toCap(): void;    // fast-forward to the cap — used after a 429
}
```

`Backoff` backs the WS client and server; `withRetry` is reimplemented on top of it, so
there is exactly one definition of capped exponential backoff in the kit.

### 7.2 Reachability logging

The headline fix from §2.5. A shared helper tracks, per client/connection, whether the
target is currently reachable:

- **Down** — the first failed attempt after a healthy state logs **one** concise `warn`
  ("`X` unreachable — retrying").
- **Still down** — retries can run for hours, so a single periodic reminder (roughly once
  a minute, not configurable) reports that `X` is still unreachable and for how long.
  Enough to confirm the service is alive and trying; never per-retry spam.
- **Up** — the first success after failure logs **one** `info` ("`X` recovered"), which
  also clears the periodic reminder.

This replaces the `vaultDown` boolean hand-rolled in three services and the per-retry spam
in the rest, and generalises the clean-logs requirement that started this work. It pairs
with a shared `describeError` (strip the stack, surface `.cause.code`).

---

## 8 — Lifecycle, events, everywhere-access

The plugin `init` builds the handles from the spec, validates every configured
server/client (fail fast at boot), and registers one `shutdown` listener that `stop()`s
all of them in reverse creation order.

Lifecycle is observed **on the handle**, not the service bus. The `ws` client emits
`open`, `close`, `error`, `reconnecting`, `ping`, `pong`, and `message` on itself —
`on('reconnecting', …)` is the reconnect hook, `on('open', …)` the durable
re-establish hook. Reachability transitions are logged automatically (§7.2). The plugin
emits no `serverUp` / `clientConnected` events on the service bus; a service that wants
them re-emits from a handle listener.

The plugin adds **no registry integration of its own**. The `Service` interface is
augmented (via `declare module`, as every plugin does) with `servers: ServersAPI` and
`clients: ClientsAPI`, so everywhere-access comes for free from the existing registry:
`registry.get('broadcast').servers.get('command')` reaches a server from any module, with
no new registry symbols and no plugin code.

---

## 9 — Usage

### 9.1 Spec-based — single server, zero ceremony

```ts
SK.declare({ servers: { type: 'express', port: 8000 } });

SK.run(async (service) => {
  await service.servers.get().addRoutes(routes).start();  // get() → the sole server
});
```

Reconnection, the error handler, `/ping`, JSON parsing, request logging, graceful
shutdown — all already on.

### 9.2 Runtime-based — no spec

```ts
SK.run(async (service) => {
  const api = service.servers.create('express', routes);  // type string + routes
  await api.start();

  const ws = service.clients.create({ type: 'ws', url: signedUrl });
  ws.onMessage(handler);
  await ws.start();
});
```

`create(spec?, routes?)` — `spec` is optional (omitted → all defaults), a bare type
string, or a full spec object. To mint from a declared template instead, use
`clone(name, overrides?)` (§9.3). Either way, an omitted instance `name` is auto-assigned
a unique one (`express#2`).

### 9.3 Hybrid — spec bootstraps, runtime completes (incl. pools)

```ts
SK.declare({
  servers: { name: 'api', type: 'express', rateLimit: '60/m' },
  clients: { name: 'bitmex', template: true, type: 'ws', heartbeat: 30_000 },
});

SK.run(async (service) => {
  const api = service.servers.get('api');
  api.addRoutes(baseRoutes);
  api.addRoutes(adminRoutes);          // cumulative — different module, same handle
  await api.start();

  // the always-on guest feed — the template plus a plain url
  await service.clients.clone('bitmex', { name: 'guest', url: guestUrl })
    .onMessage(onMessage)
    .start();

  // pool: authenticated feeds cloned from the same template, on demand
  const openAccount = (acct) =>
    service.clients
      .clone('bitmex', { name: `bitmex:${acct.id}`, url: () => signWsUrl(realtimeUrl, acct.creds) })
      .onMessage(onMessage)
      .start();

  // credentials expired → reconfigure in place
  const refresh = (acct) => {
    const c = service.clients.get(`bitmex:${acct.id}`);

    c.stop();
    c.configure({ url: () => signWsUrl(realtimeUrl, acct.fresh()) });

    return c.start();
  };

  const closeAccount = (acct) => service.clients.get(`bitmex:${acct.id}`).dispose();
});
```

That is the whole `broadcast` story — every bitmex connection (`heartbeat`, backoff, …)
defined *once* as the `bitmex` template in the spec, then cloned: the always-on guest with
a plain `url`, the per-account feeds with a re-signing `url` factory. `configure()` swaps
expiring credentials; `sendOnOpen()` messages survive reconnects. The pool *keying*
(`bitmex:${id}`) stays in `broadcast`; the kit owns each connection.

### 9.4 Before / after

**Broadcast's command server** — `commands/server.ts` (~57 lines) + `index.ts` wiring +
a hard-coded port constant, all replaced by:

```ts
SK.declare({ servers: { name: 'command', type: 'express' } });  // port: NET_DEFAULT_PORT on the remote, else 80

SK.run(async (service) => {
  await service.servers.get('command')
    .addRoutes([subscribeRoute, resubscribeRoute, unsubscribeRoute])
    .start();
});
```

**Broadcast's WS client** — `websocket.ts` (~150 lines) + `pool.ts` reconnection wiring,
replaced by the `clients` declaration in §9.3. The single-flight reconnect, capped
backoff, `429` handling, heartbeat, error classification, and re-establish-on-reconnect
logic all move into the kit — written once, fixed once.

---

## 10 — Decisions

Settled and shipped: a single default plugin, `Net` (§3.8); fetch retry defaults to
forever (§4.1); `configure()` throws while up for stateful kinds (§5.1); client `type` is
inferred from the URL scheme (§4); WS server commands are direct `addCommand` handlers,
with no service-bus op events; the `auth` schemes (`bearer` / `basic` / `apiKey`) ship for
both client kinds alongside the `sign` hook (§6.1); `SKFactory` forwards the `servers` /
`clients` spec fields straight through, with no shortcut sugar.

Deferred — not built this round:

- **Server-side `auth` / `validate` middleware.** Outbound `auth` shipped for clients;
  server-side bearer-auth and schema validation did not. A server adds its own via
  `use()` / `addRoutes()`. A Standard-Schema-based `validate` — library-agnostic, no kit
  dependency — remains a clean future addition.
- **Health-plugin convergence.** The `health` plugin still runs its own bare
  `http.createServer`; folding `/health` onto a declared `express` server when one exists
  is the §11 phase 7 follow-up.

---

## 11 — Implementation phases

Phases 1–6 are complete — the plugin and all four kinds (`express` / `ws` servers,
`fetch` / `ws` clients) are built and tested. Phase 7 remains.

1. **Shared backoff.** Move `retry.ts` to `src/support/`, add `Backoff`, repoint
   `providers`. Pure refactor — existing provider tests stay green.
2. **`Net` plugin skeleton.** Handler registries (`registerServer` / `registerClient`),
   the `service.servers` / `service.clients` APIs, spec validation, and lifecycle wiring.
   Add `Net` to `skDefaults.plugins` — inert until something is declared, so it lands
   without touching any service.
3. **`clients` — `ws` kind.** Build the managed WS client from the fixed
   `broadcast/src/websocket.ts`. Migrate `broadcast` as the proving ground, then `trader`
   and `ui`.
4. **`clients` — `fetch` kind.** Build it from the §2.1 requirements (reachability
   logging, status policy, `429`). Migrate the vault clients (`farmer`, `scribe`,
   `journalist`, `courier`, `tardy`) and `trader`, then ad-hoc `fetch` sites opportunistically.
5. **`servers` — `express` kind.** Migrate the simplest first (`writer`, `registry`),
   then the rest.
6. **`servers` — `ws` kind.** Migrate the `ws` service; add the heartbeat it lacks.
7. **Follow-up.** Fold the `health` plugin onto the `express` server kind — it currently
   runs its own bare `http.createServer`; it should mount `/health` on a declared server
   when one exists.

---

## 12 — Deferred refinements

Recorded for after the §11 plan is fully implemented — not blocking, not in scope now.

- **Generic WS request/response.** A `ws` client is fire-and-forget today (`send` /
  `sendOnOpen` / `onMessage`); protocols with a reply (`ping`→`pong`, `subscribe`→ack,
  `msg`→echo) re-correlate in caller code (e.g. broadcast's `waitForSubscription`). If a
  genuinely generic correlation seam emerges, add it then.
- **Unified reachability logging.** §7.2's down / still-down / recovered should be a
  single noiseless model; and for a *pool* of clients to one host it should collapse to
  per-host rather than per-client. Revisit as one pass over all three states.
