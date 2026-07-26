/**
 * BitMEX-compatible request signing.
 *
 * Same scheme works against BitMEX directly and against our `rest`/`ws` services
 * (the proxy detects pre-signed requests via the `api-key` + `api-signature`
 * pair and forwards them verbatim — see services/proxy/src/server/proxy.ts).
 *
 * REST signature: HMAC_SHA256(secret, verb + path + expires + body)
 * WS   signature: HMAC_SHA256(secret, "GET" + "/realtime" + expires)
 *
 * `expires` is a Unix timestamp (seconds) after which the request is rejected.
 */

import { createHmac } from 'node:crypto';
import type { ApiCredentials, HttpVerb, SignedRestHeaders } from './types';

/** Default validity window for a signed request, in seconds. */
const DEFAULT_EXPIRES_SEC = 60;

const WS_AUTH_PATH = '/realtime';

/**
 * Sign a REST request and return the BitMEX auth headers.
 *
 * `path` must include the API prefix (e.g. `/api/v1/order`) and any query string.
 * `body` is the raw request body string (empty for GET/DELETE without body).
 */
export function signRestHeaders(
  creds:  ApiCredentials,
  verb:   HttpVerb,
  path:   string,
  body:   string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SignedRestHeaders {
  const expires   = nowSec + DEFAULT_EXPIRES_SEC;
  const payload   = `${verb}${path}${expires}${body}`;
  const signature = hmacHex(creds.apiSecret, payload);

  return {
    'api-key':       creds.apiKey,
    'api-expires':   String(expires),
    'api-signature': signature,
  };
}

/**
 * Append BitMEX auth query params to a WebSocket URL.
 *
 * BitMEX accepts `?api-expires=&api-signature=&api-key=` on the connection URL.
 * Our `ws` service reads `api-key` for routing and ignores the signature.
 */
export function signWsUrl(
  url:    string,
  creds:  ApiCredentials,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const expires   = nowSec + DEFAULT_EXPIRES_SEC;
  const payload   = `GET${WS_AUTH_PATH}${expires}`;
  const signature = hmacHex(creds.apiSecret, payload);
  const u         = new URL(url);

  u.searchParams.set('api-key',       creds.apiKey);
  u.searchParams.set('api-expires',   String(expires));
  u.searchParams.set('api-signature', signature);

  return u.toString();
}

// ---- Private -----------------------------------------------------------

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// ---- Test exports ------------------------------------------------------

export const _test_hmacHex = hmacHex;
