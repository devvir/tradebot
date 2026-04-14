# Trader Service — Skateboard Implementation Summary

## 🎯 What Was Built

A lightweight, modular trading bot with **clear separation of concerns**. Each module is independent, testable, and ready for incremental expansion. No fancy features—just the minimum working flow to move from strategy decision → planner → executor → BitMEX.

## 📁 Final Structure

```
services/trader/
├── src/
│   ├── types.ts                          # Global types (Quote, Order, Position, etc.)
│   ├── index.ts                          # Entry: createTrader() factory + re-exports
│   │
│   ├── core/
│   │   ├── types.ts                      # StrategyConfig
│   │   ├── orchestrator.ts               # Main loop (decide → plan → execute)
│   │   └── index.ts                      # Barrel
│   │
│   ├── source/
│   │   ├── types.ts                      # SourceConfig, SourceData
│   │   ├── connection.ts                 # WS/REST connection (stubbed)
│   │   ├── cache.ts                      # Data cache
│   │   └── index.ts                      # Barrel
│   │
│   ├── strategies/
│   │   ├── types.ts                      # Strategy, PseudoOrder
│   │   ├── strategy.ts                   # BaseStrategy abstract class
│   │   ├── range.ts                      # RangeStrategy (skateboard impl.)
│   │   ├── config.ts                     # Registry & loader
│   │   └── index.ts                      # Barrel
│   │
│   ├── planner/
│   │   ├── types.ts                      # OrderPlan, PlanContext
│   │   ├── translator.ts                 # Pseudo → BitMEX order
│   │   ├── rounding.ts                   # Tick/lot normalization
│   │   └── index.ts                      # Barrel
│   │
│   └── executor/
│       ├── types.ts                      # ExecutionChange, ExecutionPlan
│       ├── reconciler.ts                 # Order comparison logic
│       ├── applier.ts                    # REST API calls
│       └── index.ts                      # Barrel
│
├── tests/
│   └── flow.integration.test.ts          # Component tests
│
├── package.json                          # Dependencies
├── tsconfig.json                         # TS config
├── vitest.config.ts                      # Test config
├── README.md                             # Quick overview
└── IMPLEMENTATION_STATUS.md              # What's done, what's next
```

## 🏗️ Module Contracts (Public APIs)

### `core` — Orchestrator
```ts
interface StrategyConfig {
  name: string;
  symbol: string;
  dependencies: DataDependency[];
  tickIntervalMs: number;
}

class Orchestrator {
  setStrategy(strategy: Strategy, config: StrategyConfig): void
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
}
```

### `source` — Data Boundary
```ts
class Connection {
  connect(): Promise<void>
  disconnect(): Promise<void>
  subscribe(symbol: string, deps: DataDependency[]): Promise<void>
  isConnected(): boolean
}

class DataCache {
  getAll(): SourceData
  getQuote(): Quote | null
  getOrders(): Order[]
  getPosition(): Position | null
  getInstrument(): Instrument | null
  updateQuote(quote: Quote): void
  updateOrders(orders: Order[]): void
  // ... etc
}
```

### `strategies` — Decision Makers
```ts
interface Strategy {
  name: string
  decide(data: StrategyInput): PseudoOrder[]
}

class RangeStrategy extends BaseStrategy {
  decide(data: StrategyInput): PseudoOrder[]
}
```

### `planner` — Translator
```ts
function translateOrders(
  pseudo: PseudoOrder[],
  symbol: string,
  instrument: Instrument | null
): OrderPlan[]
```

### `executor` — Reconciler
```ts
interface RestClient {
  insertOrder(order: OrderPlan): Promise<Order>
  updateOrder(orderID: string, updates: Partial<OrderPlan>): Promise<Order>
  deleteOrder(orderID: string): Promise<void>
}

function reconcileOrders(
  desired: OrderPlan[],
  current: Order[]
): ExecutionChange[]

async function applyChanges(
  changes: ExecutionChange[],
  client: RestClient
): Promise<ExecutionPlan>
```

## 🔄 Data Flow

```
Range Strategy (every 30s)
  ↓ decide(quote)
PseudoOrder[] → {side: buy, price: 99.99}, {side: sell, price: 102.01}
  ↓ planner.translateOrders()
OrderPlan[] → {symbol: XBTUSD, side: Buy, price: 99.50, orderQty: 100}, ...
  ↓ executor.reconcileOrders(desired, current)
ExecutionChange[] → [{type: insert, ...}, {type: delete, ...}, ...]
  ↓ executor.applyChanges()
ExecutionPlan → {inserted: 2, updated: 0, deleted: 1}
  ↓
BitMEX Testnet (via REST client)
```

## ✅ Skateboard Checklist

- ✅ Folder structure with module boundaries
- ✅ Barrel files clearly separate public from private
- ✅ Types in dedicated `types.ts` files
- ✅ No circular dependencies
- ✅ Range strategy generates pseudo-orders 1% from mid
- ✅ Planner normalizes to valid tick/lot sizes
- ✅ Executor reconciles current vs desired
- ✅ Core orchestrator runs strategy loop
- ✅ Integration test verifies component flow
- ✅ Build configuration (tsconfig, vitest)
- ✅ Package.json with dependencies

## 🚀 What to Build Next

### Phase 1: Real WS Connection (Required for Testnet)
```ts
// In source/connection.ts
// 1. Connect to WebSocket service
// 2. Parse message streams (quote, orders)
// 3. Update cache on message
// 4. Handle reconnection
```

### Phase 2: REST Client Implementation
```ts
// Create a RestClient impl that calls BitMEX API
// - Insert: POST /order
// - Update: POST /order/amend
// - Delete: DELETE /order/{orderID}
```

### Phase 3: Service Wiring
```ts
// src/service.ts
// - Load config from env (ws url, rest url, strategy name)
// - Initialize service-kit
// - Create trader
// - Subscribe to shutdown signal
```

### Phase 4: Docker Integration
```yaml
# modules/exchange/live/compose.yml
services:
  trader:
    build: services/trader
    environment:
      STRATEGY: range
      SYMBOL: XBTUSD
      BITMEX_WS_URL: ws://ws:8080
      BITMEX_REST_URL: http://rest:8080
```

## 🧪 Testing

```bash
# Run tests
npm test

# Build
npm run build

# Watch mode
npm run dev
```

## 💡 Why This Works

1. **Each module has one job** — decide, translate, reconcile, apply, cache
2. **Public API is clear** — only barrel exports are used between modules
3. **Types are isolated** — each module owns its types, fewer merge conflicts
4. **Ready for growth** — file structure anticipates future features without overengineering
5. **Testable** — mocks are simple because responsibilities are clear
6. **Refactorable** — can move code around without breaking the overall flow

## 📝 Notes for Future Work

- When adding new strategies, just create `strategies/[name].ts` and add to registry
- When adding new data sources (signals, analytics), extend `SourceData` type
- When adding portfolio tracking, create a new module at same level as executor
- Risk management can be a module that sits between executor and applier
- Strategy combinations can wrap multiple strategies in parent orchestrator

---

**This is a working prototype. Refactor incrementally, always keeping it buildable.**
