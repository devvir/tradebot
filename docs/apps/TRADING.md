# Trading App

Provides the services needed to run autonomous trading bots against a BitMEX-compatible exchange. A bot subscribes to market data, decides what orders it wants, and submits that intent to an executor that makes it real.

## Design principle: separation of concerns

Market analysis, order intent, order translation, and order execution are four distinct jobs. Each lives in its own service. No service knows about the concerns of the others.

- **Signal** computes — it produces numbers from raw market data, no interpretation
- **Trader** decides — it runs strategy logic and produces order intent
- **Planner** translates — it converts strategy intent into fully-specified exchange-native orders
- **Executor** executes — it reconciles desired vs live orders and fires the minimum REST calls

## Modules

| Module | Description | Path |
|---|---|---|
| `trade` | Full trading pipeline: signal + trader + executor wired against the exchange app | [modules/trading/trade/](../../modules/trading/trade/) |

## Services

| Service | Role |
|---|---|
| `signal` | Subscribes to public exchange WS, accumulates market state, publishes `MarketSnapshot` + `IndicatorUpdate` messages to RabbitMQ lazily (only for active consumer bindings) |
| `trader` | Consumes signal output + private account WS, runs the active strategy, produces `DesiredState` via HTTP POST to executor on each tick |
| `planner` | Translates strategy `OrderPlan` (relative prices, size expressions) into fully-specified `ExchangeOrderSpec` objects ready for submission. **Open question: service or in-process library within trader?** |
| `executor` | Receives `DesiredState` via HTTP, tracks live orders via private WS (`bitmex-database`), runs converge algorithm, fires REST calls (amend → create → cancel) |

## External dependencies

| Service | Role | Owned by |
|---|---|---|
| Exchange WS / REST | Market data and order execution | Exchange app or testnet directly |
| RabbitMQ | Signal-to-trader message bus | Infrastructure |
| **Bouncer** | Signs exchange auth requests on behalf of any service; never exposes secrets. Services request `{ apiKey, signature, expires }` for a given account at connection time — no service holds credentials directly. Supports account types: live, testnet, replay. | Shared across all apps |

Bouncer is not part of the trading app. It is an independent service that any app can use when it needs authenticated exchange access.

## Data flow

```
                           bouncer (auth)
                          ╱      ╲      ╲
                    signal    trader   executor
                       │         │         │
Exchange WS (public) ──┘         │         │
                                 │         │
Exchange WS (private: pos/mrgn) ─┘         │
                                           │
Exchange WS (private: order) ──────────────┘
                                           │
         signal ──[RabbitMQ]──► trader     │
                                    │      │
                         DesiredState (HTTP POST, X-Account header)
                                    │      │
                                    └─────►│
                                       converge
                                           │ REST calls
                                           ▼
                                    Exchange REST API
```

Each service calls bouncer once at WS connection setup (or reconnect). The `X-Account` header on Trader → Executor requests identifies which account's connection pool entry to use.

## Message interfaces

### DesiredState — Trader → Executor

```typescript
interface DesiredState {
  symbol:    string;
  tickSize:  number;          // needed by executor for amend threshold calculation
  orders:    DesiredOrder[];  // fully-specified exchange-native specs
  timestamp: string;
}

interface DesiredOrder {
  side:            'Buy' | 'Sell';
  ordType:         'Limit' | 'Market' | 'Stop' | 'StopLimit' | 'MarketIfTouched' | 'LimitIfTouched' | 'Pegged';
  orderQty?:       number;
  price?:          number;
  stopPx?:         number;
  pegOffsetValue?: number;
  pegPriceType?:   'TrailingStopPeg' | 'PrimaryPeg' | 'MarketPeg';
  timeInForce?:    'GoodTillCancel' | 'ImmediateOrCancel' | 'FillOrKill' | 'Day';
  execInst?:       string;    // comma-separated: 'ParticipateDoNotInitiate', 'ReduceOnly', 'Close', etc.
}
```

An empty `orders` array is valid — executor cancels all open orders it owns for that symbol.

### OrderPlan — Strategy → Planner (internal to Trader)

The strategy's expression of intent. Uses relative prices, size expressions, and high-level order type descriptions. The Planner resolves these into concrete `DesiredOrder` specs. Full vocabulary defined in [mental-model.html](../bot/mental-model.html) — Chapter 5.

## Build order

| Milestone | What gets built | Done when |
|---|---|---|
| M0 | Shared types in `shared/types` | Types compile, exported, documented |
| M1 | Bouncer + Executor | Executor authenticates via bouncer; static DesiredState → correct REST calls on testnet |
| M2 | Signal | Well-formed MarketSnapshot/IndicatorUpdate flow on queue |
| M3 | Trader framework + market maker strategy | DesiredState with correct order layout flows to executor |
| M4 | Integration | Orders appear on testnet matching strategy intent |
| M5 | Exchange app wiring | Bot app works via exchange app instead of direct testnet |

## Exchange abstraction

All services connect to `WS_URL` and `REST_URL` environment variables. For M1–M4 these point directly to BitMEX testnet. For M5 and beyond they point to the exchange app's `ws` and `rest` services. No service code changes required — only env var changes.

See [EXCHANGE.md](EXCHANGE.md) for the exchange app's WS and REST service details.
