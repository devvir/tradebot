# Proxy Service

Transparent HTTP forwarder that signs requests via Bouncer and forwards them to the BitMEX REST API. Responses are streamed back verbatim — no transformation, no caching.

## What it does

- Accepts any HTTP request (method, path, query string, body)
- Resolves the target BitMEX account via the `x-account-id` header or `api-key` header
- Signs the request through Bouncer (`POST /sign/rest`) — sees only the public `apiKey`, never the secret
- Forwards the signed request to the correct BitMEX environment (live or testnet)
- Returns the upstream response as-is: status code, headers, and body unchanged

Callers that already hold a valid BitMEX signature can pass `api-key` + `api-signature` directly; proxy will skip the signing step and only resolve the target URL.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROXY_PORT` | no | — | Host port mapping for the HTTP server (internal port is always 80) |

For technical details and architecture, see [docs/services/PROXY.md](../../docs/services/PROXY.md).
