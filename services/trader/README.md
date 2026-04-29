# Trader Service

A trading bot that connects to a BitMEX-compatible WS + REST endpoint, runs a
strategy, and reconciles open orders against the strategy's intent each tick.

The same image works against our own `ws` / `rest` services or against BitMEX
directly — only the URLs change. Every request is signed BitMEX-compatible
(HMAC), and our proxy forwards pre-signed requests verbatim, so there is no
logical branch for "ours" vs "live" anywhere in the code.

## Module layout

```
src/
├── auth/        # BitMEX-compatible HMAC signing (REST + WS)
├── source/      # Inbound: WS lifecycle, data cache, table dispatch
├── rest/        # Outbound: signed REST client (create/amend/cancel/get)
├── strategies/  # Decision makers (registry + base class)
├── planner/     # PseudoOrder → BitMEX OrderPlan (rounding, lot/tick sizing)
├── executor/    # Converge algorithm + applier (amend → create → cancel)
└── core/        # Orchestrator + managed-orders bookkeeping
```

## Running

The service is deployed via the `modules/trading/trade` module. See that
module's README for environment variables and deployment notes.

## Adding a strategy

1. Implement a class extending `BaseStrategy` under `src/strategies/`.
2. Add an entry to `STRATEGIES` in `src/strategies/registry.ts` with the
   factory and default config (dependencies, tick interval, amend threshold).
3. Set `TRADER_STRATEGY=<name>` in the module env.

## Tests

```bash
pnpm --filter @tradebot/trader test
```

Covers: signing, config validation, strategy registry, converge algorithm,
managed-order bookkeeping, WS message parsing, table dispatch, signed REST
client, and the strategy → planner → cache → orchestrator integration.
