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

For technical details and the full API reference, see [docs/services/BOUNCER.md](../../docs/services/BOUNCER.md).
