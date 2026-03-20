# Bouncer Service

Signs exchange authentication requests on behalf of any service that needs exchange access. Stores credentials internally on a named Docker volume. Never exposes secrets — callers receive only `{ apiKey, signature, expires }`.

## What it does

- Stores account credentials (id, type, API key + secret, WS/REST URLs) on a named volume
- Returns account listings and individual accounts without secrets
- Signs BitMEX WS auth messages on demand (or inline with account fetch)
- Signs BitMEX REST request auth headers on demand

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOUNCER_TOKEN` | yes | — | Bearer token required on all requests |
| `BOUNCER_HTTP_PORT` | no | — | Host port mapped to 3010 (HTTP server) |
| `BOUNCER_HEALTH_PORT` | no | — | Host port mapped to 3000 (health check) |

For technical details and the full API reference, see [docs/services/BOUNCER.md](../../docs/services/BOUNCER.md).
