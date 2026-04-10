# Exchange App

Provides a fully BitMEX-compatible API surface — WebSocket and REST — so trading bots can connect to it exactly as they would to BitMEX, with no code changes. The underlying data source (live or replayed) is invisible to the bot.

## Design principle: functional services, smart modules

Services are pure functions: queue/socket in → queue/socket out. No service knows whether its input is live or historic data. No service makes behavioral decisions based on data origin.

The module decides what feeds what. Swapping from live to replay means changing the module wiring — not touching any service. This is what makes the live and replay modules interchangeable from the bot's perspective.

## Modules

| Module | Data source | Order handling | README |
|---|---|---|---|
| `live` | Real BitMEX WS via `broadcast` | Forwarded to real BitMEX REST via `proxy` | [compose](../../modules/exchange/live/compose.yml) |
| `replay` | Historical MongoDB via `reader` | Simulated fills via `account` | [compose](../../modules/exchange/replay/compose.yml) |

## Services

### Market data pipeline (both modules)

| Service | Role | README |
|---|---|---|
| `broadcast` | BitMEX WS → `broadcast` exchange | [README](../../services/broadcast/README.md) · [BROADCAST.md](../services/BROADCAST.md) |
| `snapshots` | `broadcast` exchange → in-memory delta accumulation → HTTP `/snapshot/{table}` | [README](../../services/snapshots/README.md) · [SNAPSHOTS.md](../services/SNAPSHOTS.md) |
| `ws` | HTTP snapshots fetch + `broadcast` deltas + `account` → WebSocket server (BitMEX protocol) | [README](../../services/ws/README.md) · [WS.md](../services/WS.md) |
| `rest` | HTTP snapshots fetch + `account` + `orders` RPC → HTTP server (BitMEX REST) | [README](../../services/rest/README.md) |

### Account / order handling (module-specific, interchangeable)

| Service | Module | Role | README |
|---|---|---|---|
| `proxy` | live | Forwards order RPC to real BitMEX REST; streams real private WS data to `account` exchange | [README](../../services/proxy/README.md) |
| `account` | replay | Simulates fills against market data; publishes simulated account state to `account` exchange | [README](../../services/account/README.md) |

`proxy` and `account` are interchangeable from the perspective of `ws` and `rest`: both consume the `orders` exchange and publish to the `account` exchange using the same routing key format.

## RabbitMQ exchange topology

| Exchange | Routing key | Published by | Consumed by |
|---|---|---|---|
| `broadcast` | `{table}.{action}.{symbol}` | `broadcast` | `snapshots`, `ws` |
| `account` | `{table}.{action}` | `proxy` or `account` | `ws`, `rest` |
| `orders` | `{method}.{path}` | `rest` (RPC) | `proxy` or `account` |

Snapshots no longer publishes to RabbitMQ — it accumulates state and serves via HTTP GET `/snapshot/{table}`. The `ws` and `rest` services fetch snapshots on demand via HTTP.

In the replay module, `reader` replaces `broadcast` as the upstream source for `snapshots`.

## Full data flow

```
LIVE:
  BitMEX WS ──► broadcast ──► [broadcast exchange]
                                       │
                                   snapshots ◄── ws/rest (HTTP /snapshot/{table})
                                       │
                                    ws ◄─── bots (WS)
                                      │
                                    rest ◄── bots (HTTP)

  BitMEX WS (private) ──► proxy ──► [account exchange] ──► ws, rest
  rest ──► [orders exchange] ──► proxy ──► BitMEX REST API

REPLAY:
  MongoDB ──► reader ──► [reader exchange]
                                │
                           snapshots ◄── ws/rest (HTTP /snapshot/{table})
                                │
                               ws ◄── bots (WS)
                                 │
                               rest ◄── bots (HTTP)

  rest ──► [orders exchange] ──► account ──► [account exchange] ──► ws, rest
  account ◄── snapshots (HTTP /snapshot/{table})  (price data for fill simulation)
```

## Bot perspective

A bot connecting to this exchange app:
- Points its WS client at `ws:80` instead of `wss://www.bitmex.com/realtime`
- Points its REST client at `rest:80` instead of `https://www.bitmex.com`
- Authenticates with an API key (any key is accepted in replay mode; real BitMEX key required in live mode via `proxy`)
- Subscribes to the same tables and receives the same message shapes
- Places and manages orders via the same REST endpoints
- Receives order/execution/position/margin updates on the same private WS streams

No bot code changes required.
