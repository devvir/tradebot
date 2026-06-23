import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock WS_TABLES + channel sets to a small, controlled universe so close
// iteration is predictable. Realtime endpoint: `trade`/`quote`/`orderBookL2`
// (timestamp-driven) + `liquidation` (date-driven — the closer's internal
// DATE_DRIVEN_TABLES set, not mocked, knows `liquidation` is timeless).
// Platform endpoint: `connected`.
vi.mock('@tradebot/utils', () => ({
  WS_TABLES:         new Set(['trade', 'quote', 'orderBookL2', 'liquidation', 'connected']),
  REALTIME_CHANNELS: ['trade', 'quote', 'orderBookL2', 'liquidation'],
  PLATFORM_CHANNELS: ['connected'],
}));

import { createCloser } from '../src/persistence/closer';

const VAULT  = 'http://vault:3000';
const SUFFIX = '';
const FIVE   = 5 * 60_000;

const TODAY     = '20200103';
const YESTERDAY = '20200102';
const TWO_AGO   = '20200101';

const beforeFn = () => Promise.resolve();

const closeUrl = (table: string, date: string): string =>
  `${VAULT}/files/${table}/${date}/close`;

const listUrl = (table: string): string =>
  `${VAULT}/files/${table}`;

const closeCalls = (table: string, date: string): number =>
  vi.mocked(global.fetch).mock.calls.filter(c =>
    (c[1] as RequestInit | undefined)?.method === 'POST' && String(c[0]) === closeUrl(table, date),
  ).length;

