# Review: stub-ui (services/_stub/ui)

## Overall assessment

The stub UI (services/_stub/ui) is small and readable. It has a sensible data layer (BitmexClient/WsClient/DataProvider) and nothing renders unsafely: venue data reaches the DOM only through React text nodes and canvas, symbols are encoded by URLSearchParams/JSON.stringify, and nothing uses dangerouslySetInnerHTML. The serious problems are logic bugs in the chart candle buffer (SUI-01, SUI-03..SUI-05), WsClient socket ownership under StrictMode (SUI-06), the running candle (SUI-07), recent trades and orderbook totals. Tests pass (20 files, 138 tests, 82.7% lines, 67.4% branches) but the riskiest code (useClosedCandles WS/REST hook paths, ChartCanvas gestures, WsClient close/reconnect ordering) has little or no coverage, and several assertions are weak. Documentation is largely untrue today: the README and docs/services/UI.md describe modules, hooks, env vars (VITE_*), a `tb up gui/bitmex` module, MongoDB/digger/`proxy` backends and a 'Current State' that do not exist; several docblocks describe retired services, explain providers by their consumers, or contain plans (CLAUDE.md violations). compose passes UI_REPLAY_HOST while vite.config.ts reads UI_DIGGER_HOST. Bigger picture: the whole unit is wired to BitMEX live/testnet plus the digger replay backend, all of which docs/DATA_PIPELINE.md (lines ~67-71, 152-154) records as gone, so as shipped no environment can produce data. Before implementing the missing functionality the owner should decide what this UI talks to, then replace the BITMEX_* constants and the digger-specific DiggerClient/ReplayClock with a single env-driven source config (SUI-11, SUI-24). Restructuring recommendation for the chart: SUI-01/03/04/05 share one root cause - a single trimmed array holds both the live tail and the history window, and fetching is driven by viewport changes. Split it into a live-tail segment (WS-maintained, never trimmed, tracked by a liveTailMs) and a history window loaded by a small range-loader state machine (one request in flight, re-evaluates need after each merge, replaces the window on a disjoint jump). Implement those four items together. Also extract useRunningCandle's rAF batching into a shared useFrameBatchedState hook when SUI-23 is picked up. The Header copies BitMEX's logo, class names and Login/Sign Up links; harmless (links go to the real site, no credentials collected) but worth replacing with neutral branding. All reviewer repros are scratch tests under reviews/2026-11/units/scratch/stubui/ (ws.test.ts, closed.test.tsx, trades.test.tsx, v2closed.test.tsx); coverage reports in reviews/2026-11/units/scratch/cov-stub-ui/ and cov-stub-ui-verify/.

## Summary

| ID | Severity | Category | Decision | Title |
|---|---|---|---|---|
| SUI-01 | high | correctness | IMPLEMENT | Browsing history: each new live tradeBin insert is treated as a gap and wipes the whole candle buffer |
| SUI-02 | medium | docs | IMPLEMENT | README and docs/services/UI.md describe an architecture, commands and env vars that do not exist |
| SUI-03 | medium | correctness | IMPLEMENT | After trimming, a short forward pan snaps to 'live' and shows stale history as live; live mode never checks the right edge |
| SUI-04 | medium | correctness | IMPLEMENT | REST pagination issues at most one page per viewport change, so fast pans leave the window under-filled |
| SUI-05 | medium | efficiency | IMPLEMENT | Every wheel/pointer-move event re-runs the REST effect, cancelling the in-flight page and issuing a new request |
| SUI-06 | medium | correctness | IMPLEMENT | WsClient handlers act on the current socket, not the one that fired them; destroy() leaves the reconnect timer and `connected` set |
| SUI-07 | medium | correctness | IMPLEMENT | Running candle drops the first trades of each new bin, and on 1h/1d only counts trades seen since page load |
| SUI-08 | medium | testing | IMPLEMENT | Core chart buffer logic (useClosedCandles hook: WS insert handling, REST lifecycle) has no hook-level tests |
| SUI-09 | medium | testing | IMPLEMENT | WsClient tests use a WebSocket double that hides real ordering; backoff, resubscribe and onerror are untested |
| SUI-10 | medium | testing | IMPLEMENT | ChartCanvas gestures, hover and resize are untested (42% lines); the ResizeObserver stub means draw() never runs |
| SUI-11 | medium | config | DEFER | Data sources are hard-wired to BitMEX and the digger replay backend, none of which exist; no environment can produce data |
| SUI-12 | low | docs | IMPLEMENT | Stale, wrong or rule-breaking docblocks, config comments, and the UI_REPLAY_HOST/UI_DIGGER_HOST name mismatch |
| SUI-13 | low | correctness | IMPLEMENT | useRecentTrades: the REST page overwrites WS trades that arrived first |
| SUI-14 | low | robustness | IMPLEMENT | Persisted env is trusted without validation: unknown value white-screens the app; 'replay' sticks when replay is disabled |
| SUI-15 | low | correctness | IMPLEMENT | WsClient sends a duplicate subscribe op when a second listener joins an already-subscribed channel |
| SUI-16 | low | correctness | IMPLEMENT | Orderbook 'Total' accumulates from the far end of the book; dead StackedLayout orders the bid ladder wrongly |
| SUI-17 | low | correctness | IMPLEMENT | Hovered candle is a stale snapshot: OHLC readout freezes on the running candle and drifts when the slice shifts |
| SUI-18 | low | correctness | IMPLEMENT | Pan speed uses candlesPerView while the renderer spaces by candles.length; leaving live mode jumps two candles |
| SUI-19 | low | correctness | IMPLEMENT | Hard-coded one-decimal price formatting; axis labels duplicate for small steps; daily candles labelled with their close date |
| SUI-20 | low | code-quality | IMPLEMENT | Dead code and unused exports, partly hidden by a knip config that ignores .tsx files |
| SUI-21 | low | code-quality | IMPLEMENT | Duplicated helpers/constants across widgets, raw unguarded localStorage in WidgetGrid, misc small quality issues |
| SUI-22 | low | testing | IMPLEMENT | Several tests assert too loosely or are mislabelled (ChartWidget OHLC, renderer call counts) |
| SUI-23 | low | efficiency | DEFER | Orderbook and Recent Trades re-render on every WS message with no frame batching |
| SUI-24 | low | correctness | DEFER | ReplayClock: set-clock fires on every partial edit, parses local time while the chart shows UTC, widgets keep pre-seek state |
| SUI-25 | low | robustness | DEFER | Fabricated market figures and an always-on 'Online' indicator beside live data; fetch failures are invisible |
| SUI-26 | low | security | DEFER | Vite dev server published on all interfaces with the whole monorepo mounted |

Suggested implementation grouping: chart buffer (SUI-01, 03, 04, 05, 08 together); WsClient (SUI-06, 09, 15 together); docs (SUI-02, 12 together, after or aligned with the SUI-11/24 replay decision).

## SUI-01: Browsing history: each new live tradeBin insert is treated as a gap and wipes the whole candle buffer

- Severity: high
- Category: correctness
- Decision: IMPLEMENT
- Source finding: F2
- Locations:
  - `services/_stub/ui/src/widgets/Chart/useClosedCandles.ts:80-101`
  - `services/_stub/ui/src/widgets/Chart/useClosedCandles.ts:240-263`

**Problem.** Gap detection compares each tradeBin insert with the buffer's last candle. In anchored mode, once the buffer exceeds max(4*cpv, 200), trimBuffer keeps only [anchor-1.5*cpv, anchor+0.5*cpv], so the tail is no longer the live edge. Every following live insert (each bin close; each minute on 1m) fails `actualMs !== lastMs + binMs`, so the hook sets the buffer to [], bumps fetchKey and refetches the same anchored window, whose tail is again in the past. The chart blanks and reloads 160 candles once per bin for as long as the user stays in history.

**Evidence.** Two independent scratch repros (scratch/stubui/closed.test.tsx and v2closed.test.tsx): 'anchored buffer len 161 tail lag 360 fetches 5' -> one insert -> 'buffer len 0' -> 'fetches 6 len 160'; second repro: three consecutive inserts each give len 0, a reload and one extra fetch (12, 13, 14). The handler path (useClosedCandles.ts:68-114) has 0% coverage.

