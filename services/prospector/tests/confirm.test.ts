import { describe, expect, it, vi } from 'vitest';
import { html } from '../src/scanners/html';
import { probed } from '../src/scanners/probed';
import { s3 } from '../src/scanners/s3';
import type { ListingContext, Probed, ProbedContext, S3Page } from '../src/types';

/**
 * Asking a venue about one key: what each scanner answers for a key that is
 * there, one that is not, and a reply that is neither. The wire is stubbed at
 * the context, so what is tested is how each reads what it was given.
 */

const listingContext = (over: Partial<ListingContext>): ListingContext => ({
  name:    'venue',
  base:    'https://venue.example',
  keyRoot: 'data/',
  dateOf:  () => null,
  page:    vi.fn(),
  head:    vi.fn(),
  ...over,
} as ListingContext);

const replying = (status: number, headers: Record<string, string> = {}) =>
  vi.fn(async (): Promise<Probed> => ({ status, headers: new Headers(headers) }));

const row = (key: string, size: number) => ({ key, size, etag: `etag-${size}`, modified: '2026-01-01T00:00:00.000Z' });

describe('confirming a key on an S3 venue', () => {
  /** `…/A.zip` is also a prefix of `…/A.zip.CHECKSUM`, which sorts after it or before it equally well. */
  it('picks the exact key out of everything its prefix matches', async () => {
    const page = vi.fn(async (): Promise<S3Page> => ({
      listed:   [row('data/spot/A.zip.CHECKSUM', 92), row('data/spot/A.zip', 1_045)],
      prefixes: [],
      next:     null,
    }));

    const found = await s3.confirm(listingContext({ page: page as ListingContext['page'] }), 'spot/A.zip');

    expect(found).toEqual(row('data/spot/A.zip', 1_045));
    expect(page).toHaveBeenCalledWith(expect.stringContaining('?prefix=data/spot/A.zip&'), 's3');
  });

  it('reads a listing that does not hold the key as the key being absent', async () => {
    const page = vi.fn(async (): Promise<S3Page> => ({ listed: [], prefixes: [], next: null }));

    expect(await s3.confirm(listingContext({ page: page as ListingContext['page'] }), 'spot/A.zip')).toBe('absent');
  });

  it('reads a listing holding only longer keys as the key being absent', async () => {
    const page = vi.fn(async (): Promise<S3Page> => ({
      listed: [row('data/spot/A.zip.CHECKSUM', 92)], prefixes: [], next: null,
    }));

    expect(await s3.confirm(listingContext({ page: page as ListingContext['page'] }), 'spot/A.zip')).toBe('absent');
  });
});

describe('confirming a key on an HTML index venue', () => {
  it('asks the file itself, at the venue\'s address', async () => {
    const head = replying(200, { 'content-length': '1045' });

    await html.confirm(listingContext({ head }), 'spot/A.zip');

    expect(head).toHaveBeenCalledWith('https://venue.example/data/spot/A.zip');
  });

  it('hands back a reply that is not a success as it came', async () => {
    const head = replying(404, { server: 'nginx' });

    const reply = await html.confirm(listingContext({ head }), 'spot/A.zip');

    expect(reply).toMatchObject({ status: 404 });
    expect((reply as Probed).headers.get('server')).toBe('nginx');
  });

  it('reads size, ETag and last-modified off a success', async () => {
    const head = replying(200, {
      'content-length': '1045', etag: '"9CFC390F-gzip"', 'last-modified': 'Mon, 06 Oct 2025 09:39:01 GMT',
    });

    expect(await html.confirm(listingContext({ head }), 'spot/A.zip')).toEqual({
      key:      'spot/A.zip',
      size:     1_045,
      etag:     '9cfc390f',
      modified: 'Mon, 06 Oct 2025 09:39:01 GMT',
    });
  });

  /** An index serving no length has stated no size, which is not a size of zero. */
  it('records no size where the reply states none', async () => {
    const head = replying(200, { etag: '"9cfc390f"' });

    expect(await html.confirm(listingContext({ head }), 'spot/A.zip')).toMatchObject({ size: null });
  });
});

describe('confirming a key on a venue that can only be asked', () => {
  const context = (head: ProbedContext['head']): ProbedContext => ({ base: 'https://venue.example', keyRoot: 'cdn/', head });

  it('asks the file itself, at the venue\'s address', async () => {
    const head = replying(200, { 'content-length': '7' });

    await probed.confirm(context(head), 'trades/A.zip');

    expect(head).toHaveBeenCalledWith('https://venue.example/cdn/trades/A.zip');
  });

  it('hands back a reply that is not a success as it came', async () => {
    const head = replying(404, { 'x-cache': 'Error from cloudfront' });

    const reply = await probed.confirm(context(head), 'trades/A.zip');

    expect(reply).toMatchObject({ status: 404 });
    expect((reply as Probed).headers.get('x-cache')).toBe('Error from cloudfront');
  });

  it('reads size, ETag and last-modified off a success', async () => {
    const head = replying(200, {
      'content-length': '1045', etag: '"9CFC390F"', 'last-modified': 'Mon, 06 Oct 2025 09:39:01 GMT',
    });

    expect(await probed.confirm(context(head), 'trades/A.zip')).toEqual({
      key:      'trades/A.zip',
      size:     1_045,
      etag:     '9cfc390f',
      modified: 'Mon, 06 Oct 2025 09:39:01 GMT',
    });
  });

  /** The same reduction a probe applies, so the two can never disagree about one file. */
  it('reduces the ETag as every other reader of a HEAD does', async () => {
    const head = replying(200, { 'content-length': '7', etag: '"ABC-gzip"' });

    expect(await probed.confirm(context(head), 'trades/A.zip')).toMatchObject({ etag: 'abc' });
  });

  it.each(['', 'x', '-1', '1.5'])('records no size for a length of %j', async (length) => {
    const head = replying(200, { 'content-length': length });

    expect(await probed.confirm(context(head), 'trades/A.zip')).toMatchObject({ size: null });
  });
});
