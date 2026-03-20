# Bouncer Service — Technical Documentation

## Overview

Bouncer is the credential authority for the platform. All services that need to authenticate with an exchange delegate signing to Bouncer — they never hold secrets themselves. Bouncer stores credentials on a named Docker volume and exposes an authenticated HTTP API for account management and request signing.

## Security Model

- Secrets (`apiSecret`) are stored on a named volume, never returned by any endpoint
- All endpoints require `Authorization: Bearer <BOUNCER_TOKEN>`
- Callers receive `{ apiKey, signature, expires }` — enough to authenticate, nothing more
- The Bearer token is a shared secret configured at deploy time; rotate it to revoke all service access

## Storage

Credentials live in a single JSON file (`/data/bouncer/accounts.json`) on a named Docker volume (`bouncer_data`). The volume survives container teardown. The file is read once at startup and held in memory; writes go to disk asynchronously on every mutation.

## API Reference

All endpoints require `Authorization: Bearer <BOUNCER_TOKEN>`.

---

### `GET /accounts`

Lists all registered accounts. Secrets are never included.

**Response `200`**
```json
[
  {
    "id":      "bitmex-testnet",
    "type":    "testnet",
    "wsUrl":   "wss://testnet.bitmex.com/realtime",
    "restUrl": "https://testnet.bitmex.com/api/v1",
    "apiKey":  "abc123"
  }
]
```

---

### `GET /accounts/:id`

Returns a single account. Pass `?expires=<unix_timestamp>` to include a WS auth signature in the same response — this saves callers a separate `POST /sign/ws` call when opening a WebSocket connection.

**Without `expires`**
```
GET /accounts/bitmex-testnet
→ 200 { id, type, wsUrl, restUrl, apiKey }
→ 404 { error: "Account 'bitmex-testnet' not found" }
```

**With `expires`**
```
GET /accounts/bitmex-testnet?expires=1700000000
→ 200 { id, type, wsUrl, restUrl, apiKey, signature, expires }
```

The `signature` is computed as `HMAC-SHA256(secret, "GET/realtime" + expires)` — the value expected by the BitMEX `authKeyExpires` WebSocket op.

---

### `POST /accounts`

Registers a new account. Returns `409` if the `id` already exists.

**Request body**
```json
{
  "id":        "bitmex-testnet",
  "type":      "testnet",
  "wsUrl":     "wss://testnet.bitmex.com/realtime",
  "restUrl":   "https://testnet.bitmex.com/api/v1",
  "apiKey":    "abc123",
  "apiSecret": "supersecret"
}
```

`type` must be one of: `live`, `testnet`, `replay`.

**Response `201`** — account summary without secret.

---

### `DELETE /accounts/:id`

Removes an account. Idempotent — deleting a non-existent account returns `204`.

**Response `204`** — no body.

---

### `POST /sign/ws`

Returns a WS authentication signature for the given account and expiry timestamp.

**Request body**
```json
{ "accountId": "bitmex-testnet", "expires": 1700000000 }
```

**Response `200`**
```json
{ "apiKey": "abc123", "signature": "...", "expires": 1700000000 }
```

Signature: `HMAC-SHA256(secret, "GET/realtime" + expires)`

Note: prefer `GET /accounts/:id?expires=` over this endpoint — it returns everything needed to open a WS connection in one request.

---

### `POST /sign/rest`

Returns an auth signature for a specific REST request. Called once per outbound REST call.

**Request body**
```json
{
  "accountId": "bitmex-testnet",
  "verb":      "POST",
  "path":      "/api/v1/order",
  "expires":   1700000000,
  "body":      "{\"symbol\":\"XBTUSD\"}"
}
```

`body` is optional — omit or pass empty string for requests with no body.

**Response `200`**
```json
{ "apiKey": "abc123", "signature": "...", "expires": 1700000000 }
```

Signature: `HMAC-SHA256(secret, verb + path + expires + body)`

The caller assembles the final request headers:
```
api-key:       <apiKey>
api-expires:   <expires>
api-signature: <signature>
```

## Error Handling

All errors return JSON `{ error: "<message>" }` with an appropriate HTTP status:

| Status | Cause |
|--------|-------|
| `400` | Invalid request body or query params (Zod validation failure) |
| `401` | Missing or incorrect `Authorization` header |
| `404` | Account ID not found |
| `409` | Account ID already exists (`POST /accounts`) |
| `500` | Unexpected server error |