**Fix.** Implement together with SUI-03/04/05 (see restructuring note). Add `liveTailRef = useRef<number|null>(null)`: set it to the newest bin ms after any fetch issued with `endTime === null` and after each accepted insert; reset to null in the symbol/timeframe reset effect and on a wipe. In the insert handler run the existing duplicate/contiguous/gap logic only when the buffer's last candle ms === liveTailRef. Otherwise (tail trimmed or anchored away from live, or liveTailRef null) only record the insert timestamp in liveTailRef; never merge into a non-live tail and never wipe. Simpler acceptable alternative: return early from the insert handler while `viewportRef.current.rightAnchor !== null`, and rely on SUI-03's live-branch staleness check to refetch the right edge on goLive.

**Tests to add.** renderHook + tests/helpers/fakeBitmex.tsx with a fake REST returning contiguous bins for (count, endTime): (1) pan back until trimming happens, emit insert at NOW+1 bin -> buffer unchanged, fetch count unchanged; (2) live mode contiguous insert -> appended; (3) live duplicate -> ignored, no fetch; (4) live gap insert -> wipe and exactly one refetch; (5) anchored+trimmed then goLive -> fetch with no endTime and tail at live edge.

**Verifier notes.** Both verifiers confirmed at high severity and reproduced independently.

## SUI-02: README and docs/services/UI.md describe an architecture, commands and env vars that do not exist

- Severity: medium
- Category: docs
- Decision: IMPLEMENT
- Source finding: F14
- Locations:
  - `services/_stub/ui/README.md:3-21`
  - `docs/services/UI.md:21-30`
  - `docs/services/UI.md:44-71`
  - `docs/services/UI.md:80-116`
  - `docs/services/UI.md:123-139`

