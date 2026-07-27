import { afterEach, describe, expect, it, vi } from 'vitest';
import { s3List } from '../src/venues/listing';

const page = (keys: string[], truncated = false): string =>
  `<?xml version="1.0"?><ListBucketResult><Prefix>p/</Prefix>` +
  `<IsTruncated>${truncated}</IsTruncated>` +
  keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('') +
  `</ListBucketResult>`;

afterEach(() => vi.unstubAllGlobals());

describe('s3List retries', () => {
  /**
   * Listings had no retry at all while downloads had five, so one dropped
   * socket cost a whole symbol for the sweep. S3 reaps idle keep-alive
   * connections and undici reuses them, which surfaces exactly like this.
   */
  it('retries a dropped connection and succeeds', async () => {
    let calls = 0;

    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;

      if (calls < 3) throw new TypeError('fetch failed: other side closed');

      return { ok: true, status: 200, text: async () => page(['a.zip']) };
    }));

    const { keys } = await s3List('https://x', 'p/', false);

    expect(calls).toBe(3);
    expect(keys).toEqual(['a.zip']);
  });

  it('retries a 5xx but gives up on a 404', async () => {
    let calls = 0;

    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;

      return { ok: false, status: 404, text: async () => '' };
    }));

    await expect(s3List('https://x', 'p/', false)).rejects.toThrow(/404/);
    expect(calls).toBe(1);   // an answer, not a hiccup
  });
});

describe('s3List marker', () => {
  /**
   * The marker is what stops a settled symbol costing a walk over its whole
   * history. It must reach the request, or the optimisation silently does
   * nothing.
   */
  it('passes `from` as the first marker, then follows pagination', async () => {
    const urls: string[] = [];

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);

      return {
        ok: true, status: 200,
        text: async () => (urls.length === 1
          ? page(['k1.zip'], true)
          : page(['k2.zip'], false)),
      };
    }));

    const { keys } = await s3List('https://x', 'p/', false, 'p/start-2026-07-27');

    expect(urls[0]).toContain('marker=p/start-2026-07-27');
    expect(urls[1]).toContain('marker=k1.zip');
    expect(keys).toEqual(['k1.zip', 'k2.zip']);
  });

  it('omits the marker entirely when no `from` is given', async () => {
    const urls: string[] = [];

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);

      return { ok: true, status: 200, text: async () => page(['a.zip']) };
    }));

    await s3List('https://x', 'p/', false);

    expect(urls[0]).not.toContain('marker=');
  });
});
