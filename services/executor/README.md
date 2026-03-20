# Executor Service

Receives a plan from the Trader via HTTP, reconciles it against live orders tracked through the exchange private WS, and fires the minimum set of REST calls needed to make them match.

## What it does

- Exposes `POST /plan` — the Trader posts the full list of orders it wants open right now, along with an account ID header
- Maintains a pool of WS connections keyed by account ID; credentials are fetched from Bouncer on demand
- On each incoming request: runs the converge algorithm (amend → create → cancel) and fires REST calls
- All orders placed carry a `clOrdID` prefix of `tb_<symbol>_` — scopes the executor's view to orders it owns for that market

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOUNCER_URL` | yes | — | URL of the Bouncer service, e.g. `http://bouncer:3010` |
| `BOUNCER_TOKEN` | yes | — | Bearer token for Bouncer authentication |
| `EXECUTOR_HTTP_PORT` | no | `3001` | Host port mapped to 3001 (HTTP server) |
| `EXECUTOR_HEALTH_PORT` | no | `3000` | Host port mapped to 3000 (health check) |

See [docs/services/EXECUTOR.md](../../docs/services/EXECUTOR.md) for architecture and algorithm details.