**Problem.** README: env vars VITE_BITMEX_REST_URL / VITE_BITMEX_WS_URL are read nowhere (no VITE_ or import.meta.env in src or vite.config); `tb up gui/bitmex` names a non-existent module (modules/ holds only collect, infra, store); line 5 presents a 'time machine ... variable-speed replay' as current. UI.md describes src/hooks/, data/client/LiveClient.ts|ReplayClient.ts, data/channels/*, useChannel, useCandles(... loadMore), TimeControlProvider and shared/types - none exist (real code: BitmexClient/WsClient, per-widget hooks under src/widgets/*, src/types.ts). It uses future tense ('The replay backend is a future backend service'), states a widget contract the hooks break, carries a dated 'Current State (as of April 2026) ... data layer, hooks, and providers do not exist yet' (false), and claims 'VITE_* env vars are baked at build time' (none used). Breaks CLAUDE.md 'Only what is true today' and 'Each subject has one home'.

**Evidence.** README.md:9-13 env table, README.md:17-21 `tb up gui/bitmex --build`; UI.md 'Current State' section (~123-127); UI.md:21-24 future-tense replay backend; grep for VITE_ in src and vite.config.ts finds nothing; vite.config.ts:16-21 reads only UI_REST_PROXY, UI_DIGGER_HOST, UI_DIGGER_WS_PORT, UI_DIGGER_REST_PORT, UI_DIGGER_CONTROL_PORT (port hard-coded 3000; UI_PORT is only the compose host mapping).

**Fix.** Rewrite docs/services/UI.md to describe only current code: the data layer (BitmexClient fetch/stream over WsClient with ref-counted channels, reconnect backoff, table/symbol routing; EnvProvider persistence under tradebot.ui.env; DataProvider remounted with key={env} from App.tsx); the widget hooks (useOrderbook, useRecentTrades, and useChart -> useChartCandles(useClosedCandles + useRunningCandle) + useChartViewport); WidgetGrid layout persistence; which widgets render static mockData.ts; the Vite proxy rules and the variables vite.config.ts reads. State plainly, without history phrasing, that the backends these variables point at are not provided by this repo. Delete the dated 'Current State' section, future-tense lines and the VITE_* claim. Move the time-machine / TimeControlProvider / replay design into a new docs/planning/UI.md (docs/planning/ exists). README: replace the env table with the real variables (UI_PORT = compose host port; UI_REST_PROXY and UI_DIGGER_* = Vite dev-server variables), replace `tb up gui/bitmex` with the real start commands (`pnpm dev` in services/_stub/ui, or `docker compose -f services/_stub/ui/docker/compose.yml up`), and reword line 5 to what the UI does today. Keep the README short and point to UI.md as the subject's home. Coordinate with SUI-12 (variable name) and SUI-11/SUI-24 (if the owner removes replay, drop the UI_DIGGER_* docs too).

**Tests to add.** None (docs). Check every path, symbol and env var named in the rewritten docs exists via grep.

**Verifier notes.** Confirmed. Verifier corrected the suggested fix: vite.config.ts does not read UI_PORT. Some line citations drift (Current State is ~123-127, Build ~129-131); substance holds. The user explicitly asked for a documentation fresh start.

## SUI-03: After trimming, a short forward pan snaps to 'live' and shows stale history as live; live mode never checks the right edge

- Severity: medium
- Category: correctness
- Decision: IMPLEMENT
- Source finding: F3
- Locations:
  - `services/_stub/ui/src/widgets/Chart/useChart.ts:39-42`
  - `services/_stub/ui/src/widgets/Chart/useChartViewport.ts:52-57`
  - `services/_stub/ui/src/widgets/Chart/useClosedCandles.ts:224-237`
  - `services/_stub/ui/src/widgets/Chart/useRunningCandle.ts:48-60`
  - `services/_stub/ui/src/widgets/Chart/useChartCandles.ts:24`

**Problem.** useChart feeds latestTimeRef from the last buffered closed candle. After a trim that is ~anchor+0.5*cpv, so pan() (`next >= latestMs` -> live) snaps to live after a ~40-candle forward pan at cpv=80. computeNeededFetch's live branch only checks the left edge, so it returns null and nothing is fetched. The view shows the stale buffer plus a running candle seeded from the stale tail that rejects every live trade, until the next tradeBin insert triggers SUI-01's gap wipe (up to 1 min on 1m, 1 h on 1h, 1 day on 1d).

**Evidence.** Scratch: computeNeededFetch(buffer whose last candle is 341 bins old, {candlesPerView:80, rightAnchor:null}, 60000) -> null. useChart.ts:42 `latestTimeRef.current = lastCandle ? new Date(lastCandle.timestamp) : null;`; useChartViewport.ts:55 `if (latestMs !== null && next >= latestMs) return { ...s, rightAnchor: null };`.

**Fix.** Use SUI-01's liveTailMs, exposed from useClosedCandles/useChartCandles, as the latestTime passed to vp.pan in useChart instead of the buffer tail. In computeNeededFetch's live branch add `if (lastMs < Date.now() - 2*binMs) return { endTime: null, count: totalCandles };`. Because that live page can be disjoint from a trimmed buffer, replace the buffer with the fetched page when the fetched oldest candle is newer than buffer last + binMs (instead of merging and leaving an index-adjacent hole).

**Tests to add.** computeNeededFetch with a stale tail in live mode -> {endTime: null}; trimmed anchored buffer + forward pan of 50 candles (cpv 80) stays anchored when liveTailMs is far ahead; goLive with a stale buffer -> buffer replaced by the live page, no candles index-adjacent but more than one bin apart.

**Verifier notes.** Reviewer rated high; first verifier confirmed but lowered to medium (transient on short timeframes, needs >320 bins of browsing first). No second verifier. Medium adopted.

## SUI-04: REST pagination issues at most one page per viewport change, so fast pans leave the window under-filled

- Severity: medium
- Category: correctness
- Decision: IMPLEMENT
- Source finding: F4
- Locations:
  - `services/_stub/ui/src/widgets/Chart/useClosedCandles.ts:124-167`
  - `services/_stub/ui/src/widgets/Chart/useClosedCandles.ts:229-235`
  - `services/_stub/ui/src/widgets/Chart/useChart.ts:96-112`
  - `services/_stub/ui/src/widgets/Chart/renderer.ts:92-98`

**Problem.** The fetch effect depends on [bitmex, symbol, timeframe, binMs, viewport, fetchKey] but not on the buffer. After a page merges nothing re-runs computeNeededFetch, so if one page did not reach the needed left edge the window stays under-filled (and stretched by the renderer's index spacing) until the user moves again.

**Evidence.** Scratch: buffer of 160 bins ending NOW, viewport {cpv:80, rightAnchor: NOW-300 bins} -> after merge+trim 'visible after fetch: 19 of 80; follow-up need: { endTime: ..., count: 160 }', which is never issued.

**Fix.** After merging a page, re-run computeNeededFetch(next, viewportRef.current, binMs). While it is non-null, `active`, and the last page returned a full page, issue the next page (loop inside the async function, or bump a pageKey). Stop on an empty or short page so the start of history terminates. Share this loader with SUI-05 (single in-flight request). Do not add a disjoint-replace rule here; that belongs to SUI-03's live refetch.

**Tests to add.** renderHook + fake REST: buffer of 160 ending NOW, set rightAnchor NOW-300 bins -> fetches repeat until computeVisible returns 80 candles; fake REST returning fewer rows than requested (start of history) -> loop terminates.

**Verifier notes.** Under-fill half confirmed. The 'disjoint right-branch page leaves a hole' half was refuted: pan() snaps to live whenever next >= buffer tail, so a right page always overlaps the buffer; a hole only becomes possible with SUI-03's fix, which handles it.

## SUI-05: Every wheel/pointer-move event re-runs the REST effect, cancelling the in-flight page and issuing a new request

- Severity: medium
- Category: efficiency
- Decision: IMPLEMENT
- Source finding: F5
- Locations:
  - `services/_stub/ui/src/widgets/Chart/useClosedCandles.ts:124-167`
  - `services/_stub/ui/src/widgets/Chart/ChartCanvas.tsx:150-176`
  - `services/_stub/ui/src/widgets/Chart/useChartViewport.ts:27-37`

**Problem.** Each pointermove calls onPan and each wheel event calls onZoom with a fixed 1.1 step, producing a new viewport object that re-runs the fetch effect; its cleanup sets `active = false` and discards the in-flight response, and a new trade/bucketed request (2*cpv rows, up to 1000) is sent whenever the buffer still lacks the range. Dragging past the buffer edge sends roughly one request per frame and nothing applies until the gesture pauses longer than a round trip; trackpad wheel streams race zoom from 80 to 500 candles.

**Evidence.** Effect deps at useClosedCandles.ts:167 with `return () => { active = false; }` at 164-166; ChartCanvas.tsx:175 `onPanRef.current(-dx / getStep());` per pointermove; :157 `onZoomRef.current(e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)` per wheel event.

**Fix.** Keep the in-flight request in a ref ({key, promise}); do not cancel it on viewport change, only on symbol/timeframe/bitmex change or unmount. Never more than one request in flight. On resolve, merge, then re-evaluate need against viewportRef.current (the SUI-04 loop). Optionally coalesce need evaluation with requestAnimationFrame. For zoom use `onZoom(Math.exp(e.deltaY * 0.002))`, clamped per event, instead of a fixed step.

**Tests to add.** 50 successive viewport changes past the buffer edge with an unresolved fake fetch -> fetchMock called once; after it resolves, at most one follow-up call. ChartCanvas wheel test for delta-scaled zoom (see SUI-10 harness).

**Verifier notes.** Confirmed; page size corrected to 2*cpv (160 default), not always 1000.

## SUI-06: WsClient handlers act on the current socket, not the one that fired them; destroy() leaves the reconnect timer and `connected` set

- Severity: medium
- Category: correctness
- Decision: IMPLEMENT
- Source finding: F1
- Locations:
  - `services/_stub/ui/src/data/WsClient.ts:8-12`
  - `services/_stub/ui/src/data/WsClient.ts:42-45`
  - `services/_stub/ui/src/data/WsClient.ts:65-80`
  - `services/_stub/ui/src/data/WsClient.ts:132-144`
  - `services/_stub/ui/src/data/DataProvider.tsx:33-36`
  - `services/_stub/ui/src/main.tsx:6`

**Problem.** connect() installs onopen/onclose/onerror closures that mutate this.ws, this.connected and the reconnect timer regardless of which socket fired. destroy() sets this.ws = null but neither clears `connected` nor the reconnect timer (whose id is never stored), and connect() does not check for listeners. Under StrictMode (pnpm dev, the only way the UI runs) the destroyed socket's late onerror/onclose closes or orphans the new socket and schedules a third, giving ~1 s of startup without data; while `connected` is still true subscribe() silently drops the subscription. A reconnect timer pending at destroy() (e.g. an env switch during backoff) opens an unowned socket to the old env for the life of the tab. The docblocks claiming StrictMode cannot poison the instance are false.

**Evidence.** Reviewer scratch (scratch/stubui/ws.test.ts): 3 sockets created, orphaned socket still open after final destroy. Verifier scratch with a spec-like double (scratch/stubui-verify/ws2.test.ts): stale onerror closes socket #2, onclose schedules #3; env-switch case leaves 'sockets 2 open [wss://old]'. The repo MockWebSocket (tests/data/WsClient.test.ts:47-50) closes synchronously, hiding the ordering.

**Fix.** In connect(): `if (this.listeners.size === 0) return; const ws = new WebSocket(this.url); this.ws = ws;` and begin every handler with `if (this.ws !== ws) return;`; onerror calls `ws.close()`. Store `this.reconnectTimer = setTimeout(...)`. In destroy(): clearTimeout(this.reconnectTimer); detach handlers on the old socket (onopen = onmessage = onclose = onerror = null) then close it; set `this.ws = null; this.connected = false; this.reconnectDelay = 1_000`. Optionally drop `connected` and test `this.ws?.readyState === WebSocket.OPEN` in subscribe/remove. Correct the docblocks at WsClient.ts:8-12 and DataProvider.tsx:33-35.

**Tests to add.** With the realistic MockWebSocket from SUI-09: (a) subscribe -> destroy -> unsub -> subscribe -> flush -> exactly 2 sockets created, the second alive, no third after 60 s, one delivery per frame; (b) open -> server close (backoff pending) -> unsub -> destroy -> advance 60 s -> no new socket; (c) a stale onmessage from a destroyed socket does not reach handlers.

**Verifier notes.** Reviewer: high. Verifier confirmed the defect but lowered to medium: the 'two live sockets, every trade double-counted' outcome needs socket #2 to open before #1's failure events fire, which is unlikely in a real browser (the reviewer's double never fired onerror). Real impact: ~1 s startup gap and an occasionally leaked socket. No second verifier.

## SUI-07: Running candle drops the first trades of each new bin, and on 1h/1d only counts trades seen since page load

- Severity: medium
- Category: correctness
- Decision: IMPLEMENT
- Source finding: F6
- Locations:
  - `services/_stub/ui/src/widgets/Chart/useRunningCandle.ts:48-60`
  - `services/_stub/ui/src/widgets/Chart/useRunningCandle.ts:79-96`
  - `services/_stub/ui/src/widgets/Chart/useRunningCandle.ts:133-144`

**Problem.** The accumulator window (seed.ts, seed.ts+binMs] only moves when a new closed candle arrives via the tradeBin insert, which the venue publishes after the bin closes; trades early in the next bin fail `tradeMs > binEndMs` and are skipped, and the reseed starts from volume 0. At mount/timeframe switch the running bin is seeded with OHLC = prev.close and volume 0, so on 1h/1d the displayed high/low/volume cover only trades since mount. Display-only: the closed candle later comes from the venue with correct totals.

**Evidence.** useRunningCandle.ts:87 `if (tradeMs <= binStartMs || tradeMs > binEndMs) { continue; }`; reseed effect keyed on [seed?.timestamp, seed?.close, binMs] (line 60); seedFrom (133-143) sets volume 0, high/low = prev.close.

**Fix.** In the trade handler, when tradeMs > binEndMs roll over: new acc with timestamp = ceil(tradeMs/binMs)*binMs (ISO), open = acc.close, high/low/close = trade.price, volume = trade.size. In the seed effect skip reseeding when the new seed's end (seed.ts+binMs) is <= the current acc.timestamp, preserving accumulated trades. Optional, best-effort: seed the in-progress bin from REST trade/bucketed with partial=true when the source supports it, falling back to current seeding.

**Tests to add.** useRunningCandle.test.tsx: trade 1 s after binEnd before any new seed -> running candle moves to the next bin with that trade's volume; seed then advances to the just-closed bin -> running volume preserved; trade before binStart still ignored.

**Verifier notes.** Confirmed at medium. The partial=true seeding is optional since no current source is guaranteed to support it.

## SUI-08: Core chart buffer logic (useClosedCandles hook: WS insert handling, REST lifecycle) has no hook-level tests

- Severity: medium
- Category: testing
- Decision: IMPLEMENT
- Source finding: F21
- Locations:
  - `services/_stub/ui/src/widgets/Chart/useClosedCandles.ts:62-167`
  - `services/_stub/ui/tests/widgets/Chart/useClosedCandles.test.ts:69-128`

**Problem.** useClosedCandles.ts is at 68.9% lines; the whole tradeBin insert handler (sort, duplicate drop, gap wipe, merge), the fetch error/cancel paths and the reset effect never run, because the only test file imports just the _test_ helpers. The anchored right-edge branch (line 234) is uncovered and the 'short on history' test asserts only `endTime not null`. These gaps are where SUI-01/03/04 live.

**Evidence.** v8 coverage (scratch/cov-stub-ui and cov-stub-ui-verify): uncovered 68-114, 131, 140, 147, 161, 234.

**Fix.** Add tests/widgets/Chart/useClosedCandles.hook.test.tsx (renderHook + tests/helpers/fakeBitmex.tsx, mocked bitmex.fetch returning contiguous bins for (count, endTime)). Write characterisation tests for current correct behaviour first, then the SUI-01/03/04/05 regression cases alongside those fixes.

**Tests to add.** (1) initial live load calls fetch('trade/bucketed', cpv + 2*ceil(cpv*0.5), {symbol, binSize}) without endTime; (2) contiguous insert appends; (3) duplicate tail insert ignored; (4) gap insert empties buffer and triggers exactly one extra fetch; (5) unsorted two-row insert sorted then accepted; (6) rejected fetch -> console.warn, buffer unchanged; (7) new viewport before first fetch resolves -> stale response discarded (update when SUI-05 changes semantics); (8) symbol/timeframe change empties buffer and unsubscribes old tradeBin channel; pure helpers: anchored viewport whose buffer ends before rightEdge - binMs -> {endTime: rightEdge}; left branch asserts endTime.getTime() === firstMs.

**Verifier notes.** Confirmed. Refuted sub-claim: the 'short on history' fixture does use two distinct timestamps (candle(idx, base)); it is weak only because of its assertion.

## SUI-09: WsClient tests use a WebSocket double that hides real ordering; backoff, resubscribe and onerror are untested

- Severity: medium
- Category: testing
- Decision: IMPLEMENT
- Source finding: F23
- Locations:
  - `services/_stub/ui/tests/data/WsClient.test.ts:11-51`
  - `services/_stub/ui/tests/data/WsClient.test.ts:95-111`
  - `services/_stub/ui/tests/data/WsClient.test.ts:~223`
  - `services/_stub/ui/src/data/WsClient.ts:132-148`

**Problem.** MockWebSocket starts OPEN and close() fires onclose synchronously; a real socket starts CONNECTING and closes asynchronously, so the suite cannot catch SUI-06. No test asserts backoff values (1 s -> 2 s -> ... -> 30 s cap), the reset on open, resubscription after reconnect, onerror, or malformed/non-table frames. The 'does NOT reconnect after destroy' test unsubscribes first, skipping destroy-with-listeners.

**Evidence.** WsClient.test.ts:26-27 `readyState = MockWebSocket.OPEN`; :47-51 synchronous onclose; uncovered WsClient.ts lines 51, 88, 143.

**Fix.** Rework MockWebSocket: static CONNECTING/OPEN/CLOSING/CLOSED; start CONNECTING; open() sets OPEN then calls onopen; close() sets CLOSING and schedules `setTimeout(() => { readyState = CLOSED; onclose?.() }, 0)` (fake timers are on); add serverClose() and error() helpers. send() need not throw: WsClient.send already guards readyState.

**Tests to add.** Pass now: backoff 999 ms no socket / 1 ms new socket, then 2 s, 4 s, cap 30 s, reset to 1 s after open; after reconnect+open one subscribe op with all channels; error() closes only its own socket; malformed JSON and {info}/{success} frames don't reach handlers; frame without `symbol` reaches only table-level handlers. Land with SUI-06/SUI-15: StrictMode sequence -> one live socket and one delivery per frame; destroy during pending reconnect -> no new socket; second listener after open -> no duplicate subscribe.

**Verifier notes.** Confirmed. Correction: line 137 (reconnect setTimeout) is covered; uncovered lines are 51, 88, 143.

## SUI-10: ChartCanvas gestures, hover and resize are untested (42% lines); the ResizeObserver stub means draw() never runs

- Severity: medium
- Category: testing
- Decision: IMPLEMENT
- Source finding: F22
- Locations:
  - `services/_stub/ui/src/widgets/Chart/ChartCanvas.tsx:46-229`
  - `services/_stub/ui/tests/setup.ts:19-27`

**Problem.** The global ResizeObserver stub never calls back, so sizeRef stays 0x0 and draw() returns at line 61 in every test. No test mounts ChartCanvas directly, so wheel->zoom/pan, drag->pan with pointer capture, hover index, pointerleave and the hover re-validation effect are untested. These are the conversions behind SUI-05, SUI-17 and SUI-18.

**Evidence.** Coverage: `ChartCanvas.tsx | 42.59 | 19.56 | 43.75 | 42.05 | ...21-135,147-215`; setup.ts:20-24 empty observe().

**Fix.** Add tests/widgets/Chart/ChartCanvas.test.tsx. Setup: vi.stubGlobal a ResizeObserver whose observe(el) immediately calls back with [{contentRect:{width:866,height:400}}] (plotW 800 if MARGIN left+right = 66; check renderer.ts); wrap the canvas in a parent div (effect needs parentElement); stub HTMLCanvasElement.prototype.setPointerCapture/releasePointerCapture (jsdom 26 lacks them); dispatch pointer events as MouseEvent('pointerdown', {button, buttons, clientX}) plus defineProperty pointerId (no PointerEvent in jsdom); WheelEvent with cancelable:true and assert defaultPrevented. Note hover uses step = plotW/candles.length while pan uses plotW/candlesPerView (until SUI-18 unifies them).

**Tests to add.** (1) wheel deltaY>0 -> onZoom(1.1), <0 -> onZoom(1/1.1), |deltaX|>|deltaY| -> onPan(-deltaX/(800/cpv)); (2) pointerdown button 0 + move dx=+20 -> onPan(-20/step), setPointerCapture(1); after pointerup a move doesn't pan; button 2 ignored; pointercancel detaches; (3) hover at MARGIN.left + (800/N)*3.5 -> onHover(candles[3]); right margin -> onHover(null); pointerleave -> onHover(null); move with buttons != 0 -> no onHover; (4) rerender with fewer candles than hover index -> onHover(null); (5) resize sets canvas.width = 866*dpr and calls setTransform(dpr,0,0,dpr,0,0).

**Verifier notes.** Confirmed; verifier added the jsdom PointerEvent/setPointerCapture workarounds and the hover-vs-pan step distinction.

## SUI-11: Data sources are hard-wired to BitMEX and the digger replay backend, none of which exist; no environment can produce data

- Severity: medium
- Category: config
- Decision: DEFER
- Source finding: F13
- Locations:
  - `services/_stub/ui/docker/compose.yml:13-21`
  - `services/_stub/ui/vite.config.ts:4-21`
  - `services/_stub/ui/src/data/envs.ts:1-14`
  - `services/_stub/ui/src/components/EnvSwitcher.tsx:1-5`
  - `services/_stub/ui/src/data/DataProvider.tsx:28-31`

**Problem.** envs.ts hard-codes wss://ws.bitmex.com and the testnet URLs (venue closed per docs/DATA_PIPELINE.md:67-71), UI_REST_PROXY defaults to http://proxy (no such service), and the replay env targets digger (retired per DATA_PIPELINE.md:152-154). No module under modules/ includes this compose file. Additionally compose passes UI_REPLAY_HOST while vite.config.ts reads UI_DIGGER_HOST, so Replay can never be enabled through compose (the name alignment itself is bounded and is folded into SUI-12).

**Evidence.** vite.config.ts:16-21 `process.env.UI_REST_PROXY ?? 'http://proxy'`, `process.env.UI_DIGGER_HOST ?? ''`; compose.yml:21 `UI_REPLAY_HOST: ${UI_REPLAY_HOST:-}`; envs.ts:4 and EnvSwitcher.tsx:3 name UI_REPLAY_HOST; `ls services` has no proxy or digger.

**Fix.** Owner decides the backend first. Then either delete the replay env (ENV_CONFIGS.replay, DiggerClient, /replay* proxy rules, __REPLAY_ENABLED__, the Replay option; see SUI-24) and put the intended backend contract in docs/planning/, or point the env config at the replacement. Replace the BitMEX constants with one env-driven source table (e.g. Vite define from UI_* variables). Update tests/data/envs.test.ts, DiggerClient.test.ts, EnvSwitcher.test.tsx accordingly.

**Tests to add.** Depends on the decision; envs.test.ts should cover the env-driven table.

**Verifier notes.** Confirmed on every point; deferred because removing or replacing the BitMEX/digger wiring is the owner's call and the user plans to implement the missing functionality soon.

## SUI-12: Stale, wrong or rule-breaking docblocks, config comments, and the UI_REPLAY_HOST/UI_DIGGER_HOST name mismatch

- Severity: low
- Category: docs
- Decision: IMPLEMENT
- Source finding: F15
- Locations:
  - `services/_stub/ui/src/data/DiggerClient.ts:1-16`
  - `services/_stub/ui/src/data/EnvProvider.tsx:1-5`
  - `services/_stub/ui/src/widgets/Chart/renderer.ts:5-8`
  - `services/_stub/ui/src/widgets/Chart/renderer.ts:35-48`
  - `services/_stub/ui/src/widgets/Chart/renderer.ts:197-200`
  - `services/_stub/ui/src/widgets/Chart/ChartCanvas.tsx:25-27`
  - `services/_stub/ui/src/widgets/Chart/useChart.ts:11`
  - `services/_stub/ui/src/widgets/Orderbook/useOrderbook.ts:33-37`
  - `services/_stub/ui/src/widgets/Orderbook/useOrderbook.ts:96-97`
  - `services/_stub/ui/src/data/WsClient.ts:8-12`
  - `services/_stub/ui/src/data/DataProvider.tsx:33-35`
  - `services/_stub/ui/vite.config.ts:12-13`
  - `services/_stub/ui/docker/compose.yml:13-21`
  - `services/_stub/ui/src/data/envs.ts:4-5`
  - `services/_stub/ui/src/components/EnvSwitcher.tsx:3-4`

**Problem.** DiggerClient claims digger 'serves historical BitMEX data from MongoDB' (both retired). EnvProvider explains itself by consumers and names the wrong writer (Header; actually EnvSwitcher) - CLAUDE.md provider-doc rule. renderer MARGIN docblock justifies the export by naming ChartCanvas; renderChart's '(easy to split ... as the chart grows)' is a plan and its section list stops at 7 though section 8 (hover crosshair) exists; drawTimeAxis claims hour/day boundary labels but uses 60 px spacing and an exact-midnight check. ChartCanvas claims hover causes no React re-render (onHover -> setHovered re-renders ChartWidget). useChart:11 mentions a non-existent 'go live' button. useOrderbook:35 is a conditional plan and :97 'no intermediate copy' misleads. vite.config 'replay module's mappings' and compose 'modules that wire digger' reference nothing. compose/envs/EnvSwitcher name UI_REPLAY_HOST while vite.config reads UI_DIGGER_HOST.

**Evidence.** Quoted strings at the listed lines; vite.config.ts:18 vs compose.yml:21; EnvSwitcher.tsx:19 is the only setEnv caller.

**Fix.** Rewrite each in its own terms: (1) DiggerClient: 'HTTP client for a replay control endpoint: POST <base>/set-clock?timestamp=' - no MongoDB/digger internals (or delete with SUI-24). (2) EnvProvider: 'Holds the selected data environment, persisted in localStorage under tradebot.ui.env; useEnv() reads and sets it.' (3) MARGIN: 'Plot margins in logical px; plot geometry derives from them.' (4) renderChart: drop the parenthetical, add '8. Hover crosshair'. (5) drawTimeAxis: 'Labels candles left to right at least 60 px apart; a candle at exactly 00:00 UTC is labelled with its date, others with HH:MM UTC.' (6) ChartCanvas: 'Hover recomputes the column under the pointer and notifies onHover only when it changes.' (7) useChart viewport: 'Current viewport state.' (8) useOrderbook:35 -> constraint 'orderBookL2_25 carries at most 25 levels; DEPTH must not exceed it'; :97 -> 'the map is mutated in place; rows are derived at render time'. (9) WsClient/DataProvider StrictMode docblocks: correct after SUI-06. (10) Use one variable name: change compose.yml, envs.ts and EnvSwitcher.tsx to UI_DIGGER_HOST (what vite.config reads), or rename in vite.config; drop the 'replay module' / 'modules that wire digger' text. If the owner removes replay (SUI-11/24), delete these blocks instead.

**Tests to add.** None needed; tsc/vitest stay green.

**Verifier notes.** Confirmed; verifier additionally surfaced the env-var name mismatch, merged here (also noted by SUI-11 and SUI-26's verifier).

## SUI-13: useRecentTrades: the REST page overwrites WS trades that arrived first

- Severity: low
- Category: correctness
- Decision: IMPLEMENT
- Source finding: F7
- Locations:
  - `services/_stub/ui/src/widgets/RecentTrades/useRecentTrades.ts:35-44`
  - `services/_stub/ui/src/widgets/RecentTrades/useRecentTrades.ts:46-60`

**Problem.** REST fetch and WS subscription start together; if an insert arrives before the REST promise resolves, `setTrades(initial.map(tag))` replaces the list and those newest trades vanish. Overlap between REST and WS is never deduplicated.

**Evidence.** Scratch (scratch/stubui/trades.test.tsx): WS insert 'live-1' while fetch pending -> ['live-1']; REST resolves with 'rest-1' -> ['rest-1'].

**Fix.** On REST resolve: `setTrades(prev => { const seen = new Set(prev.map(t => t.trade.trdMatchID)); return [...prev, ...initial.filter(t => !seen.has(t.trdMatchID)).map(tag)].slice(0, limit); })` (WS trades first, then REST newest-first; keep uid for React keys). Update the hook docblock, which currently says field values cannot be relied on to be unique, to state that trdMatchID dedups the REST/WS overlap.

**Tests to add.** WS insert before REST resolves keeps both in newest-first order; overlapping trdMatchID appears once; symbol change still clears the list.

**Verifier notes.** Confirmed; lowered from medium to low (only the REST round-trip window after mount/symbol change, display only).

## SUI-14: Persisted env is trusted without validation: unknown value white-screens the app; 'replay' sticks when replay is disabled

- Severity: low
- Category: robustness
- Decision: IMPLEMENT
- Source finding: F9
- Locations:
  - `services/_stub/ui/src/data/EnvProvider.tsx:17`
  - `services/_stub/ui/src/data/DataProvider.tsx:22-26`
  - `services/_stub/ui/src/components/EnvSwitcher.tsx:40`
  - `services/_stub/ui/src/utils/storage.ts:15`

**Problem.** get<Env>(STORAGE_KEY, DEFAULT_ENV) is an unchecked cast. Any other string makes ENV_CONFIGS[env] undefined and `cfg.restPath` throws during render; there is no error boundary, so the page goes blank on every reload. A saved 'replay' stays selected when the dev server starts without replay, and the select shows a disabled option as current.

**Evidence.** EnvProvider.tsx:17 `useState<Env>(() => get<Env>(STORAGE_KEY, DEFAULT_ENV))`; DataProvider.tsx:23-25 `ENV_CONFIGS[env]` then `cfg.restPath`; no ErrorBoundary/componentDidCatch in src.

**Fix.** In EnvProvider.tsx: `const isEnv = (v: unknown): v is Env => v === 'live' || v === 'testnet' || v === 'replay';` and initialise with `() => { const s = get<unknown>(STORAGE_KEY, DEFAULT_ENV); return isEnv(s) && (s !== 'replay' || __REPLAY_ENABLED__) ? s : DEFAULT_ENV; }`; add `declare const __REPLAY_ENABLED__: boolean` as DataProvider.tsx does. Check how vitest.config defines __REPLAY_ENABLED__ so the test can toggle it (e.g. vi.stubGlobal). If SUI-11 removes replay, simplify accordingly.

**Tests to add.** tests/data/EnvProvider.test.tsx: stored JSON "staging" -> 'live'; stored "replay" with replay disabled -> 'live'.

**Verifier notes.** Confirmed; lowered to low (namespaced key, replay case recoverable through the dropdown).

## SUI-15: WsClient sends a duplicate subscribe op when a second listener joins an already-subscribed channel

- Severity: low
- Category: correctness
- Decision: IMPLEMENT
- Source finding: F12
- Locations:
  - `services/_stub/ui/src/data/WsClient.ts:21-40`

**Problem.** subscribe() sends the op whenever `this.connected` is true, without checking whether the channel already had listeners, contradicting its docblock and asymmetric with remove(). In practice this fires after open on a timeframe change (useRunningCandle re-adds one of two trade:XBTUSD listeners) or symbol change; the venue replies with an error frame that onmessage drops.

**Evidence.** Scratch: subscribe 'trade:XBTUSD', open, subscribe again -> two identical subscribe ops sent. tests/data/WsClient.test.ts:95-111 adds both listeners before open().

**Fix.** In subscribe(): `const isNew = !this.listeners.has(channel);` before creating the set; `if (this.connected) { if (isNew) this.send({ op: 'subscribe', args: [channel] }); } else { this.connect(); }`.

**Tests to add.** Subscribe, open, subscribe a second handler on the same channel -> MockWebSocket.last!.sent has exactly one subscribe op.

**Verifier notes.** Confirmed; failure scenario overstated (on page load both listeners subscribe before open, so only one op is sent; no evidence of disconnects).

## SUI-16: Orderbook 'Total' accumulates from the far end of the book; dead StackedLayout orders the bid ladder wrongly

- Severity: low
- Category: correctness
- Decision: IMPLEMENT
- Source finding: F10
- Locations:
  - `services/_stub/ui/src/widgets/Orderbook/useOrderbook.ts:6-29`
  - `services/_stub/ui/src/widgets/Orderbook/useOrderbook.ts:46-84`
  - `services/_stub/ui/src/widgets/Orderbook/OrderbookWidget.tsx:9`
  - `services/_stub/ui/src/widgets/Orderbook/OrderbookWidget.tsx:108-140`
  - `services/_stub/ui/tests/widgets/Orderbook/useOrderbook.test.tsx:38`
  - `services/_stub/ui/tests/widgets/Orderbook/useOrderbook.test.tsx:54`

**Problem.** derive() reverses each side so the worst level comes first and then accumulates, so the best ask/bid shows the total of the whole visible side - the reverse of the usual depth convention (cumulative size from the touch outwards). Tests pin it. StackedLayout is unreachable (SIDE_BY_SIDE = true) and would put the worst bid next to the spread row.

**Evidence.** useOrderbook.ts:69-75 `[...rawAsks].reverse().map(l => { askTotal += l.size; ...})`; test expects asks totals [4,6,7] with best ask 100 getting 7, bids [7,12,15] with best bid 99 getting 15.

**Fix.** Accumulate over rawAsks (ascending, best first) and rawBids (descending, best first), then reverse for worst-first display: `let t = 0; const asks = rawAsks.map(l => ({ price: l.price, size: l.size, total: t += l.size })).reverse();` and likewise for bids. Update the `total` docblocks (useOrderbook.ts:9, 17, 23, 46-49) to 'cumulative size from the best price out to this level'. Delete SIDE_BY_SIDE, StackedProps and StackedLayout and any CSS used only by them (orderbook__table--stacked, orderbook__spread if unused elsewhere; see bitmex.css ~678).

**Tests to add.** Update expectations: asks prices [102,101,100] totals [7,3,1]; bids prices [97,98,99] totals [15,8,3].

**Verifier notes.** Confirmed; behaviour was deliberate per docblocks but inverts the convention the BitMEX-styled UI copies. Lowered to low because no live source exists today.

## SUI-17: Hovered candle is a stale snapshot: OHLC readout freezes on the running candle and drifts when the slice shifts

- Severity: low
- Category: correctness
- Decision: IMPLEMENT
- Source finding: F11
- Locations:
  - `services/_stub/ui/src/widgets/Chart/ChartWidget.tsx:70-75`
  - `services/_stub/ui/src/widgets/Chart/ChartWidget.tsx:102`
  - `services/_stub/ui/src/widgets/Chart/ChartCanvas.tsx:95-105`
  - `services/_stub/ui/src/widgets/Chart/ChartCanvas.tsx:199-205`

**Problem.** ChartCanvas reports the hovered Candle object only when the column index changes; ChartWidget stores the object. When candles change (running candle every frame, or a new bin shifting the slice, or wheel pan without pointer movement) the crosshair stays on index i while the OHLC bar shows the old object.

**Evidence.** ChartCanvas.tsx:99 is the only re-validation (`>= candles.length`); ChartWidget.tsx:75 `const infoCandle = hovered ?? candles[candles.length - 1] ?? null;`.

**Fix.** Change the prop to `onHover(idx: number | null)` and pass idx at ChartCanvas.tsx:204; keep the `>= candles.length` reset calling onHover(null). In ChartWidget: `const [hoverIdx, setHoverIdx] = useState<number | null>(null); const infoCandle = (hoverIdx !== null ? candles[hoverIdx] : undefined) ?? candles[candles.length - 1] ?? null;`.

**Tests to add.** Hover index N-1, rerender with a running candle whose close changed -> OHLC bar shows the new close (uses SUI-10 harness).

**Verifier notes.** Confirmed, cosmetic.

## SUI-18: Pan speed uses candlesPerView while the renderer spaces by candles.length; leaving live mode jumps two candles

- Severity: low
- Category: correctness
- Decision: IMPLEMENT
- Source finding: F20
- Locations:
  - `services/_stub/ui/src/widgets/Chart/ChartCanvas.tsx:70-74`
  - `services/_stub/ui/src/widgets/Chart/ChartCanvas.tsx:84-86`
  - `services/_stub/ui/src/widgets/Chart/renderer.ts:92`
  - `services/_stub/ui/src/widgets/Chart/useChartViewport.ts:43-57`

**Problem.** getStep() uses plotW/candlesPerView for gestures while renderChart and hover use plotW/candles.length. When fewer candles than cpv are visible (start of history, loading, under-fill) candles are stretched and a drag moves the data faster than the cursor (4x with 20 of 80). On the first backward pan from live, any delta in (-1,0) sets the anchor just before the latest closed candle, dropping both it and the running candle: a two-slot jump for a sub-pixel drag.

**Evidence.** ChartCanvas.tsx:73 `return plotW / Math.max(1, candlesPerViewRef.current);` vs renderer.ts:92 `const step = plotW / candles.length;`; useChartViewport.ts:49 `rightAnchor: new Date(latestMs + deltaCandles * binMs)`.

**Fix.** Geometry: pass candlesPerView to renderChart and use step = plotW / candlesPerView, right-anchored: `centerX(i) = MARGIN.left + plotW - (candles.length - i) * step + step/2`; change getColumnIdx to `idx = candles.length - 1 - floor((plotRight - x) / step)`. Live exit: either (a) on first backward pan from live set rightAnchor = latestMs + Math.min(0, Math.round(delta)) * binMs and accumulate the fractional remainder in a ref in useChart, or (b) pin at latestMs + binMs + delta*binMs and change the snap test to `next >= latestMs + binMs`. Do NOT apply the reviewer's original pin-only fix: with the snap test unchanged it oscillates back to live.

**Tests to add.** useChartViewport.test.ts: pan(-0.3) from live leaves the visible right edge at T (not T-1), a following pan(+0.3) returns to live. Renderer: candles.length 20, cpv 80 -> last candle centerX === MARGIN.left + plotW - step/2.

**Verifier notes.** Confirmed; verifier corrected the direction (faster, not slower) and showed the original live-exit fix would oscillate.

## SUI-19: Hard-coded one-decimal price formatting; axis labels duplicate for small steps; daily candles labelled with their close date

- Severity: low
- Category: correctness
- Decision: IMPLEMENT
- Source finding: F18
- Locations:
  - `services/_stub/ui/src/widgets/Chart/ChartWidget.tsx:9-11`
  - `services/_stub/ui/src/widgets/Chart/ChartWidget.tsx:21-34`
  - `services/_stub/ui/src/widgets/Chart/ChartWidget.tsx:128`
  - `services/_stub/ui/src/widgets/Orderbook/OrderbookWidget.tsx:18-20`
  - `services/_stub/ui/src/widgets/Orderbook/OrderbookWidget.tsx:47`
  - `services/_stub/ui/src/widgets/Chart/renderer.ts:229-256`

**Problem.** Any /:symbol is accepted but OHLC and orderbook prices use exactly one decimal and spread toFixed(1), so sub-1 instruments show identical levels and '0.0' spreads. renderer.formatPrice uses 0 decimals for p >= 100 even when niceStep < 1, duplicating axis labels. Timestamps are bin close times and are printed as-is, so the 1d candle for Nov 23 reads 'Nov 24' (axis too).

**Evidence.** OrderbookWidget.tsx:19 `minimumFractionDigits: 1, maximumFractionDigits: 1`; :47 `spread.toFixed(1)`; renderer.ts:250 `const decimals = p < 10 ? 4 : p < 100 ? 2 : 0;`.

**Fix.** Axis: `decimals = Math.min(8, Math.max(0, -Math.floor(Math.log10(priceStep))))` passed to formatPrice. Book/OHLC: derive decimals from the data (max fractional digits among visible level prices or the candle's OHLC values, capped at 8; same for the spread); fetching instrument tickSize is an optional later improvement. Do with SUI-21 (shared fmtPrice taking decimals). Label candles by open time: subtract binMs in fmtTimestamp and in drawTimeAxis (pass binMs to renderChart).

**Tests to add.** formatPrice/decimals for step 0.2 at 68941 -> distinct labels; fmtPrice(0.5123) -> '0.5123'; 1d candle '2026-11-24T00:00:00Z' labelled 'Nov 23, 2026'.

**Verifier notes.** Confirmed; low because only XBTUSD is linked today.

## SUI-20: Dead code and unused exports, partly hidden by a knip config that ignores .tsx files

- Severity: low
- Category: code-quality
- Decision: IMPLEMENT
- Source finding: F16
- Locations:
  - `services/_stub/ui/src/data/mockData.ts:1-35`
  - `services/_stub/ui/src/types.ts:26-30`
  - `services/_stub/ui/src/utils/storage.ts:29-35`
  - `services/_stub/ui/src/data/BitmexClient.ts:6-13`
  - `services/_stub/ui/src/widgets/Orderbook/OrderbookWidget.tsx:9,108-140`
  - `services/_stub/ui/src/components/Header.tsx:52,83,102`
  - `services/_stub/ui/src/widgets/Chart/renderer.ts:176,204`
  - `services/_stub/ui/src/widgets/Chart/useChart.ts:17-18,58`
  - `knip.json:9`

**Problem.** knip's services/** project is src/**/*.ts, so .tsx files are excluded: `npx knip --workspace services/_stub/ui` reports false positives (react-grid-layout, five used mocks, useChart, EnvContextValue) and misses real dead code. Real dead code: orderbookData, recentTradesData, WsMessage, storage.remove (tests only), Header `_menuOpen` (never read), StackedLayout (SIDE_BY_SIDE constant true), the whole FETCH_DEFAULTS table (every caller passes count), drawTimeAxis `_width`, and goLive (returned by useChart, used by no widget).

