import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBuffer } from '../src/persistence/buffer';
import type { WsMessage } from '../src/types';

const VAULT = 'http://vault:3000';

const HOUR = 60 * 60_000;

// ── Date helpers ──────────────────────────────────────────────────────────────

/** ISO timestamp for a given date and optional time-of-day. */
const T = (date: string, time = '10:00:00.000') => `${date}T${time}Z`;

const D1 = '2020-01-01';
const D2 = '2020-01-02';
const D3 = '2020-01-03';

/** WsMessage with sensible defaults. */
const msg = (date: string, action: WsMessage['action'] = 'insert', data: WsMessage['data'] = []): WsMessage =>
  ({ action, date, data });

// ── Mock helpers ──────────────────────────────────────────────────────────────

const mockFetch = () =>
  vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 202 } as Response);

/** All WsMessages written to a specific table + date, flattened. */
const messagesFor = (table: string, date: string): WsMessage[] =>
  vi.mocked(global.fetch).mock.calls
    .filter(c =>
      (c[1] as RequestInit | undefined)?.method === 'POST' &&
      String(c[0]) === `${VAULT}/files/${table}/${date}/rows`,
    )
    .flatMap(c => JSON.parse((c[1] as RequestInit).body as string) as WsMessage[]);

/** Number of close POSTs sent for a specific table + date. */
const closeCount = (table: string, date: string): number =>
  vi.mocked(global.fetch).mock.calls.filter(c =>
    (c[1] as RequestInit | undefined)?.method === 'POST' &&
    String(c[0]) === `${VAULT}/files/${table}/${date}/close`,
  ).length;

/** All POST URLs called since the last vi.restoreAllMocks(). */
const postUrls = (): string[] =>
  vi.mocked(global.fetch).mock.calls
    .filter(c => (c[1] as RequestInit | undefined)?.method === 'POST')
    .map(c => String(c[0]));

// ── Routing: header date drives the target file ───────────────────────────────

describe('routing by header date', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes a message to the file matching its header date', async () => {
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1)));
    await buffer.flushAll();

    expect(messagesFor('trade', '20200101')).toHaveLength(1);
  });

  it('routes messages with different header dates to their respective files', async () => {
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1)));
    await buffer.receive('trade', msg(T(D2)));
    await buffer.flushAll();

    expect(messagesFor('trade', '20200101')).toHaveLength(1);
    expect(messagesFor('trade', '20200102')).toHaveLength(1);
  });

  it('routes an out-of-order (lower date) message to the correct file', async () => {
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D2)));
    await buffer.receive('trade', msg(T(D1))); // lower date — still routed to D1
    await buffer.flushAll();

    expect(messagesFor('trade', '20200101')).toHaveLength(1);
    expect(messagesFor('trade', '20200102')).toHaveLength(1);
  });

  it('routes interleaved dates correctly within a single flush', async () => {
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1, '10:00:00.000')));
    await buffer.receive('trade', msg(T(D2, '10:00:00.000')));
    await buffer.receive('trade', msg(T(D1, '12:00:00.000')));
    await buffer.flushAll();

    expect(messagesFor('trade', '20200101')).toHaveLength(2);
    expect(messagesFor('trade', '20200102')).toHaveLength(1);
  });
});

// ── Per-table independence ────────────────────────────────────────────────────

describe('per-table independence', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('advancing table A to D2 only schedules close for table A — not table B', async () => {
    vi.useFakeTimers();
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1)));
    await buffer.receive('quote', msg(T(D1)));
    await buffer.receive('trade', msg(T(D2))); // trade advances, quote stays

    await vi.advanceTimersByTimeAsync(HOUR);
    await buffer.flushAll();

    expect(closeCount('trade', '20200101')).toBe(1); // trade D1 closes
    expect(closeCount('quote', '20200101')).toBe(0); // quote D1 untouched
  });

  it('quote D1 is not closed until quote itself sees D2', async () => {
    vi.useFakeTimers();
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1)));
    await buffer.receive('quote', msg(T(D1)));
    await buffer.receive('trade', msg(T(D2)));
    await buffer.receive('quote', msg(T(D2)));

    await vi.advanceTimersByTimeAsync(HOUR);
    await buffer.flushAll();

    expect(closeCount('trade', '20200101')).toBe(1);
    expect(closeCount('quote', '20200101')).toBe(1);
  });

  it('tables that never advance never get a close scheduled', async () => {
    vi.useFakeTimers();
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('quote', msg(T(D1)));

    await vi.advanceTimersByTimeAsync(HOUR * 24);
    await buffer.flushAll();

    expect(closeCount('quote', '20200101')).toBe(0);
  });

  it('each table independently schedules close for its own previous date', async () => {
    vi.useFakeTimers();
    mockFetch();
    const buffer = createBuffer(VAULT);

    // trade: D1 → D3 (skipping D2)
    await buffer.receive('trade', msg(T(D1)));
    await buffer.receive('trade', msg(T(D3)));

    // quote: D1 → D2
    await buffer.receive('quote', msg(T(D1)));
    await buffer.receive('quote', msg(T(D2)));

    await vi.advanceTimersByTimeAsync(HOUR);
    await buffer.flushAll();

    expect(closeCount('trade', '20200101')).toBe(1);
    expect(closeCount('trade', '20200102')).toBe(0); // D2 never seen by trade
    expect(closeCount('quote', '20200101')).toBe(1);
    expect(closeCount('quote', '20200102')).toBe(0); // D2 not closed — quote is still there
  });
});

