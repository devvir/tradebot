# Trader Service — Skateboard Implementation Plan

## Overview

A lightweight trading bot orchestrator that separates concerns into isolated, well-bounded modules. Each module has a clear responsibility and a barrel export that defines its public API. Everything else is private.

**Goal**: Build the skateboard — minimum viable flow that moves data from strategy decision → planner → executor → BitMEX, with real data from WS/REST services. No fancy features, just proof that each piece does its job.

## Folder Structure

```
services/trader/
├── src/
│   ├── index.ts                    # Entry point (orchestrator setup only)
│   ├── core/
│   │   ├── index.ts                # Barrel: {selectStrategy, run}
│   │   ├── orchestrator.ts         # Main loop, runs selected strategy
│   │   └── types.ts                # Core-specific types
│   ├── source/
│   │   ├── index.ts                # Barrel: {subscribe, getData}
│   │   ├── connection.ts           # WS/REST connection management
│   │   ├── subscriptions.ts        # Tracks active subscriptions
│   │   └── types.ts                # Source-specific types
│   ├── strategies/
│   │   ├── index.ts                # Barrel: {Range, strategies}
│   │   ├── types.ts                # Strategy interface & base
│   │   ├── range.ts                # Range strategy implementation
│   │   └── config.ts               # Strategy configurations
│   ├── planner/
│   │   ├── index.ts                # Barrel: {plan}
│   │   ├── translator.ts           # Pseudo-order → BitMEX order
│   │   └── types.ts                # Order types, interfaces
│   ├── executor/
│   │   ├── index.ts                # Barrel: {execute}
│   │   ├── reconciler.ts           # Compare current vs desired orders
│   │   ├── applier.ts              # Send changes to REST API
│   │   └── types.ts                # Executor-specific types
│   └── types/
│       ├── index.ts                # Shared types across modules
│       └── strategy.ts             # Strategy configuration schema
├── tests/
│   ├── flow.integration.test.ts    # End-to-end flow test
│   └── fixtures/
│       └── orders.ts               # Mock order data
└── README.md
```

## Component Descriptions

### `core` — Orchestrator

**Responsibility**: Glue that holds everything together. Selects a strategy, runs its loop, feeds results downstream.

**Public API**:
- `selectStrategy(name: string)` → loads strategy config + dependencies
- `run()` → starts the main loop

**What it does**:
1. Loads selected strategy config
2. Tells `source` which data to subscribe to (extracted from strategy dependencies)
3. On each strategy tick (e.g., every 30s), calls `strategy.decide(data)`
4. Passes results to `planner` → `executor`
5. Logs state, handles errors gracefully

**Private**:
- Loop timing, state management

---

### `source` — Data Boundary

**Responsibility**: All data enters here. WS subscriptions, REST polling, historical data. Caller-driven subscriptions.

**Public API**:
- `subscribe(deps: Dependency[])` → tell me what you need (quote, orders, trades, etc.)
- `getData(key: string)` → get latest snapshot of subscribed data
- Connection state: `isConnected()`, `reconnect()`

**What it does**:
1. Connects to WS service (via config URL)
2. Maintains active subscriptions based on what's requested
3. Caches latest snapshots per key
4. Falls back to REST if WS is slow/unavailable
5. Never pushes — always pulled by caller

**Private**:
- WS connection details, retry logic, subscription state machine

---

### `strategies` — Decision Makers

**Responsibility**: Given data, decide what trades to make. Stateless; only knows its rules.

**Public API**:
```ts
interface Strategy {
  decide(data: StrategyInput): PseudoOrder[];
}
```

**What it does** (Range strategy for skateboard):
1. Gets current quote (bid, ask)
2. Calculates +1% and -1% prices
3. Returns `[{side: 'buy', price: mid*0.99}, {side: 'sell', price: mid*1.01}]`
4. Repeats every 30s (timing managed by core)

**Private**:
- Strategy-specific logic, state if needed

---

### `planner` — Translator

**Responsibility**: Convert pseudo-orders (human-readable intent) into actual BitMEX orders (with lot sizes, tick sizes, multipliers).

**Public API**:
- `plan(pseudoOrders: PseudoOrder[], context: PlanContext): BitMexOrder[]`