**Evidence.** knip output quoted by reviewer and re-run by verifier; grep shows no importers of orderbookData/recentTradesData/WsMessage.

**Fix.** knip.json: services/** project -> ["src/**/*.{ts,tsx}"]; if the vite plugin doesn't pick up the entry, add `"services/_stub/ui": { "entry": ["src/main.tsx"] }`; re-run knip and confirm the false positives are gone. Delete orderbookData, recentTradesData, WsMessage, the `_menuOpen` state and the More onClick, FETCH_DEFAULTS (make `count` required in BitmexClient.fetch), the `_width` parameter and its argument at renderer.ts:176. Delete storage.remove plus its test (tests/utils/storage.test.ts:~75) or keep it as deliberate API. StackedLayout removal is covered by SUI-16. goLive: remove from UseChartResult (keep in useChartViewport) or wire a 'Live' button shown when viewport.rightAnchor !== null. Keep BIN_SIZE (it separates UI Timeframe from the venue's binSize vocabulary).

**Tests to add.** tsc and vitest stay green; knip clean for the workspace.

**Verifier notes.** Confirmed; verifier extended FETCH_DEFAULTS to the whole table and rejected removing BIN_SIZE as dead-code.

## SUI-21: Duplicated helpers/constants across widgets, raw unguarded localStorage in WidgetGrid, misc small quality issues

