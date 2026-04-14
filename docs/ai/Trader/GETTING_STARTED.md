# Trader Service — Getting Started Guide

## Quick Overview

The trader service is a modular trading bot with **clear separation of concerns**. It's designed to be built incrementally—each piece can be implemented and tested independently.

### File Organization

- **Each module is a folder** with private implementation + public `index.ts` barrel
- **Types live in `types.ts` files** — one per module, one global
- **No circular dependencies** — modules only import from modules, never back
- **Everything is typed** — use TypeScript for safety

### Current State: Skateboard ✅

The skeleton is complete and **types check cleanly**. All pieces are wired together, but...

- ✅ Strategy (Range) → decides to buy/sell 1% from mid
- ✅ Planner → normalizes to valid tick/lot sizes
- ✅ Executor → reconciles and applies via mock REST client
- ✅ Cache → stores latest data snapshots
- ❌ **WS Connection** — stubbed (needs real implementation)
- ❌ **REST Client** — stubbed (needs real implementation)
- ❌ **Service wiring** — needs `src/service.ts`

## What to Implement First

### 1. Real WebSocket Connection

**File**: `src/source/connection.ts` → expand `Connection` class

```typescript
// Pseudo-code: what it needs to do

async connect() {
  // 1. Open WS connection to wsUrl
  // 2. Parse message stream (JSON)
  // 3. Route to cache updaters based on message type
  // 4. Handle reconnection on disconnect
}

async subscribe(symbol: string, deps: DataDependency[]) {
  // 1. Map deps to WS topics:
  //    - 'quote' → 'quote:SYMBOL'
  //    - 'orders' → 'order:SYMBOL'
  //    - 'position' → 'position:SYMBOL'
  // 2. Send subscription message to WS
  // 3. Update subscriptions tracking
}

// Handle incoming messages
private onMessage(data: any) {
  const msg = JSON.parse(data);

  // If it's a quote message
  if (msg.table === 'quote') {
    cache.updateQuote(msg.data[0]); // or parse correctly
  }

  // If it's an orders message
  if (msg.table === 'order') {
    cache.updateOrders(msg.data); // or handle incremental
  }
}
```

**Reference**: Look at `services/digger/src/` or other services for how they parse BitMEX WebSocket format.

### 2. Real REST Client

**File**: Create `src/executor/rest-client.ts`

```typescript
import { RestClient, OrderPlan } from './index';

export class BitMexRestClient implements RestClient {
  private apiUrl: string;
  private apiKey: string;
  private apiSecret: string;

  constructor(apiUrl: string, apiKey: string, apiSecret: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  async insertOrder(order: OrderPlan): Promise<Order> {
    // POST https://api.bitmex.com/api/v1/order
    // Params: symbol, side, orderQty, price, ordType=Limit
    // Returns: Order object
  }

  async updateOrder(orderID: string, updates: Partial<OrderPlan>): Promise<Order> {
    // POST https://api.bitmex.com/api/v1/order/amend
    // Params: orderId, price, orderQty
    // Returns: Updated Order object
  }

  async deleteOrder(orderID: string): Promise<void> {
    // DELETE https://api.bitmex.com/api/v1/order
    // Params: orderId
  }
}
```

Then update `src/index.ts` factory to use it:

```typescript
export async function createTrader(config: TraderConfig) {
  // ...
  const restClient = new BitMexRestClient(
    config.restUrl,
    process.env.BITMEX_API_KEY!,
    process.env.BITMEX_API_SECRET!
  );
  // ...
}
```

### 3. Service Entry Point

**File**: `src/service.ts`

```typescript
import SK from '@devvir/service-kit';
import { createTrader } from './index';

SK.run(async (service) => {
  const config = {
    strategyName: process.env.STRATEGY || 'range',
    symbol: process.env.SYMBOL || 'XBTUSD',
    source: {
      wsUrl: process.env.BITMEX_WS_URL!,
      restUrl: process.env.BITMEX_REST_URL!,
    },
    restClient: new BitMexRestClient(
      process.env.BITMEX_REST_URL!,
      process.env.BITMEX_API_KEY!,
      process.env.BITMEX_API_SECRET!,
    ),
  };

  const trader = await createTrader(config);

  await trader.start();

  service.onShutdown(async () => {
    await trader.stop();
  });
});
```

