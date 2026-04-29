# Trading App

Runs autonomous trading bots against a BitMEX-compatible exchange. A bot
subscribes to market data on a WebSocket endpoint, decides what orders it
wants on a fixed tick, and reconciles intent against the live order book
via REST.

## Design principle: one process, BitMEX-compatible

The trader is a single service. Strategy, planner, converge algorithm, REST
client, and WS subscription all live in the same process. There is no
intermediate queue, no inter-service HTTP, and no separate "executor".

Every request the trader makes — REST and WS — is signed BitMEX-compatible
(HMAC-SHA256 of `verb + path + expires + body`). The same image works
against our own `ws` / `rest` services or against BitMEX directly: only
the URLs change. The proxy in front of our REST service forwards
pre-signed requests verbatim, so there is no "ours vs live" branch
anywhere in the trader code.

## Modules

| Module | Description | Path |
|---|---|---|
| `trade` | Runs the trader bot. Connects to a BitMEX-compatible WS + REST endpoint. | [modules/trading/trade/](../../modules/trading/trade/) |

## Services

| Service | Role | Docs |
|---|---|---|
| `trader` | Strategy orchestrator: subscribes to market data, runs a strategy each tick, reconciles desired vs live orders, fires signed REST calls. | [README](../../services/trader/README.md) · [TRADER.md](../services/TRADER.md) |

## External dependencies

The trader needs a BitMEX-compatible WS + REST endpoint reachable on the
shared network. In the default deployment this is provided by the
[Exchange App](EXCHANGE.md), specifically its `ws` and `rest` services
(reachable as `ws://ws` and `http://rest`). To run against BitMEX
directly, set `TRADER_WS_URL=wss://www.bitmex.com/realtime` and
`TRADER_REST_URL=https://www.bitmex.com` — no other change required.

## Data flow

```
                  ┌─ WS endpoint  ──► subscribe → cache ───┐
                  │  (ws://ws or                            │ snapshot
                  │   wss://www.bitmex.com/realtime)        │ each tick
                  │                                         ▼
        TRADER  ──┤                                   strategy.decide()
                  │                                         │ orders
                  │                                         ▼
                  │                                   converge + apply
                  │                                         │
                  └─ REST endpoint ◄────── signed REST ─────┘
                     (http://rest or
                      https://www.bitmex.com)
```

The Exchange App handles the actual exchange-side complexity (forwarding
to BitMEX, simulating in replay mode, broadcasting market data). The
trader doesn't know or care which mode it's in.

## Strategies

Strategies live under `services/trader/src/strategies/` and are registered
in `registry.ts`. Each strategy declares its data dependencies (`quote`,
`instrument`, etc.); the source layer translates these into BitMEX WS
table subscriptions on connect.

The bundled `range` strategy places one buy + one sell at ±1% from mid
each tick. It exists to validate the end-to-end flow, not as a real
trading strategy.

## Authentication

Every request — REST headers and WS connection URL — is signed using
`TRADER_API_KEY` + `TRADER_API_SECRET` (BitMEX-compatible HMAC). No
intermediate signing service is involved on the trader's request path.
The Exchange App's proxy still relies on Bouncer when signing on
behalf of unauthenticated callers, but the trader is always
authenticated and bypasses that.

## Configuration

See the [trade module README](../../modules/trading/trade/README.md) for
the full env reference. The required values are `TRADER_API_KEY` and
`TRADER_API_SECRET`; everything else has sensible defaults.