- Severity: low
- Category: code-quality
- Decision: IMPLEMENT
- Source finding: F17
- Locations:
  - `services/_stub/ui/src/widgets/Orderbook/OrderbookWidget.tsx:11-20`
  - `services/_stub/ui/src/widgets/RecentTrades/RecentTradesWidget.tsx:40-45`
  - `services/_stub/ui/src/widgets/Chart/ChartWidget.tsx:9-11`
  - `services/_stub/ui/src/components/WidgetGrid.tsx:30-42,49-57,65-68`
  - `services/_stub/ui/src/data/DataProvider.tsx:29`
  - `services/_stub/ui/src/widgets/Chart/useChart.ts:49-51`
  - `services/_stub/ui/src/App.tsx:62`

**Problem.** quoteCurrency duplicated in two widgets, fmtPrice in two; useParams with default 'XBTUSD' in six files plus App.tsx's redirect. WidgetGrid reads/writes localStorage directly (setItem unguarded) and casts the stored layout with `as Layout`; rowHeight divides by COLS where rows are meant (works only because the default layout is 12 rows). '/replay-control' is hard-coded in DataProvider. useChart's onPan useCallback depends on `vp`, a new object every render.

**Evidence.** Identical bodies at OrderbookWidget.tsx:11-16 and RecentTradesWidget.tsx:40-45; WidgetGrid.tsx:67 `localStorage.setItem(...)`; :57 `h / COLS`; useChart.ts:51 `[vp, binMs]`.