const listCalls = (table: string): number =>
  vi.mocked(global.fetch).mock.calls.filter(c =>
    ((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'GET' && String(c[0]) === listUrl(table),
  ).length;

/**
 * Mock fetch to:
 *   - list GETs return `listings[table]` (object or null → 404)
 *   - close POSTs return 200
 */
const mockVault = (listings: Record<string, Record<string, 'open' | 'closed'> | null>) => {
  vi.spyOn(global, 'fetch').mockImplementation((input, init) => {
    const url    = String(input);
    const method = init?.method ?? 'GET';

    if (method === 'GET') {
      for (const [table, listing] of Object.entries(listings)) {
        if (url === listUrl(table)) {
          if (listing === null) return Promise.resolve({ status: 404, ok: false } as Response);
          return Promise.resolve({ ok: true, status: 200, json: async () => listing } as Response);
        }
      }
      // Any other table → 404 (no data).
      return Promise.resolve({ status: 404, ok: false } as Response);
    }

    // POST /close
    return Promise.resolve({ ok: true, status: 200 } as Response);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY.slice(0,4)}-${TODAY.slice(4,6)}-${TODAY.slice(6,8)}T10:00:00.000Z`));
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// ── Mode detection ────────────────────────────────────────────────────────────

describe('mode detection', () => {
  it('new day equal to today → live: schedules a close for the advancing endpoint', async () => {
    mockVault({
      trade:       { [YESTERDAY]: 'open' },
      quote:       { [YESTERDAY]: 'open' },
      orderBookL2: { [YESTERDAY]: 'closed' },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('trade', TODAY); // first-seen at today — live, realtime endpoint

    await vi.advanceTimersByTimeAsync(FIVE);

    // All realtime-endpoint tables were listed.
    expect(listCalls('trade')).toBe(1);
    expect(listCalls('quote')).toBe(1);
    expect(listCalls('orderBookL2')).toBe(1);

    // Only OPEN buckets < today get closed.
    expect(closeCalls('trade',       YESTERDAY)).toBe(1);
    expect(closeCalls('quote',       YESTERDAY)).toBe(1);
    expect(closeCalls('orderBookL2', YESTERDAY)).toBe(0); // already closed
  });

  it('new day in the past → replay: schedules a per-table close only', async () => {
    mockVault({
      trade: { [TWO_AGO]: 'open' },
      quote: { [TWO_AGO]: 'open' }, // sibling — should NOT be touched
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('trade', TWO_AGO);
    closer.track('trade', YESTERDAY); // replay advance (YESTERDAY != TODAY)

    await vi.advanceTimersByTimeAsync(FIVE);

    expect(listCalls('trade')).toBe(1);
    expect(listCalls('quote')).toBe(0); // never listed
    expect(closeCalls('trade', TWO_AGO)).toBe(1);
    expect(closeCalls('quote', TWO_AGO)).toBe(0);
  });
});

// ── Per-endpoint isolation ──────────────────────────────────────────────────────

describe('per-endpoint close isolation', () => {
  it('a platform message closes ONLY platform buckets, leaving realtime open', async () => {
    mockVault({
      connected:   { [YESTERDAY]: 'open' },
      trade:       { [YESTERDAY]: 'open' },
      orderBookL2: { [YESTERDAY]: 'open' },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('connected', TODAY); // platform crosses midnight

    await vi.advanceTimersByTimeAsync(FIVE);

    // Platform bucket closed...
    expect(closeCalls('connected', YESTERDAY)).toBe(1);
    // ...realtime buckets untouched — realtime may still be lagging the prev day.
    expect(listCalls('trade')).toBe(0);
    expect(listCalls('orderBookL2')).toBe(0);
    expect(closeCalls('trade',       YESTERDAY)).toBe(0);
    expect(closeCalls('orderBookL2', YESTERDAY)).toBe(0);
  });

  it('a realtime message does not close platform buckets', async () => {
    mockVault({
      connected: { [YESTERDAY]: 'open' },
      trade:     { [YESTERDAY]: 'open' },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('trade', TODAY);

    await vi.advanceTimersByTimeAsync(FIVE);

    expect(closeCalls('trade', YESTERDAY)).toBe(1);
    expect(listCalls('connected')).toBe(0);
    expect(closeCalls('connected', YESTERDAY)).toBe(0);
  });

  it('the two endpoints schedule independently — both fire', async () => {
    mockVault({
      connected: { [YESTERDAY]: 'open' },
      trade:     { [YESTERDAY]: 'open' },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('trade',     TODAY); // arms realtime
    closer.track('connected', TODAY); // arms platform (separate timer)

    await vi.advanceTimersByTimeAsync(FIVE);

    expect(closeCalls('trade',     YESTERDAY)).toBe(1);
    expect(closeCalls('connected', YESTERDAY)).toBe(1);
  });

  it('a realtime DATE-driven table (liquidation) closes ONLY itself, not the lagging timestamp tables', async () => {
    mockVault({
      liquidation: { [YESTERDAY]: 'open' },
      trade:       { [YESTERDAY]: 'open' },
      orderBookL2: { [YESTERDAY]: 'open' },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('liquidation', TODAY); // realtime endpoint, but `_date_`-driven

    await vi.advanceTimersByTimeAsync(FIVE);

    // liquidation seals itself (its `_date_` crossed)...
    expect(closeCalls('liquidation', YESTERDAY)).toBe(1);
    // ...but it must NOT sweep instrument/orderBookL2 — their data hasn't crossed yet.
    expect(listCalls('trade')).toBe(0);
    expect(listCalls('orderBookL2')).toBe(0);
    expect(closeCalls('trade',       YESTERDAY)).toBe(0);
    expect(closeCalls('orderBookL2', YESTERDAY)).toBe(0);
  });

  it('a realtime TIMESTAMP-driven table sweeps the whole realtime endpoint, liquidation included', async () => {
    mockVault({
      trade:       { [YESTERDAY]: 'open' },
      orderBookL2: { [YESTERDAY]: 'open' },
      liquidation: { [YESTERDAY]: 'open' },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('trade', TODAY); // timestamp-driven → data crossed → sweep realtime

    await vi.advanceTimersByTimeAsync(FIVE);

    // Data crossing means every realtime bucket (incl. the date-driven liquidation) is complete.
    expect(closeCalls('trade',       YESTERDAY)).toBe(1);
    expect(closeCalls('orderBookL2', YESTERDAY)).toBe(1);
    expect(closeCalls('liquidation', YESTERDAY)).toBe(1);
  });
});

// ── Per-pool close isolation ──────────────────────────────────────────────────

describe('per-pool close isolation', () => {
  it('a pooled realtime table closes ONLY its own pool, leaving the primary pool open', async () => {
    mockVault({
      'orderBookL2.secondary': { [YESTERDAY]: 'open' },
      orderBookL2:             { [YESTERDAY]: 'open' },
      trade:                   { [YESTERDAY]: 'open' },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('orderBookL2.secondary', TODAY); // secondary-pool client crosses

    await vi.advanceTimersByTimeAsync(FIVE);

    // The secondary-pool bucket seals...
    expect(closeCalls('orderBookL2.secondary', YESTERDAY)).toBe(1);
    // ...primary-pool realtime tables untouched — a separate client, its own lag.
    expect(listCalls('orderBookL2')).toBe(0);
    expect(listCalls('trade')).toBe(0);
    expect(closeCalls('orderBookL2', YESTERDAY)).toBe(0);
    expect(closeCalls('trade',       YESTERDAY)).toBe(0);
  });

  it('a primary-pool realtime cross does NOT close a seen pooled sibling', async () => {
    mockVault({
      trade:                   { [YESTERDAY]: 'open' },
      orderBookL2:             { [YESTERDAY]: 'open' },
      'orderBookL2.secondary': { [YESTERDAY]: 'open' },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    // Register the pooled table as 'seen' on an earlier day so it's a real sweep
    // candidate; its own per-table close targets buckets < TWO_AGO → none here.
    closer.track('orderBookL2.secondary', TWO_AGO);
    // Now a primary-pool table crosses to today.
    closer.track('trade', TODAY);

    await vi.advanceTimersByTimeAsync(FIVE);

    // Primary-pool realtime group swept...
    expect(closeCalls('trade',       YESTERDAY)).toBe(1);
    expect(closeCalls('orderBookL2', YESTERDAY)).toBe(1);
    // ...but the pooled sibling's YESTERDAY bucket is NOT pulled in by the cross.
    expect(closeCalls('orderBookL2.secondary', YESTERDAY)).toBe(0);
  });

  it('the two pools schedule independently — both fire on their own cross', async () => {
    mockVault({
      orderBookL2:             { [YESTERDAY]: 'open' },
      'orderBookL2.secondary': { [YESTERDAY]: 'open' },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('orderBookL2',           TODAY); // arms (realtime, '')
    closer.track('orderBookL2.secondary', TODAY); // arms (realtime, 'secondary')

    await vi.advanceTimersByTimeAsync(FIVE);

    expect(closeCalls('orderBookL2',           YESTERDAY)).toBe(1);
    expect(closeCalls('orderBookL2.secondary', YESTERDAY)).toBe(1);
  });
});

// ── First-seen (startup recovery) ─────────────────────────────────────────────

describe('first-seen day (startup recovery)', () => {
  it('first message at today → schedules an endpoint close', async () => {
    mockVault({ trade: { [YESTERDAY]: 'open' } });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('trade', TODAY); // first-seen, equals today

    await vi.advanceTimersByTimeAsync(FIVE);

    expect(closeCalls('trade', YESTERDAY)).toBe(1);
  });

  it('first message in the past → schedules per-table close', async () => {
    mockVault({ trade: { [TWO_AGO]: 'open' } });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('trade', YESTERDAY); // first-seen, in the past

    await vi.advanceTimersByTimeAsync(FIVE);

    expect(closeCalls('trade', TWO_AGO)).toBe(1);
  });
});

// ── No-op cases ───────────────────────────────────────────────────────────────

describe('no-op cases', () => {
  it('same day repeated → no schedule fires', async () => {
    mockVault({ trade: { [YESTERDAY]: 'open' } });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('trade', TODAY);
    closer.track('trade', TODAY);
    closer.track('trade', TODAY);

    await vi.advanceTimersByTimeAsync(FIVE);

    // First call did schedule the realtime endpoint (today is today). Re-running same-day is no-op.
    // We just check no extra schedules happened by verifying only ONE pass ran:
    expect(listCalls('trade')).toBe(1);
  });

  it('lower day after a higher day is ignored — no new schedule', async () => {
    mockVault({ trade: null });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('trade', YESTERDAY);      // first-seen → per-table replay
    await vi.advanceTimersByTimeAsync(FIVE); // schedule runs

    vi.mocked(global.fetch).mockClear();

    closer.track('trade', TWO_AGO);        // lower than YESTERDAY → ignored
    await vi.advanceTimersByTimeAsync(FIVE);

    expect(listCalls('trade')).toBe(0);    // no new pass fired
  });
});

// ── Single-flight ─────────────────────────────────────────────────────────────

describe('single-flight scheduling', () => {
  it('multiple realtime tables advancing to today only fire ONE realtime close', async () => {
    mockVault({
      trade:       { [YESTERDAY]: 'open' },
      quote:       { [YESTERDAY]: 'open' },
      orderBookL2: { [YESTERDAY]: 'open' },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('trade',       TODAY);
    closer.track('quote',       TODAY);
    closer.track('orderBookL2', TODAY);

    await vi.advanceTimersByTimeAsync(FIVE);

    // One realtime-endpoint pass → each realtime table listed exactly once.
    expect(listCalls('trade')).toBe(1);
    expect(listCalls('quote')).toBe(1);
    expect(listCalls('orderBookL2')).toBe(1);
  });

  it('same table advancing twice in replay only schedules one close', async () => {
    mockVault({ trade: { [TWO_AGO]: 'open' } });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('trade', TWO_AGO);
    closer.track('trade', YESTERDAY); // schedules per-table

    // Advance halfway, then another bump — still in the same window.
    await vi.advanceTimersByTimeAsync(FIVE / 2);
    closer.track('trade', YESTERDAY); // no-op (same day)

    await vi.advanceTimersByTimeAsync(FIVE);

    expect(listCalls('trade')).toBe(1);
  });

  it('a new schedule can be armed after the previous one ran', async () => {
    mockVault({ trade: { [YESTERDAY]: 'open' } });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);

    closer.track('trade', TODAY); // schedules realtime endpoint
    await vi.advanceTimersByTimeAsync(FIVE); // it runs

    expect(listCalls('trade')).toBe(1);

    // Now a late message from another realtime table advances it to today —
    // the realtime endpoint timer slot is free, so a new close is scheduled.
    closer.track('quote', TODAY);
    await vi.advanceTimersByTimeAsync(FIVE);

    expect(listCalls('trade')).toBe(2); // listed again in the second pass
  });
});

// ── Listing semantics ─────────────────────────────────────────────────────────

describe('listing and close selection', () => {
  it('skips tables with no directory (404 listing)', async () => {
    mockVault({
      trade: null, // 404
      quote: { [YESTERDAY]: 'open' },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);
    closer.track('trade', TODAY); // live → realtime endpoint

    await vi.advanceTimersByTimeAsync(FIVE);

    expect(closeCalls('trade', YESTERDAY)).toBe(0);
    expect(closeCalls('quote', YESTERDAY)).toBe(1);
  });

  it('only closes open buckets strictly older than the target day', async () => {
    mockVault({
      trade: {
        [TWO_AGO]:   'open',   // < today → close
        [YESTERDAY]: 'open',   // < today → close
        [TODAY]:     'open',   // not < today → keep
      },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);
    closer.track('trade', TODAY);

    await vi.advanceTimersByTimeAsync(FIVE);

    expect(closeCalls('trade', TWO_AGO)).toBe(1);
    expect(closeCalls('trade', YESTERDAY)).toBe(1);
    expect(closeCalls('trade', TODAY)).toBe(0);
  });

  it('ignores already-closed buckets', async () => {
    mockVault({
      trade: { [YESTERDAY]: 'closed' },
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);
    closer.track('trade', TODAY);

    await vi.advanceTimersByTimeAsync(FIVE);

    expect(closeCalls('trade', YESTERDAY)).toBe(0);
  });
});

// ── beforeClosing callback ───────────────────────────────────────────────────

describe('beforeClosing', () => {
  it('runs before any close hits vault', async () => {
    const order: string[] = [];

    vi.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const url    = String(input);
      const method = init?.method ?? 'GET';

      if (method === 'GET') {
        order.push(`list:${url}`);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ [YESTERDAY]: 'open' }) } as Response);
      }

      order.push(`close:${url}`);
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });

    const before = vi.fn(async () => { order.push('before'); });

    const closer = createCloser(VAULT, SUFFIX, before);
    closer.track('trade', TODAY);

    await vi.advanceTimersByTimeAsync(FIVE);

    expect(before).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('before');
    // Any list/close calls come after.
    expect(order.slice(1).every(s => s.startsWith('list:') || s.startsWith('close:'))).toBe(true);
  });
});

// ── Suffix round-trip ────────────────────────────────────────────────────────

describe('suffix round-trip', () => {
  it('strips suffix from listing stems and passes bare dates to close', async () => {
    // Vault's listing returns stems of the form `<date>.<suffix>` when
    // suffix is set. The close endpoint expects the bare date in the path
    // and re-composes the suffix from `?suffix=`.
    vi.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const url    = String(input);
      const method = init?.method ?? 'GET';

      if (method === 'GET' && url === `${VAULT}/files/trade?suffix=local`) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ [`${YESTERDAY}.local`]: 'open' }),
        } as Response);
      }

      if (method === 'GET') return Promise.resolve({ status: 404, ok: false } as Response);
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });

    const closer = createCloser(VAULT, 'local', beforeFn);
    closer.track('trade', TODAY);

    await vi.advanceTimersByTimeAsync(FIVE);

    const calls = vi.mocked(global.fetch).mock.calls;
    const closeCall = calls.find(c =>
      (c[1] as RequestInit | undefined)?.method === 'POST' &&
      String(c[0]).includes('/close'),
    );

    expect(closeCall).toBeDefined();
    // Bare date in path, suffix in query — never `20200102.local` in the path.
    expect(String(closeCall![0])).toBe(`${VAULT}/files/trade/${YESTERDAY}/close?suffix=local`);
  });
});

// ── Retry on failure ─────────────────────────────────────────────────────────

describe('retry on failure', () => {
  it('reschedules the endpoint close when listing fails, then succeeds', async () => {
    let attempts = 0;

    vi.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const url    = String(input);
      const method = init?.method ?? 'GET';

      if (method === 'GET' && url === listUrl('trade')) {
        attempts++;
        if (attempts === 1) return Promise.resolve({ ok: false, status: 500 } as Response);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ [YESTERDAY]: 'open' }) } as Response);
      }

      if (method === 'GET') return Promise.resolve({ status: 404, ok: false } as Response);
      return Promise.resolve({ ok: true, status: 200 } as Response); // close
    });

    const closer = createCloser(VAULT, SUFFIX, beforeFn);
    closer.track('trade', TODAY);

    // First attempt fails.
    await vi.advanceTimersByTimeAsync(FIVE);
    expect(closeCalls('trade', YESTERDAY)).toBe(0);

    // Second attempt (rescheduled) succeeds.
    await vi.advanceTimersByTimeAsync(FIVE);
    expect(closeCalls('trade', YESTERDAY)).toBe(1);
  });
});
