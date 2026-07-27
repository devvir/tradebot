import { afterEach, describe, expect, it, vi } from 'vitest';
import { classify, _test_algorithmFor as algorithmFor, _test_retryAfterMs as retryAfterMs } from '../src/download';

// Verified against all five venues: a missing file and a missing symbol both
// answer 404 everywhere, so 404 is trustworthy as "not published".
describe('classify', () => {
  it('treats 404 as absent, not an error', () => {
    expect(classify(404)).toBe('absent');
  });

  it('backs off on rate limiting and blocks', () => {
    expect(classify(429)).toBe('backoff');
    expect(classify(403)).toBe('backoff');
  });

  it('backs off on any 5xx, including S3 SlowDown', () => {
    expect(classify(500)).toBe('backoff');
    expect(classify(503)).toBe('backoff');
  });

  it('retries anything else rather than guessing', () => {
    expect(classify(400)).toBe('retry');
    expect(classify(418)).toBe('retry');
  });
});

// Binance publishes SHA-256, KuCoin MD5, and neither says which. Getting this
// wrong rejected a perfectly good 1.1 MB KuCoin file during development.
describe('checksum algorithm detection', () => {
  it('reads the algorithm from the digest length', () => {
    expect(algorithmFor('cd0de08f983a4ec94ba6d6bed5625634')).toBe('md5');
    expect(algorithmFor('a'.repeat(64))).toBe('sha256');
  });

  it('declines to verify an unrecognised digest rather than failing the file', () => {
    expect(algorithmFor('abc')).toBeNull();
    expect(algorithmFor(undefined)).toBeNull();
  });
});

describe('retry-after parsing', () => {
  it('reads delay-seconds', () => {
    expect(retryAfterMs('30')).toBe(30_000);
  });

  it('reads an HTTP date', () => {
    const soon = new Date(Date.now() + 20_000).toUTCString();

    expect(retryAfterMs(soon)).toBeGreaterThan(10_000);
  });

  it('ignores nonsense and a missing header', () => {
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs('later')).toBeUndefined();
  });
});

const okBody = (): ReadableStream<Uint8Array> =>
  new ReadableStream({ start: (c) => { c.enqueue(new Uint8Array([1, 2])); c.close(); } });

const freshFile = () => ({
  url: 'https://x/f.zip', path: `dl/${Date.now()}-${Math.random()}.zip`,
  date: '20200101', symbol: 'S', period: 'daily' as const,
});

describe('verification happens before the rename', () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * A truncated response must leave nothing at the final path. When it did —
   * verification used to run after the rename — the short file was skipped as
   * complete on every later sweep: permanent silent corruption.
   */
  it('a truncated download leaves no file behind', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      headers: new Headers({ 'content-length': '999' }),   // only 2 bytes follow
      body: okBody(),
    })));

    const { download } = await import('../src/download');
    const { pathFor, exists } = await import('../src/store');
    const file = freshFile();

    const result = await download('binance', 'spot-trades', file);

    expect(result.status).toBe('failed');
    expect(await exists(pathFor('binance', file.path))).toBe(false);
  }, 60_000);

  it('a checksum mismatch leaves no file behind', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('.CHECKSUM'))
        return { ok: true, status: 200, headers: new Headers(),
          text: async () => 'a'.repeat(64) };   // sha256 that cannot match

      return { ok: true, status: 200,
        headers: new Headers({ 'content-length': '2' }), body: okBody() };
    }));

    const { download } = await import('../src/download');
    const { pathFor, exists } = await import('../src/store');
    const file = { ...freshFile(), checksumUrl: 'https://x/f.zip.CHECKSUM' };

    const result = await download('binance', 'spot-trades', file);

    expect(result.status).toBe('failed');
    expect(await exists(pathFor('binance', file.path))).toBe(false);
  }, 60_000);

  /**
   * A transfer-encoded response is decoded by undici, so the declared length
   * describes bytes that were never written — comparing would reject every
   * such file as truncated, forever.
   */
  it('skips the length comparison when the response was content-encoded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      headers: new Headers({ 'content-length': '999', 'content-encoding': 'gzip' }),
      body: okBody(),
    })));

    const { download } = await import('../src/download');
    const result = await download('binance', 'spot-trades', freshFile());

    expect(result.status).toBe('downloaded');
  });

  /**
   * The checksum companion is a 63-byte side request. When it cannot be
   * fetched, the file is accepted unverified rather than discarded — throwing
   * would re-download hundreds of MB over a flaky side request.
   */
  it('accepts the file unverified when the checksum companion is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('.CHECKSUM')) throw new TypeError('fetch failed');

      return { ok: true, status: 200,
        headers: new Headers({ 'content-length': '2' }), body: okBody() };
    }));

    const { download } = await import('../src/download');
    const file = { ...freshFile(), checksumUrl: 'https://x/f.zip.CHECKSUM' };

    const result = await download('binance', 'spot-trades', file);

    expect(result.status).toBe('downloaded');
  }, 30_000);
});

// OKX has been observed answering 404 for a URL that serves 200 seconds later.
// A believed absence lets the cursor step past that period permanently, so
// absences are confirmed before they are accepted.
describe('transient absences', () => {
  it('re-checks before accepting an absence', async () => {
    const calls: string[] = [];

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));

      // 404 once, then serve the file — the pattern observed on OKX.
      if (calls.length === 1) return { ok: false, status: 404, headers: new Headers() };

      return {
        ok: true, status: 200,
        headers: new Headers({ 'content-length': '2' }),
        body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); } }),
      };
    }));

    const { download } = await import('../src/download');
    const file = { url: 'https://x/f.zip', path: `t/${Date.now()}.zip`, date: '20200101',
      symbol: 'S', period: 'daily' as const };

    const result = await download('okx', 'swap-trades', file);

    expect(calls.length).toBeGreaterThan(1);
    expect(result.status).toBe('downloaded');

    vi.unstubAllGlobals();
  });
});