**Fix.** src/utils/format.ts exporting quoteCurrency and fmtPrice(value, decimals) (with SUI-19). src/utils/useSymbol.ts: `export const DEFAULT_SYMBOL = 'XBTUSD'; export function useSymbol() { return useParams<{symbol:string}>().symbol ?? DEFAULT_SYMBOL; }` used in the six files and App.tsx Navigate. WidgetGrid: `get<unknown>(STORAGE_KEY, null)` validated by `Array.isArray(v) && v.every(x => x && typeof x.i === 'string' && [x.x,x.y,x.w,x.h].every(Number.isFinite))`, falling back to DEFAULT_LAYOUT; write with `set(STORAGE_KEY, next)`; `const ROWS = 12` and `h / ROWS`. Add `controlPath?: string` to EnvConfig (replay only) and build DiggerClient from it - skip if SUI-24 removes replay. useChart: `const { pan } = vp;` deps [pan, binMs].

**Tests to add.** WidgetGrid: corrupt stored value ('{"a":1}') falls back to default layout; setItem throwing does not propagate.

**Verifier notes.** Confirmed; practical impact small.

## SUI-22: Several tests assert too loosely or are mislabelled (ChartWidget OHLC, renderer call counts)

- Severity: low
- Category: testing
- Decision: IMPLEMENT
- Source finding: F24
- Locations:
  - `services/_stub/ui/tests/widgets/dataWidgets.render.test.tsx:102-118`
  - `services/_stub/ui/tests/widgets/Chart/renderer.test.ts:63-93`
  - `services/_stub/ui/tests/data/DiggerClient.test.ts:17-22`