// ── Close scheduling ──────────────────────────────────────────────────────────

describe('close scheduling', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('close fires after exactly 1 hour', async () => {
    vi.useFakeTimers();
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1)));
    await buffer.receive('trade', msg(T(D2))); // schedules D1 close

    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(closeCount('trade', '20200101')).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await buffer.flushAll();
    expect(closeCount('trade', '20200101')).toBe(1);
  });

  it('schedules close exactly once even when many D2 messages arrive', async () => {
    vi.useFakeTimers();
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1)));
    await buffer.receive('trade', msg(T(D2, '10:00:00.000')));
    await buffer.receive('trade', msg(T(D2, '11:00:00.000')));
    await buffer.receive('trade', msg(T(D2, '12:00:00.000')));

    await vi.advanceTimersByTimeAsync(HOUR);
    await buffer.flushAll();

    expect(closeCount('trade', '20200101')).toBe(1);
  });

  it('close is ordered after all pending writes for that date', async () => {
    vi.useFakeTimers();
    const callOrder: string[] = [];

    vi.spyOn(global, 'fetch').mockImplementation((url) => {
      callOrder.push(String(url));
      return Promise.resolve({ ok: true, status: 202 } as Response);
    });

    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1)));
    await buffer.receive('trade', msg(T(D2)));

    await vi.advanceTimersByTimeAsync(HOUR);
    await buffer.flushAll();

    const writeIdx = callOrder.findIndex(u => u.includes('/trade/20200101/rows'));
    const closeIdx = callOrder.findIndex(u => u.includes('/trade/20200101/close'));

    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeLessThan(closeIdx);
  });

  it('no close scheduled when day does not advance', async () => {
    vi.useFakeTimers();
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1, '10:00:00.000')));
    await buffer.receive('trade', msg(T(D1, '11:00:00.000')));
    await buffer.receive('trade', msg(T(D1, '12:00:00.000')));

    await vi.advanceTimersByTimeAsync(HOUR);
    await buffer.flushAll();

    expect(closeCount('trade', '20200101')).toBe(0);
  });
});

// ── Out-of-order messages ─────────────────────────────────────────────────────
//
// A lower-date message is just processed normally — routed to its own file.
// It does not regress the current day or trigger any close.

describe('out-of-order messages', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('lower-date message is saved to the correct file without affecting current day', async () => {
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D2)));
    await buffer.receive('trade', msg(T(D1))); // out-of-order
    await buffer.flushAll();

    expect(messagesFor('trade', '20200101')).toHaveLength(1);
    expect(messagesFor('trade', '20200102')).toHaveLength(1);
  });

  it('out-of-order message does not trigger a close', async () => {
    vi.useFakeTimers();
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D2)));
    await buffer.receive('trade', msg(T(D1))); // lower — no close scheduled

    await vi.advanceTimersByTimeAsync(HOUR);
    await buffer.flushAll();

    expect(closeCount('trade', '20200101')).toBe(0);
    expect(closeCount('trade', '20200102')).toBe(0);
  });

  it('out-of-order message after a close was scheduled still lands in the right file', async () => {
    vi.useFakeTimers();
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1)));
    await buffer.receive('trade', msg(T(D2))); // D1 close in 1h

    await vi.advanceTimersByTimeAsync(HOUR - 60_000);
    await buffer.receive('trade', msg(T(D1, '23:59:00.000'))); // late D1, within window
    await buffer.flushAll();

    expect(messagesFor('trade', '20200101')).toHaveLength(2);
    expect(closeCount('trade', '20200101')).toBe(0); // close not fired yet
  });
});

// ── Shutdown ──────────────────────────────────────────────────────────────────

describe('shutdown (flushAll)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('cancels pending close timers — no close fires after shutdown', async () => {
    vi.useFakeTimers();
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1)));
    await buffer.receive('trade', msg(T(D2))); // D1 close in 1h

    await buffer.flushAll(); // cancels the timer

    await vi.advanceTimersByTimeAsync(HOUR * 2);

    expect(closeCount('trade', '20200101')).toBe(0);
  });

  it('flushes all buffered data across all tables before resolving', async () => {
    mockFetch();
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1)));
    await buffer.receive('quote', msg(T(D1)));
    await buffer.flushAll();

    expect(messagesFor('trade', '20200101')).toHaveLength(1);
    expect(messagesFor('quote', '20200101')).toHaveLength(1);
  });
});

// ── Vault response handling ───────────────────────────────────────────────────

describe('vault response handling', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drops messages without retry on 409 (file closing)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 409 } as Response);
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1)));
    await buffer.flushAll();

    const rowCalls = vi.mocked(global.fetch).mock.calls.filter(c =>
      String(c[0]).includes('/rows'),
    );

    expect(rowCalls).toHaveLength(1);
  });

  it('drops messages without retry on 418 (file sealed)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 418 } as Response);
    const buffer = createBuffer(VAULT);

    await buffer.receive('trade', msg(T(D1)));
    await buffer.flushAll();

    const rowCalls = vi.mocked(global.fetch).mock.calls.filter(c =>
      String(c[0]).includes('/rows'),
    );

    expect(rowCalls).toHaveLength(1);
  });
});

// ── Post URL helper smoke test ────────────────────────────────────────────────

describe('post URL helper', () => {
  afterEach(() => vi.restoreAllMocks());

  it('no posts are made before flush', async () => {
    mockFetch();
    createBuffer(VAULT);
    expect(postUrls()).toHaveLength(0);
  });
});
