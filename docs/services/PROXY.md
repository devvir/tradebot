# Proxy Service — Technical Documentation

## Overview

Proxy is a transparent HTTP forwarder. It accepts incoming requests, signs them via Bouncer, and forwards them to the real BitMEX REST API. Responses are streamed back verbatim — no transformation, buffering, or caching.

Proxy is a standalone service. Any service that needs authenticated access to BitMEX's REST API can use it — it does not know or care who the caller is.

---

## Responsibilities

- **Accept** any HTTP request (method, path, query string, body)
- **Identify** the target account from the `x-account-id` header or `api-key` header
- **Sign** the request through Bouncer (`POST /sign/rest`)
- **Forward** the signed request to the correct BitMEX environment with auth headers (`api-key`, `api-expires`, `api-signature`)
- **Return** the BitMEX response verbatim — status code, body, content-type

---

## Account Resolution

Proxy supports two modes for identifying the target account:

### 1. Account ID (sign via Bouncer)

The caller provides `x-account-id` (or `api-key` used as an account id). Proxy fetches the account from Bouncer to determine type and target URL, then requests a signature:

```
POST /sign/rest
{
  "accountId": "bitmex-testnet",
  "verb":      "GET",
  "path":      "/api/v1/order",
  "expires":   1711234567,
  "body":      ""
}
→ { apiKey, signature, expires }
```

Proxy adds the auth headers to the forwarded request:

```
api-key:       <apiKey>
api-expires:   <expires>
api-signature: <signature>
```

Proxy sees the `apiKey` (public) but never holds or sees the `apiSecret`. Bouncer handles the secret internally and returns only an expiring HMAC signature.

### 2. Pre-signed credentials (passthrough)

The caller provides `api-key` + `api-signature` (and optionally `api-expires`). Proxy looks up the account by `apiKey` only to resolve the target BitMEX URL — no signing step occurs. The caller's credentials are forwarded as-is.

In both cases, if the account cannot be resolved, proxy returns `401`.

---

## Request Forwarding

Proxy resolves the upstream BitMEX URL from the account type via `resolveBitmexUrls()` (from `@tradebot/utils`):

```
Incoming:  GET /order?symbol=XBTUSD&count=10
Upstream:  GET https://www.bitmex.com/api/v1/order?symbol=XBTUSD&count=10
```

Most headers from the caller are forwarded unchanged (e.g. `Content-Type`, `Accept`). The following are stripped before forwarding:

- `x-account-id` (internal, not a BitMEX header)
- `host`, `connection`, `transfer-encoding` (hop-by-hop)

In the account-id flow, any `api-*` headers from the caller are replaced by the signed headers from Bouncer.

---

## Response Handling

The upstream BitMEX response is returned to the caller as-is:
- Status code unchanged
- Body streamed (not buffered or parsed)
- Content-type unchanged
- Rate-limit headers (`x-ratelimit-*`) passed through

No response transformation, filtering, or caching occurs.

---

## Configuration

| Variable | Required | Description |
|---|---|---|
| `PROXY_PORT` | no | Host port mapping (default: random available port) |

The internal HTTP port is always `80`. `PROXY_PORT` controls only the host-side port mapping in `compose.yml`. The BitMEX URL for each request is resolved dynamically based on the account type stored in Bouncer.

---

## API Surface

Proxy accepts all HTTP methods and paths. It does not define or validate routes — it is fully pass-through. Invalid or unrecognised paths are forwarded to BitMEX and the BitMEX error response is returned unchanged.

Health check: `GET /health` (provided by service-kit).

---

## Error Responses

| Condition | Response |
|---|---|
| No account identifier provided | `401` |
| Account not found in Bouncer | `401` with descriptive error |
| Bouncer unreachable or erroring | `503 Service Unavailable` |
| BitMEX returns any HTTP status | Pass through unchanged |

---

## Architecture

```
Caller (any service)
    ↓  HTTP (x-account-id or api-key + api-signature)
proxy
    ↓  HTTPS (api-key + api-expires + api-signature)
BitMEX REST API
    ↑
Bouncer (signing, called internally by proxy)
```

Modules wire callers to proxy (or to alternative backends like `digger`) via compose-level configuration. Proxy itself is unaware of these arrangements.
