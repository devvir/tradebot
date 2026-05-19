import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registry } from '@devvir/service-kit';
import {
  list,
  listDone,
  get,
  markProgress,
  markDone,
  _test_PREFIX       as PREFIX,
  _test_encode       as encode,
  _test_decode       as decode,
  _test_resetClient  as resetClient,
} from '../../src/orchestration/progress';
import type { RedisClient } from '../../src/types';

// ── Mock redis ────────────────────────────────────────────────────────────────

/**
 * Minimal in-memory redis mock. Stores key/value, supports scanIterator
 * (filter by glob *), mGet, get, set.
 */
const makeRedis = (initial: Record<string, string> = {}): RedisClient & {
  set: ReturnType<typeof vi.fn>;
} => {
  const store = new Map(Object.entries(initial));

  const get   = vi.fn(async (k: string) => store.get(k) ?? null);
  const set   = vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; });
  const mGet  = vi.fn(async (keys: string[]) => keys.map(k => store.get(k) ?? null));

  const scanIterator = vi.fn(({ MATCH }: { MATCH: string }) => {
    /** Glob-to-regex: only `*` wildcard needed for our usage. */
    const re = new RegExp('^' + MATCH.replace(/\*/g, '.*') + '$');

    async function* iter(): AsyncIterable<string> {
      for (const k of store.keys()) if (re.test(k)) yield k;
    }

    return iter();
  });

  return { get, set, mGet, scanIterator } as unknown as RedisClient & {
    set: ReturnType<typeof vi.fn>;
  };
};

/** Wire the redis mock into the registry mock. */
const installRedis = (redis: RedisClient): void => {
  vi.mocked(registry.get).mockReturnValue({
    providers: { get: vi.fn(() => redis) },
  } as never);
};

beforeEach(() => {
  vi.mocked(registry.get).mockReset();
  resetClient();
});

// ── encode / decode round-trip ────────────────────────────────────────────────

describe('encoding (internal format)', () => {
  it('encodes pending as the bare numeric string', () => {
    expect(encode('pending', 42)).toBe('42');
  });

  it('encodes done with the done: prefix and the message count', () => {
    expect(encode('done', 100)).toBe('done:100');
  });

  it('encodes empty bucket as done:0', () => {
    expect(encode('done', 0)).toBe('done:0');
  });

  it('decodes pending numeric strings', () => {
    expect(decode('42')).toEqual({ state: 'pending', messages: 42 });
    expect(decode('0')).toEqual({ state: 'pending', messages: 0 });
  });

  it('decodes done strings', () => {
    expect(decode('done:100')).toEqual({ state: 'done', messages: 100 });
    expect(decode('done:0')).toEqual({ state: 'done', messages: 0 });
  });
});

// ── markProgress / markDone ───────────────────────────────────────────────────

describe('markProgress', () => {
  it('writes the pending encoding under farm:<table>:<date>', async () => {
    const redis = makeRedis();

    installRedis(redis);

    await markProgress('trade', '20240315', 42);

    expect(redis.set).toHaveBeenCalledWith(`${PREFIX}:trade:20240315`, '42');
  });
});

describe('markDone', () => {
  it('writes the done encoding under farm:<table>:<date>', async () => {
    const redis = makeRedis();

    installRedis(redis);

    await markDone('trade', '20240315', 99);

    expect(redis.set).toHaveBeenCalledWith(`${PREFIX}:trade:20240315`, 'done:99');
  });

  it('writes done:0 for an empty bucket', async () => {
    const redis = makeRedis();

    installRedis(redis);

    await markDone('trade', '20240315', 0);

    expect(redis.set).toHaveBeenCalledWith(`${PREFIX}:trade:20240315`, 'done:0');
  });
});

// ── get ───────────────────────────────────────────────────────────────────────

describe('get', () => {
  it('returns null when the key is missing', async () => {
    installRedis(makeRedis());

    await expect(get('trade', '20240315')).resolves.toBeNull();
  });

  it('returns a pending entry for a numeric value', async () => {
    installRedis(makeRedis({ [`${PREFIX}:trade:20240315`]: '42' }));

    await expect(get('trade', '20240315')).resolves.toEqual({
      table:    'trade',
      date:     '20240315',
      state:    'pending',
      messages: 42,
    });
  });

  it('returns a done entry for a done:N value', async () => {
    installRedis(makeRedis({ [`${PREFIX}:trade:20240315`]: 'done:100' }));

    await expect(get('trade', '20240315')).resolves.toEqual({
      table:    'trade',
      date:     '20240315',
      state:    'done',
      messages: 100,
    });
  });
});

// ── list ──────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('returns [] when nothing is stored', async () => {
    installRedis(makeRedis());

    await expect(list()).resolves.toEqual([]);
  });

  it('returns every entry, parsed', async () => {
    installRedis(makeRedis({
      [`${PREFIX}:trade:20240315`]:       '42',
      [`${PREFIX}:trade:20240316`]:       'done:100',
      [`${PREFIX}:orderBookL2:20240315`]: 'done:50',
    }));

    const entries = await list();

    expect(entries).toHaveLength(3);

    expect(entries.find(e => e.table === 'trade' && e.date === '20240315')).toEqual({
      table: 'trade', date: '20240315', state: 'pending', messages: 42,
    });
    expect(entries.find(e => e.table === 'orderBookL2' && e.date === '20240315')).toEqual({
      table: 'orderBookL2', date: '20240315', state: 'done', messages: 50,
    });
  });

  it('ignores keys that do not match the farm: prefix', async () => {
    installRedis(makeRedis({
      [`${PREFIX}:trade:20240315`]: '42',
      'customs:trade:20240315':     'legacy',     /** legacy key, should be skipped */
      'unrelated:key':              'whatever',
    }));

    const entries = await list();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.table).toBe('trade');
  });
});

// ── listDone ──────────────────────────────────────────────────────────────────

describe('listDone', () => {
  it('returns only entries with state=done', async () => {
    installRedis(makeRedis({
      [`${PREFIX}:trade:20240315`]:       '42',
      [`${PREFIX}:trade:20240316`]:       'done:100',
      [`${PREFIX}:orderBookL2:20240315`]: 'done:50',
    }));

    const done = await listDone();

    expect(done).toHaveLength(2);
    expect(done.every(e => e.state === 'done')).toBe(true);
  });

  it('returns [] when nothing is done', async () => {
    installRedis(makeRedis({ [`${PREFIX}:trade:20240315`]: '42' }));

    await expect(listDone()).resolves.toEqual([]);
  });
});