**What it does**:
1. Takes `{side: 'buy', price: 12345.67}`
2. Looks up instrument metadata (tick size, lot size, multiplier)
3. Rounds price to valid tick
4. Rounds quantity to valid lot size
5. Returns `{symbol: 'XBTUSD', side: 'Buy', orderQty: 100, price: 12345.50, ...}`

**Private**:
- Tick/lot rounding logic, instrument lookup

---

### `executor` — Reconciler & Applier

**Responsibility**: Compare desired state (planned orders) with current state (open orders), apply changes minimally.

**Public API**:
- `execute(desiredOrders: BitMexOrder[], currentOrders: BitMexOrder[]): ExecutionPlan`

**What it does**:
1. Compares desired vs current:
   - Missing orders → insert
   - Changed orders → update price/qty
   - Extra orders → delete
2. Generates minimal changeset (no unnecessary cancellations)
3. Calls REST API to apply changes
4. Returns what was changed + new state

**Private**:
- REST API calls, reconciliation algorithm, error handling

---

## Data Flow (Skateboard)

```
┌─────────────────────────────────────────────────────┐
│ core.orchestrator():                                │
│ 1. Load strategy "range"                            │
│ 2. Extract deps: [quote, orders]                    │
│ 3. Tell source: subscribe to [quote, orders]       │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ source:                                             │
│ - Connect to WS service                             │
│ - Subscribe to XBTUSD quote + XBTUSD orders         │
│ - Cache latest snapshots                            │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ core.loop (every 30s):                              │
│ 1. Fetch data: quote=source.getData('quote')        │
│ 2. Call strategy: pseudo=[range.decide({quote})]    │
│ 3. Plan it: actual=planner.plan(pseudo)             │
│ 4. Get current: current=source.getData('orders')    │
│ 5. Execute: changes=executor.execute(actual,current)│
└─────────────────────────────────────────────────────┘
```

## Implementation Steps

### Phase 1: Folder & Barrel Structure
- [ ] Create folder structure
- [ ] Create barrel files (each module's `index.ts`)
- [ ] Define shared types (`types/index.ts`)

### Phase 2: Source Module
- [ ] Connection wrapper (config-driven URL to WS service)
- [ ] Subscription tracking
- [ ] Cache manager
- [ ] Implement `subscribe()` and `getData()`

### Phase 3: Strategies Module
- [ ] Strategy interface
- [ ] Range strategy: `decide(quote) → PseudoOrder[]`
- [ ] Strategy config loader
- [ ] Barrel export

### Phase 4: Planner Module
- [ ] Pseudo-order type definitions
- [ ] Instrument metadata lookup (from source or static)
- [ ] Translator: round to tick/lot
- [ ] Barrel export

### Phase 5: Executor Module
- [ ] REST client wrapper
- [ ] Reconciliation logic
- [ ] Change applier
- [ ] Barrel export

### Phase 6: Core Module
- [ ] Strategy selector
- [ ] Main loop orchestrator
- [ ] Dependency extraction
- [ ] Barrel export

### Phase 7: Entry Point
- [ ] Service setup (config loading, connections)
- [ ] Load strategy from env/config
- [ ] Run core loop

### Phase 8: Testing & Integration
- [ ] Integration test: full flow
- [ ] Testnet deployment

## Constraints for the Skateboard

1. **No persistence** — no state between restarts (okay, we're just proving the flow)
2. **No advanced error recovery** — fail fast, log clearly
3. **Single strategy at a time** — core loads one, runs it
4. **Single symbol** — hardcoded XBTUSD for now
5. **Simple tick/lot rounding** — no fancy slippage logic
6. **Minimal logging** — just the essentials to trace the flow

## Success Criteria

- [x] Each module can be imported and used independently by other modules
- [x] Barrel files clearly separate public from private APIs
- [x] Strategy config defines dependencies
- [x] Core tells source what to subscribe to (dependency-driven)
- [x] Range strategy sends real buy/sell orders every 30s
- [x] Orders appear on BitMEX testnet
- [x] Executor updates/replaces orders across loops
- [x] Logs show the flow: decide → plan → execute

## Notes

- **Testnet only** — all trades hit `https://testnet.bitmex.com`
- **Config-driven** — strategy name, symbol, REST/WS URLs all from env/config
- **Minimal dependencies** — just what's needed, no overengineering
- **Future hooks** — structure allows adding analytics, signal sources, portfolio tracking without major refactors
