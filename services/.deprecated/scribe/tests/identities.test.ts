import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { _test_signRequest, _test_available, _test_paceMs, _test_WATERLINE as WATERLINE, _test_PACE_MS as PACE_MS, reportRemaining } from '../src/bitmex/identities';
import type { Identity } from '../src/bitmex/types';

const acct = (): Identity => ({
  name:       'acct1',
  credential: { apiKey: 'KEY', apiSecret: 'SECRET' },
  limit:      120,
  remaining:  120,
  updatedAt:  Date.now(),
  client:     {} as any,
});

const res = (status: number, remaining?: string): Response =>
  ({
    status,
    headers: new Headers(remaining === undefined ? {} : { 'x-ratelimit-remaining': remaining }),
  } as Response);

// ── signRequest ─────────────────────────────────────────────────────────────

describe('identities — signRequest', () => {
  it('signs method + path + expires + body with the api secret', () => {
    const url  = 'https://www.bitmex.com/api/v1/instrument/compositeIndex?symbol=.BXBT&count=1';
    const path = '/api/v1/instrument/compositeIndex?symbol=.BXBT&count=1';

    const h = _test_signRequest({ apiKey: 'KEY', apiSecret: 'SECRET' }, 'GET', url, '');

    expect(h['api-key']).toBe('KEY');

    const expected = createHmac('sha256', 'SECRET')
      .update(`GET${path}${h['api-expires']}`)
      .digest('hex');

    expect(h['api-signature']).toBe(expected);
  });
});

// ── available (refill estimate — the anti-deadlock) ──────────────────────────

describe('identities — available', () => {
  const id = (remaining: number, agoMs: number): Identity => ({
    name: 'acct1', credential: null, limit: 120, remaining, updatedAt: Date.now() - agoMs, client: {} as any,
  });

  it('equals the reported value when just updated', () => {
    expect(_test_available(id(40, 0))).toBeCloseTo(40, 0);
  });

  it('climbs over time at limit/60 per second (so an exhausted bucket recovers)', () => {
    // 0 remaining + 30s × (120/60 = 2/s) = 60
    expect(_test_available(id(0, 30_000))).toBeCloseTo(60, 0);
  });

  it('never exceeds the limit', () => {
    expect(_test_available(id(100, 600_000))).toBe(120);
  });
});

// ── paceMs (post-response backpressure, keyed to the fullest identity) ───────

describe('identities — paceMs', () => {
  const id = (remaining: number, limit = 120): Identity => ({
    name: 'x', credential: null, limit, remaining, updatedAt: Date.now(), client: {} as any,
  });

  // Expectations are derived from the live WATERLINE/PACE_MS so retuning them
  // never breaks these tests — only the behaviour they describe matters.
  it('does not wait while the combined budget is over the waterline', () => {
    expect(_test_paceMs([id(WATERLINE), id(WATERLINE)])).toBe(0); // total 2×waterline
  });

  it('pools budget across identities — several low buckets still clear the waterline', () => {
    // each bucket well under the waterline, but together over it → no wait
    const each = Math.ceil(WATERLINE / 3) + 1;
    expect(_test_paceMs([id(each), id(each), id(each)])).toBe(0);
  });

  it('waits, graduated by how far the combined pool has fallen below the waterline', () => {
    const deficit = 20;
    const total   = WATERLINE - deficit;
    expect(_test_paceMs([id(total - 5), id(5)])).toBeCloseTo(deficit * PACE_MS, -2);
  });

  it('waits more the further the pool has drained', () => {
    const shallow = _test_paceMs([id(WATERLINE - 10)]);
    const deep    = _test_paceMs([id(WATERLINE - 30)]);
    expect(shallow).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(shallow);
  });
});

// ── reportRemaining ─────────────────────────────────────────────────────────

describe('identities — reportRemaining', () => {
  it('sets remaining to 0 on HTTP 429', () => {
    const id = acct();
    reportRemaining(id, res(429));
    expect(id.remaining).toBe(0);
  });

  it('reconciles remaining from the response header', () => {
    const id = acct();
    reportRemaining(id, res(200, '37'));
    expect(id.remaining).toBe(37);
  });

  it('leaves remaining unchanged when the header is absent', () => {
    const id = acct();
    reportRemaining(id, res(200));
    expect(id.remaining).toBe(120);
  });
});
