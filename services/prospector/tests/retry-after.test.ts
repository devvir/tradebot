import { logger } from '@devvir/service-kit';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listing, surveyingAs } from '../src/context';
import { BODY_CEILING, BODY_TOO_LARGE, REDIRECT_REFUSED, declined } from '../src/deliver';
import { StoodDown, Stopped, fetchHead, fetchPage } from '../src/http';
import { _test_paces, paceFor } from '../src/pace';
import type { Server } from 'node:http';
import type { Adapter, ListingContext, Scanner } from '../src/types';

/**
 * What a request does with a venue's `Retry-After`, and with being asked to
 * stop while it waits. See `obey` and `waitOut` in `http.ts`.
 */

const URL_ = 'https://venue/?prefix=spot/';

/** Paced fast, with a ceiling short enough to state in a test. */
const venue = (): Adapter => ({
  name: 'slowed', base: 'https://venue', keyRoot: '',
  pacing: { perSecond: 1000, concurrency: 10, ceilingMs: 60_000 },
} as unknown as Adapter);

const EMPTY_LISTING = '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>';

/** S3 slowing us down: a 503 naming its error, so not a block, with a wait attached. */
const slowDown = (seconds: number): Response =>
  new Response('', { status: 503, headers: { 'x-amz-error-code': 'SlowDown', 'retry-after': String(seconds) } });

/** A stop that is asked for `ms` from now. */
const stopIn = (ms: number): (() => boolean) => {
  const at = Date.now() + ms;

  return () => Date.now() >= at;
};

beforeEach(() => _test_paces.clear());
afterEach(() => vi.unstubAllGlobals());

describe('a Retry-After within the ceiling', () => {
  it('is waited out in the request, which then asks again', async () => {
    const fetched = vi.fn()
      .mockResolvedValueOnce(slowDown(1))
      .mockResolvedValueOnce(new Response(EMPTY_LISTING));

    vi.stubGlobal('fetch', fetched);

    const started = Date.now();

    await expect(fetchPage(venue(), URL_, 's3')).resolves.toEqual({ listed: [], prefixes: [], next: null });

    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
    expect(fetched).toHaveBeenCalledTimes(2);
    expect(paceFor(venue(), URL_).blockedFor()).toBe(0);
  });

  /** A pause is not made to outlast whatever the venue asked for. */
  it('ends when a listing is asked to stop, within a beat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => slowDown(50)));

    const started = Date.now();

    await expect(fetchPage(venue(), URL_, 's3', '', stopIn(100))).rejects.toBeInstanceOf(Stopped);

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  /** The stop a pass is run with reaches a request made through the venue's listing context. */
  it('ends on the stop of the pass in progress', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => slowDown(50)));

    const adapter = venue() as Adapter<Scanner<ListingContext>>;
    const started = Date.now();

    await expect(surveyingAs(adapter, 'walk', () => listing(adapter).page(URL_, 's3'), stopIn(100)))
      .rejects.toBeInstanceOf(Stopped);

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('a Retry-After beyond the ceiling', () => {
  it('stands the venue down for the ceiling instead of waiting in the request', async () => {
    const fetched = vi.fn(async () => slowDown(3_600));

    vi.stubGlobal('fetch', fetched);

    const started = Date.now();
    const failure = await fetchPage(venue(), URL_, 's3').catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(StoodDown);
    expect((failure as StoodDown).askedMs).toBe(3_600_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetched).toHaveBeenCalledTimes(1);

    const held = paceFor(venue(), URL_).blockedFor();

    expect(held).toBeGreaterThan(59_000);
    expect(held).toBeLessThanOrEqual(60_000);
  });
});

/** A probe is asked over its own client rather than `fetch`, so it gets a real socket. */
describe('a probe told to wait', () => {
  let server: Server;
  let base:   string;
  let asked:  string;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(503, { 'x-amz-error-code': 'SlowDown', 'retry-after': asked });
      res.end();
    });

    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));

    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();

    await new Promise(done => server.close(done));
  });

  it('ends when it is asked to stop, within a beat', async () => {
    asked = '50';

    const started = Date.now();

    await expect(fetchHead({ ...venue(), base }, `${base}/a.zip`, stopIn(100))).rejects.toBeInstanceOf(Stopped);

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stands the venue down for the ceiling when asked for longer', async () => {
    asked = '3600';

    const adapter = { ...venue(), base };

    await expect(fetchHead(adapter, `${base}/a.zip`)).rejects.toBeInstanceOf(StoodDown);

    expect(paceFor(adapter, `${base}/a.zip`).blockedFor()).toBeGreaterThan(59_000);
  });
});

describe('a listing redirected off its host', () => {
  it('fails at once, without spending the attempts, and says where it pointed', async () => {
    const fetched = vi.fn(async () =>
      new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/' } }));

    vi.stubGlobal('fetch', fetched);

    const failure = await fetchPage(venue(), URL_, 's3').catch((err: unknown) => err);

    expect(declined(failure)).toBe(REDIRECT_REFUSED);
    expect((failure as Error).message).toContain('169.254.169.254');
    expect(fetched).toHaveBeenCalledTimes(1);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ url: URL_, err: expect.stringContaining('169.254.169.254') }),
      'Redirect refused');
  });
});

describe('a listing body past its ceiling', () => {
  /** Endless, in chunks large enough that passing the real ceiling costs a moment. */
  it('fails at once, without spending the attempts', async () => {
    let sent = 0;

    const fetched = vi.fn(async () => new Response(new ReadableStream({
      pull: (c) => { sent += 1024 * 1024; c.enqueue(new Uint8Array(1024 * 1024)); },
    })));

    vi.stubGlobal('fetch', fetched);

    const failure = await fetchPage(venue(), URL_, 's3').catch((err: unknown) => err);

    expect(declined(failure)).toBe(BODY_TOO_LARGE);
    expect(fetched).toHaveBeenCalledTimes(1);

    // The format's own ceiling is what ended it, not some other bound.
    expect(sent).toBeGreaterThan(BODY_CEILING.s3);
    expect(sent).toBeLessThan(BODY_CEILING.s3 + 8 * 1024 * 1024);
  });
});
