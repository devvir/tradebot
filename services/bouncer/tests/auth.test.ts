import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { wsSign, restSign } from '../src/auth';

const SECRET  = 'test-secret';
const EXPIRES = 1700000000;

function hmac(msg: string): string {
  return createHmac('sha256', SECRET).update(msg).digest('hex');
}

describe('wsSign', () => {
  it('signs GET/realtime + expires', () => {
    expect(wsSign(SECRET, EXPIRES)).toBe(hmac(`GET/realtime${EXPIRES}`));
  });
});

describe('restSign', () => {
  it('signs verb + path + expires + body', () => {
    const verb = 'POST';
    const path = '/api/v1/order';
    const body = '{"symbol":"XBTUSD"}';

    expect(restSign(SECRET, verb, path, EXPIRES, body))
      .toBe(hmac(`${verb}${path}${EXPIRES}${body}`));
  });

  it('signs correctly with empty body', () => {
    expect(restSign(SECRET, 'GET', '/api/v1/order', EXPIRES, ''))
      .toBe(hmac(`GET/api/v1/order${EXPIRES}`));
  });
});
