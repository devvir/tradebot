# Replay module — Status & Roadmap

The replay module serves historical BitMEX data over BitMEX-identical WebSocket
and REST surfaces, driven by a data-internal clock, so a bot or the UI points at
it instead of BitMEX and replays history at high speed. No RabbitMQ — data is
pushed straight to clients.

```
MongoDB ─▶ librarian ─▶ provider ─▶ digger ─▶ ws + rest clients (bots, UI)
          (dump I/O)   (shaping)    (timeline)
```

This doc is the module-level map and the roadmap for what's left. Per-service
detail lives in the service docs.

---

## The three services (what they do today)

- **librarian** — generic dump reader/writer over MongoDB; owns the DB and
  swallows the BSON cost. Stateless, horizontally scalable.
  [docs/services/LIBRARIAN.md](../services/LIBRARIAN.md). *Done* (added a
  `before`/`order` descending read for reverse paging + cursor probes).
- **provider** — stateless shaping tier. Reads from librarian and serves data in
  the requested format, abstracting storage. *Done:* the **WS** surface
  (`/ws/:table`, `/ws/:table/partial`) and the **REST** surface (`/rest/:table` —
  historical / recent / state-reconstruction).
  [docs/services/PROVIDER.md](../services/PROVIDER.md).
- **digger** — synchronization + serving: the replay clock, the k-way merge, the
  WS server (subscriptions + slowest-client backpressure), the control API, and
  the REST surface (a pure pass-through to the provider). *Done:* the whole **WS**
  path, **REST**, and control. [docs/services/DIGGER.md](../services/DIGGER.md).

## Invariants (the rules everything obeys)

- **One data-driven clock.** It is the timestamp of the last message emitted on
  the shared stream; frozen when nothing is subscribed, advances as data flows.
- **One shared timeline.** The merge runs over the union of all subscriptions;
  each client gets its tables (symbol-filtered on egress); the **slowest client
  paces everyone** (per-socket `bufferedAmount`).
- **Partials and deltas are WS-only.** They do not exist in REST.
- **The snapshot accumulator is WS-only** — it serves warm partials to late
  subscribers, built by `@devvir/bitmex-database`, which produces the correct
  snapshot for every table kind (full / 1-per-symbol / active / empty). REST
  never touches it.
- **REST is records.** Paginated (or fixed, like chat) lists of items, served by
  the provider. Digger's REST is a pass-through; the provider owns all shaping.
- **Heavy lifting is upstream.** Distillers/assemblers materialize the expensive
  things; the provider does light shaping; digger only merges/paces/serves.

---

## REST — done (the model, for reference)

REST = records; **digger forwards** to the provider (resolves "now" = the clock as
a ceiling, passes the BitMEX params through, returns the array — no accumulator, no
filtering). The provider serves three strategies, by verified live-API semantics:

| Kind | Tables | Behaviour |
|---|---|---|
| historical | trade, quote, funding, settlement, insurance, tradeBin\*, quoteBin\* | honour `symbol`/`count`/`start`/`reverse`/`startTime`/`endTime` (`/trade?startTime=2020-01-01` → 2020 trades). |
| recent | chat, announcement | last `count` records, newest-first; no time filtering (chat default 100). |
| state | orderBookL2 (`symbol` required, `depth` default 25), instrument, liquidation | current row set reconstructed at the clock — last partial ≤ now + deltas through a use-and-throw `createTable`, returned as records (symbol-filtered, depth-limited). |

`/publicNotifications`, `/connected`, and the deferred order books have no BitMEX
REST endpoint. Verified against swagger.json + live API.

---

## Roadmap — remaining replay-module work

### 1. Authenticated endpoints

Private tables (order, position, execution, margin, wallet, …) in a **separate
database**, served by a **separate service** that stores/serves bot activity for
replay. Needs digger to **expose the clock** (the control `GET /clock` exists as
the hook) so that service aligns to the current replay time. Out of scope until
the public path is validated end-to-end.

### 2. UI integration

The UI env wiring is in place (`live` / `testnet` / `replay`): live/testnet hit
BitMEX WS direct + REST via the proxy (with `x-testnet`); **replay** routes to
digger's host-mapped ports (`/replay` → rest, `/replay-ws` → ws, `/replay-control`
→ control) via the Vite dev proxy. Remaining: run the module in conjunction and
validate replay mode in the browser (the manual end-to-end test).

### 3. Parked / open

- **`{action:1, _id:1}` index on orderBookL2/instrument** — speeds cold-start
  partial lookup; a distiller/farmer storage decision, only if cold-start latency
  is measured too slow (see PROVIDER.md).
- **Cold partial for the 1-per-symbol insert tables** (trade/quote/funding/…) is
  **empty** on first subscribe and fills from the stream — accepted (the provider
  synthesizes an empty partial rather than searching for one that isn't stored).
- **`orderBook10` / `orderBookL2_25`** — served empty until their distiller lands.
- **`tick` / `compositeIndex`** — skipped (deferred BitMEX surfaces).
