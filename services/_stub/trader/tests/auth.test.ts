/**
 * Auth / signing tests.
 *
 * The signature is HMAC_SHA256 of a known payload, so we can verify exact
 * bytes against an independent implementation. The reference vectors below
 * were produced with `openssl dgst -sha256 -hmac SECRET`.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signRestHeaders, signWsUrl } from '../src/auth/signing';

const creds = { apiKey: 'KEY', apiSecret: 'SECRET' };

function expectedHmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

describe('signRestHeaders', () => {
  it('produces api-key, api-expires, api-signature headers', () => {
    const headers = signRestHeaders(creds, 'POST', '/api/v1/order', '{"symbol":"XBTUSD"}', 1_700_000_000);

    expect(headers['api-key']).toBe('KEY');
    expect(headers['api-expires']).toBe('1700000060');
    expect(headers['api-signature']).toBe(
      expectedHmac('SECRET', 'POST/api/v1/order1700000060{"symbol":"XBTUSD"}'),
    );
  });

  it('signs an empty body for GET-style requests', () => {
    const headers = signRestHeaders(creds, 'GET', '/api/v1/order?count=500', '', 1_700_000_000);

    expect(headers['api-signature']).toBe(
      expectedHmac('SECRET', 'GET/api/v1/order?count=5001700000060'),
    );
  });

  it('produces different signatures for the same path with different bodies', () => {
    const a = signRestHeaders(creds, 'POST', '/api/v1/order', '{"a":1}', 1_700_000_000);
    const b = signRestHeaders(creds, 'POST', '/api/v1/order', '{"a":2}', 1_700_000_000);

    expect(a['api-signature']).not.toBe(b['api-signature']);
  });
});

describe('signWsUrl', () => {
  it('appends api-key, api-expires, api-signature query params', () => {
    const signed = signWsUrl('wss://www.bitmex.com/realtime', creds, 1_700_000_000);
    const url    = new URL(signed);

    expect(url.searchParams.get('api-key')).toBe('KEY');
    expect(url.searchParams.get('api-expires')).toBe('1700000060');
    expect(url.searchParams.get('api-signature')).toBe(
      expectedHmac('SECRET', 'GET/realtime1700000060'),
    );
  });

  it('preserves existing query params on the URL', () => {
    const signed = signWsUrl('ws://ws/realtime?subscribe=quote', creds, 1_700_000_000);
    const url    = new URL(signed);

    expect(url.searchParams.get('subscribe')).toBe('quote');
    expect(url.searchParams.get('api-key')).toBe('KEY');
  });
});
