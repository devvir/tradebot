import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBuffer } from '../src/persistence/buffer';
import type { WsMessage } from '../src/types';

const VAULT = 'http://vault:3000';

// ── Date helpers ──────────────────────────────────────────────────────────────

/** ISO timestamp for a given date and optional time-of-day. */
const T = (date: string, time = '10:00:00.000') => `${date}T${time}Z`;

/** Day stem (YYYYMMDD) for a YYYY-MM-DD input. */
const D = (date: string): string => date.replace(/-/g, '');

const D1 = '2020-01-01';
const D2 = '2020-01-02';

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

/** All POST URLs called since the last vi.restoreAllMocks(). */
const postUrls = (): string[] =>
  vi.mocked(global.fetch).mock.calls
    .filter(c => (c[1] as RequestInit | undefined)?.method === 'POST')
    .map(c => String(c[0]));

// ── Routing: per-message day drives the target file ───────────────────────────

describe('routing by day', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes a message to the file matching its day', async () => {
    mockFetch();
    const buffer = createBuffer(VAULT, '');

    await buffer.receive('trade', D(D1), msg(T(D1)));
    await buffer.flushAll();

    expect(messagesFor('trade', '20200101')).toHaveLength(1);
  });

  it('routes messages with different days to their respective files', async () => {
    mockFetch();
    const buffer = createBuffer(VAULT, '');

    await buffer.receive('trade', D(D1), msg(T(D1)));
    await buffer.receive('trade', D(D2), msg(T(D2)));
    await buffer.flushAll();

    expect(messagesFor('trade', '20200101')).toHaveLength(1);
    expect(messagesFor('trade', '20200102')).toHaveLength(1);
  });

  it('routes an out-of-order (lower day) message to the correct file', async () => {
    mockFetch();
    const buffer = createBuffer(VAULT, '');

    await buffer.receive('trade', D(D2), msg(T(D2)));
    await buffer.receive('trade', D(D1), msg(T(D1))); // lower day — still routed to D1
    await buffer.flushAll();

    expect(messagesFor('trade', '20200101')).toHaveLength(1);
    expect(messagesFor('trade', '20200102')).toHaveLength(1);
  });

  it('routes interleaved days correctly within a single flush', async () => {
    mockFetch();
    const buffer = createBuffer(VAULT, '');

    await buffer.receive('trade', D(D1), msg(T(D1, '10:00:00.000')));
    await buffer.receive('trade', D(D2), msg(T(D2, '10:00:00.000')));
    await buffer.receive('trade', D(D1), msg(T(D1, '12:00:00.000')));
    await buffer.flushAll();

    expect(messagesFor('trade', '20200101')).toHaveLength(2);
    expect(messagesFor('trade', '20200102')).toHaveLength(1);
  });
});

// ── Shutdown ──────────────────────────────────────────────────────────────────

describe('shutdown (flushAll)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('flushes all buffered data across all tables before resolving', async () => {
    mockFetch();
    const buffer = createBuffer(VAULT, '');

    await buffer.receive('trade', D(D1), msg(T(D1)));
    await buffer.receive('quote', D(D1), msg(T(D1)));
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
    const buffer = createBuffer(VAULT, '');

    await buffer.receive('trade', D(D1), msg(T(D1)));
    await buffer.flushAll();

    const rowCalls = vi.mocked(global.fetch).mock.calls.filter(c =>
      String(c[0]).includes('/rows'),
    );

    expect(rowCalls).toHaveLength(1);
  });

  it('drops messages without retry on 418 (file sealed)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 418 } as Response);
    const buffer = createBuffer(VAULT, '');

    await buffer.receive('trade', D(D1), msg(T(D1)));
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
    createBuffer(VAULT, '');
    expect(postUrls()).toHaveLength(0);
  });
});
