# rest

Serves a BitMEX-compatible REST API to bots. Bots make requests exactly as they would to BitMEX itself — with no knowledge of whether the underlying data is live or replayed.

## Design

This service is organized into three responsibility areas, implemented as separate route handlers:

### `routes/public.ts` — Market data (public GET endpoints)

- Endpoints: `/orderBook/L2`, `/trade`, `/quote`, `/instrument`, etc.
- Fetches fresh data from `snapshots` HTTP server on each request (no caching)
- Returns BitMEX-compatible JSON responses
- **Currently:** Stub responses with mocked data (see `server/mocks.json`)

### `routes/account.ts` — Account state (authenticated endpoints)

- GET endpoints: `/position`, `/margin`, `/execution`, `/wallet`, etc.
- POST/PUT/DELETE: future implementation
- **Currently:** Stub responses; real implementation deferred until account service is ready
- Returns `200` with stubbed body to enable early testing and validation

### `routes/order.ts` — Order management (authenticated endpoints)

- POST/PUT/DELETE `/order`, `/order/bulk`, `/order/closePosition`, etc.
- Forwards requests to `orders` exchange via RabbitMQ RPC (request + reply queue)
- In live mode: `proxy` service handles the `orders` exchange
- In replay mode: `account` service handles the `orders` exchange
- **Currently:** Stub responses; real RPC implementation deferred

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `RABBITMQ_URL` | yes | — | RabbitMQ connection URL |
| `SNAPSHOTS_URL` | no | `http://snapshots:3001` | Snapshots HTTP server endpoint |
| `SNAPSHOTS_EXCHANGE` | no | `snapshots` | Exchange for market data deltas (future use) |
| `ACCOUNT_EXCHANGE` | no | `account` | Exchange for account state updates (future use) |
| `ORDERS_EXCHANGE` | no | `orders` | Exchange for order management RPC (future use) |
| `REST_HTTP_PORT` | no | `3001` | HTTP server port |

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
pnpm dev       # Run with ts-node
```

## API Endpoints

All endpoints are under the service root (no `/api/v1` prefix). URL structure is designed to be swappable by reverse proxy if needed:

- `GET /orderBook/L2` — Order book level 2 (from snapshots)
- `GET /trade` — Recent trades (from snapshots)
- `GET /quote` — Recent quotes (from snapshots)
- `GET /instrument` — Available instruments (from snapshots)
- _More public endpoints as defined in bitmex-spec.ts_

- `GET /position` — Open positions (from account state, stub)
- `GET /margin` — Margin info (from account state, stub)
- `GET /execution` — Execution history (from account state, stub)
- _More account endpoints as defined in bitmex-spec.ts_

- `POST /order` — Place order (via order RPC, stub)
- `PUT /order` — Amend order (via order RPC, stub)
- `DELETE /order` — Cancel order (via order RPC, stub)
- _More order endpoints as defined in bitmex-spec.ts_

## File Structure

```
src/
  config.ts        — Configuration loading (env vars only)
  service.ts       — SKFactory service instance
  types.ts         — TypeScript types and Zod schemas
  index.ts         — Entry point (shows what, not how)
  routes/
    public.ts      — Market data endpoints
    account.ts     — Account endpoints
    order.ts       — Order endpoints
  server/
    server.ts      — Express app creation and setup
    mocks.json     — Temporary stub responses (remove when implementing real handlers)
```

## Testing

Early tests focus on:
- Request validation against Zod schemas
- Response structure and status codes
- Query parameter parsing
- Error handling

Tests can run against stub responses without RabbitMQ or snapshots service running.

## Future Implementation

Replace stub responses in `server/mocks.json` and route handlers as functionality is implemented:
1. Public endpoints: Consume deltas from `snapshots` exchange, maintain in-memory state
2. Account endpoints: Consume from `account` exchange, return current state
3. Order endpoints: Implement RabbitMQ RPC client, forward to `orders` exchange