**Problem.** The ChartWidget test is titled 'once a tradeBin frame arrives' but stages only REST and matches /100|110|95|105/; the bar actually shows the running candle seeded at 105, so it passes without the REST candle ever being displayed. Renderer tests only count context calls (wicks and grid lines satisfy the crosshair assertion), with nothing on price->y mapping, colours, volume scaling, niceStep or formatPrice. DiggerClient tests use '/replay' instead of production '/replay-control' (cosmetic).

**Evidence.** dataWidgets.render.test.tsx:117 `toMatch(/100|110|95|105/)`; renderer.test.ts:81-83 `expect(lineTos).toBeGreaterThan(candles.length)`.

**Fix.** ChartWidget: rename to 'shows the running candle seeded from the REST close', assert the exact OHLC text of `.chart__ohlc` (check span spacing, e.g. 'O 105.0H 105.0L 105.0C 105.0'); separately emit a trade:XBTUSD insert in the running bin and assert C/H/L update; assert the REST candle's own OHLC via hover once the SUI-10 harness exists. Renderer: record moveTo/lineTo/fillRect args and fillStyle per fillRect; crosshair adds exactly one setLineDash([4,4]) followed by moveTo at Math.round(centerX(hover))+0.5 (diff against hoverIndex=null); up/down bodies '#0a9b62'/'#fe3c3c'; max-volume bar height = volume pane height; highest high has smaller y than lowest low; export _test_niceStep/_test_formatPrice and unit-test them. Optionally use '/replay-control' in DiggerClient tests.

**Tests to add.** As described in fix.

**Verifier notes.** Mostly confirmed; the computeNeededFetch fixture sub-claim was refuted (leave it alone).

## SUI-23: Orderbook and Recent Trades re-render on every WS message with no frame batching

- Severity: low
- Category: efficiency
- Decision: DEFER
- Source finding: F8
- Locations:
  - `services/_stub/ui/src/widgets/Orderbook/useOrderbook.ts:96-97`
  - `services/_stub/ui/src/widgets/Orderbook/useOrderbook.ts:111-150`
  - `services/_stub/ui/src/widgets/RecentTrades/useRecentTrades.ts:57-61`
  - `services/_stub/ui/src/widgets/RecentTrades/useRecentTrades.ts:147-151`

