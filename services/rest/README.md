# rest

BitMEX-compatible REST API façade. Proxies requests under `/api/v1/` to an upstream data backend (`REST_DATA_URL`), stripping the prefix so the upstream sees flat paths.

Bots make requests exactly as they would to BitMEX — same paths, same query parameters. The rest service is a transparent pass-through; it does not interpret, cache, or transform any response data.

## Auth convenience

For browser testing, `?accountId=<id>` is promoted to the `x-account-id` header so you don't need curl or a REST client:

```
http://localhost:3101/api/v1/instrument?symbol=XBTUSD&accountId=bitmex-live
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `REST_DATA_URL` | yes | Upstream HTTP endpoint to proxy to |

## Endpoints

All endpoints live under `/api/v1/` — matching the real BitMEX REST API path structure.

`GET /` returns a JSON message (not proxied).

## Development

```bash
pnpm build     # Compile TypeScript
pnpm start     # Run compiled service
pnpm dev       # Run with ts-node
pnpm test      # Run tests
```
1. Public endpoints: Consume deltas from `broadcast` exchange, maintain in-memory state
2. Account endpoints: Consume from `account` exchange, return current state
3. Order endpoints: Implement RabbitMQ RPC client, forward to `orders` exchange
