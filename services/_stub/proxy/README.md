# Proxy Service

Transparent HTTP forwarder that signs requests via Bouncer and forwards them to the BitMEX REST API. Responses are streamed back verbatim — no transformation, no caching.

## What it does

- Accepts any HTTP request (method, path, query string, body)
- Targets live or testnet per the optional `x-testnet` header (`true|1` → testnet, anything else / absent → live)
- Resolves the target BitMEX account via the `x-account-id` header or `api-key` header
- Signs the request through Bouncer (`POST /sign/rest`) — sees only the public `apiKey`, never the secret
- Forwards the signed request to the correct BitMEX environment
- Returns the upstream response as-is: status code, headers, and body unchanged

Callers that already hold a valid BitMEX signature can pass `api-key` + `api-signature` directly; proxy will skip the signing step and only resolve the target URL.

A single running proxy serves both live and testnet — the choice is per-request. When the request has authentication, the account's own environment (`live` / `testnet`) wins; if an explicit `x-testnet` header disagrees with the account, the request is rejected with `400` rather than silently picking one. Anonymous requests (public endpoints) are routed purely by `x-testnet`.

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