**Problem.** useOrderbook bumps version per orderBookL2_25 message and re-derives (several array copies, sorts) every render with no memo; useRecentTrades rebuilds a 100-element array per message. useRunningCandle already batches to rAF. The docblock 'no intermediate copy' misleads (fixed by SUI-12).

**Evidence.** useOrderbook.ts:141 `setVersion(v => v + 1);` per message; :150 `return derive(book.current);`.

**Fix.** When a live or replay source exists again: extract useRunningCandle's rAF coalescing into a shared useFrameBatchedState helper; in useOrderbook schedule one rAF per frame to bump version and `useMemo(() => derive(book.current), [version])`; in useRecentTrades buffer incoming trades in a ref and flush once per frame; cancel in cleanup. Stub rAF in both hook tests as tests/widgets/Chart/useRunningCandle.test.tsx:20 does.

**Tests to add.** 10 emits within one frame, flush rAF once -> exactly one extra render.

**Verifier notes.** Confirmed but lowered to low and deferred: cost is small (<=50 levels) and no data source can produce a fast stream today (BitMEX closed, digger retired); batching would also require reworking synchronous act() emits in existing tests.

## SUI-24: ReplayClock: set-clock fires on every partial edit, parses local time while the chart shows UTC, widgets keep pre-seek state

- Severity: low
- Category: correctness
- Decision: DEFER
- Source finding: F19
- Locations:
  - `services/_stub/ui/src/components/Header.tsx:20-68`
  - `services/_stub/ui/src/data/DiggerClient.ts:17-27`

**Problem.** datetime-local onChange sends POST set-clock per field change with no debounce or ordering (an earlier slow response can overwrite status); `new Date(value)` parses as browser-local time while all chart times are UTC; after a seek nothing resets candle buffer, running candle or recent trades.

**Evidence.** Header.tsx:31 `const ts = new Date(value).getTime();`; :38 `await digger.setClock(ts);` inside onChange.

**Fix.** If replay UI is retired: delete ReplayClock and its usage, DiggerClient and its test, DiggerContext/useDigger, the replay ENV_CONFIGS/EnvSwitcher entries, the vite.config replay proxy block and the compose replay variable. If kept: seek on an explicit 'Go' button or onBlur; parse as UTC (`Date.parse(value + ':00Z')`) or label the field UTC; a seqRef so only the latest response sets status; a clockEpoch counter from DataProvider incremented after setClock, keying <WidgetGrid key={clockEpoch} />.

**Tests to add.** If kept: with TZ non-UTC, '2026-01-01T12:00' -> setClock(Date.UTC(2026,0,1,12)); two overlapping requests leave the later status.

**Verifier notes.** Confirmed; deferred because the component only runs against the retired digger backend and the replay contract will be redesigned.

## SUI-25: Fabricated market figures and an always-on 'Online' indicator beside live data; fetch failures are invisible

- Severity: low
- Category: robustness
- Decision: DEFER
- Source finding: F26
- Locations:
  - `services/_stub/ui/src/App.tsx:10-27`
  - `services/_stub/ui/src/components/ContractBar.tsx:11-46`
  - `services/_stub/ui/src/components/Sidebar.tsx:8-13`
  - `services/_stub/ui/src/widgets/Chart/useClosedCandles.ts:160-162`
  - `services/_stub/ui/src/widgets/RecentTrades/useRecentTrades.ts:134-136`

**Problem.** BottomBar always shows 'Online' and fixed prices; ContractBar hard-codes ticker BTCUSD and stats regardless of route symbol; Sidebar converts at a constant 68940. REST failures only reach console.warn, and widgets show 'Connecting…' or an empty chart forever.

**Evidence.** App.tsx:13-14 `<span>Online</span>`, :17 'BTCUSD 68,940.2'; Sidebar.tsx:13 `/ 68940`; useClosedCandles.ts:161 console.warn.

**Fix.** Minimal bounded steps once decided: (1) WsClient `onStatus(cb: (s: 'connecting'|'open'|'closed') => void): () => void` from onopen/onclose, exposed as useConnectionStatus() via DataProvider, replacing 'Online'; (2) useClosedCandles/useRecentTrades expose an error state and widgets render an error line instead of 'Connecting…'; (3) drive ContractBar's ticker from the route symbol and blank or visibly mark the static stats as placeholders. Also consider replacing the copied BitMEX logo/branding with neutral branding.

**Tests to add.** Connection status follows mocked socket open/close; rejected fetch renders an error message.

**Verifier notes.** Confirmed; deferred as a product decision for a stub that deliberately clones BitMEX's layout. The misleading 'Online' and silent fetch failures are the real issues.

## SUI-26: Vite dev server published on all interfaces with the whole monorepo mounted

- Severity: low
- Category: security
- Decision: DEFER
- Source finding: F25
- Locations:
  - `services/_stub/ui/vite.config.ts:35-37`
  - `services/_stub/ui/docker/compose.yml:11`
  - `services/_stub/ui/docker/compose.yml:23-27`

**Problem.** pnpm dev with host: true; compose publishes ${UI_PORT:-3000}:3000 on all interfaces and mounts the repo root at /live (the Vite workspace root), so anyone reaching the port can fetch repo files via /@fs (outside the default deny list for .env*, *.pem/crt, .git) and use the /api/v1 and /replay-control proxies.

**Evidence.** vite.config.ts:36-37 `port: 3000, host: true`; compose.yml:24 `- ${UI_PORT:-3000}:3000`; :27 `- ../../../../:/live`.

**Fix.** If the owner wants it: publish as "${UI_BIND:-127.0.0.1}:${UI_PORT:-3000}:3000" (ideally the same convention across all service compose files); keep host: true inside the container. Do NOT restrict server.fs.allow to the UI directory (pnpm deps resolve into /live/node_modules/.pnpm); if narrowing, use searchForWorkspaceRoot(process.cwd()) plus explicit server.fs.deny entries.

**Tests to add.** None.

**Verifier notes.** Confirmed facts, medium-confidence impact; deferred because every service compose publishes on all interfaces, making this a repo-wide policy decision, and loopback binding breaks remote dev boxes.

## Deferred — decisions needed

- **SUI-11** (Data sources are hard-wired to BitMEX and the digger replay backend, none of which exist; no environment can produce data): What will this UI talk to (vault-backed REST, a new replay service, another venue)? Until then, should the live/testnet/replay envs, DiggerClient and the replay proxy rules be deleted, or kept dormant behind a single env-driven source config?
- **SUI-23** (Orderbook and Recent Trades re-render on every WS message with no frame batching): Pick up together with wiring a real data source (SUI-11)? No decision beyond timing is needed.
- **SUI-24** (ReplayClock: set-clock fires on every partial edit, parses local time while the chart shows UTC, widgets keep pre-seek state): Remove the replay UI (ReplayClock, DiggerClient, replay env) until a new replay backend exists, or keep and fix it now against the old set-clock contract?
- **SUI-25** (Fabricated market figures and an always-on 'Online' indicator beside live data; fetch failures are invisible): Should the static mock chrome (ContractBar stats, BottomBar prices, Sidebar order form, BitMEX branding) be removed, labelled as placeholder, or wired to data? Is a connection-status API on WsClient wanted now?
- **SUI-26** (Vite dev server published on all interfaces with the whole monorepo mounted): Should service ports (this UI and the others) bind to loopback by default with an opt-in bind variable, or stay published on all interfaces?

## Rejected

- **F1 sub-claim: StrictMode leaves two live sockets and every trade is counted twice**: Requires socket #2 to open before destroyed socket #1's failure events fire; with a spec-like double the stale onerror closes #2 instead. The core socket-ownership bug is kept as SUI-06.
- **F4 sub-claim: a disjoint right-edge page leaves a hole drawn as contiguous**: Not reachable today: pan() snaps to live whenever the target passes the buffer tail, so right-edge pages always overlap. Only SUI-03's new live refetch can create a disjoint page, and SUI-03 handles it.
- **F21/F24 sub-claim: computeNeededFetch 'short on history' fixture uses two candles with the same timestamp**: candle(idx, base) yields distinct contiguous timestamps; the fixture is fine (only its assertion is weak, covered by SUI-08).
- **F25 suggestion: restrict Vite server.fs.allow to the UI directory**: Breaks the dev server: pnpm dependencies resolve into /live/node_modules/.pnpm outside the UI directory.