### 4. Update Main Entry

**File**: `src/index.ts` → change from factory to export service

```typescript
// Add this:
import('./service');
```

Or keep as library if using differently.

## Testing as You Build

### Test the individual pieces

```bash
# Run tests
npm test

# Watch mode during development
npm run dev

# Build
npm run build
```

### Add tests for new implementations

**Example**: To test WS connection parsing

```typescript
// tests/ws-parsing.test.ts
import { Connection } from '../src/source/connection';

describe('WS Message Parsing', () => {
  it('parses quote messages correctly', async () => {
    // Setup
    // Call connection.onMessage() with sample WebSocket message
    // Verify cache was updated
  });
});
```

## Deployment

Once pieces are implemented:

```yaml
# modules/exchange/live/compose.yml (add or update)
services:
  trader:
    build:
      context: ../../..
      dockerfile: services/trader/Dockerfile
    environment:
      STRATEGY: range
      SYMBOL: XBTUSD
      BITMEX_WS_URL: ws://ws:8080
      BITMEX_REST_URL: http://rest:8080
      BITMEX_API_KEY: ${BITMEX_API_KEY}
      BITMEX_API_SECRET: ${BITMEX_API_SECRET}
    depends_on:
      ws:
        condition: service_healthy
      rest:
        condition: service_healthy
```

Create `services/trader/Dockerfile`:

```dockerfile
FROM node:20-alpine as builder
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN npm install -g pnpm && pnpm install
COPY services/trader ./services/trader
COPY shared ./shared
COPY packages ./packages
RUN pnpm -F trader build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/services/trader/dist ./dist
CMD ["node", "dist/service.js"]
```

## Debugging

### Add logging

The orchestrator logs each tick. To see what's happening:

```bash
# In compose.yml
environment:
  LOG_LEVEL: debug
```

### Mock data for testing

Use `tests/fixtures/` folder:

```typescript
// tests/fixtures/orders.ts
export const mockOrder = {
  orderID: 'test-123',
  symbol: 'XBTUSD',
  side: 'Buy',
  price: 100,
  orderQty: 100,
  ordStatus: 'New',
  timestamp: new Date().toISOString(),
};
```

## Adding New Features

### New Strategy?

1. Create `src/strategies/[name].ts` extending `BaseStrategy`
2. Add to registry in `src/strategies/config.ts`
3. Add config in `STRATEGY_CONFIGS`

Example:

```typescript
// src/strategies/ma-cross.ts
export class MACrossStrategy extends BaseStrategy {
  name = 'maCross';

  decide(data: StrategyInput): PseudoOrder[] {
    // Your logic here
    return [];
  }
}
```

### New Data Dependency?

1. Add to `DataDependency` type in `src/types.ts`
2. Add getter/updater in `DataCache`
3. Add WS topic mapping in `Connection.subscribe()`
4. Add to strategy config `dependencies[]`

### New Order Type (not just limit)?

1. Update `PseudoOrder` interface
2. Update `OrderPlan` interface
3. Update planner logic in `translator.ts`

## Common Issues

**Q: Orders aren't appearing on testnet**
- Check REST API authentication (apiKey, apiSecret)
- Verify symbol is correct (XBTUSD for testnet)
- Check if order size meets minimum lot size
- Check if price is within valid range for the contract

**Q: Strategy isn't running**
- Check cache has quote data (WS connection working?)
- Check orchestrator is actually started
- Check strategy dependencies are in config
- Check tick interval isn't set to 0

**Q: Types don't match between modules**
- Check you're exporting types from barrel files
- Verify no circular imports
- Run `tsc --noEmit` to check

## Next Steps After Skateboard Works

1. **Add Position Tracking** — keep track of current holdings
2. **Add Risk Management** — limits on size, drawdown, margin
3. **Add More Strategies** — momentum, mean reversion, etc.
4. **Add Portfolio Module** — manage multiple symbols
5. **Add Analytics** — track performance, live P&L
6. **Add Backtesting** — test strategies on historical data

---

**Key principle: Make incremental changes that keep the code compilable and testable at each step.**
