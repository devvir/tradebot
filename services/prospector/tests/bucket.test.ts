import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markDownloaded, putFiles, putVenue, recordSeries } from '../src/catalog';
import { _test_shapes } from '../src/catalog/bucket';
import { _test_scopes } from '../src/catalog/scope';
import { openCatalog } from '../src/database';
import { mount } from '../src/api';
import type { Application } from 'express';
import type { Found, Surveys } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A venue as a bucket: keys are what each file *is*, in byte order, and a walk
 * by the last key returns every file exactly once. See `bucket.ts`.
 */

let dir: string;
let db:  DatabaseSync;
let app: Application;
let id:  number;

/** Every file published here, by the key the listing must give it. */
const expected: string[] = [];

const found = (over: Partial<Found>): Found => ({
  market: 'perp', dataset: 'klines', variant: '1m', symbol: 'BTCUSDT', urlSymbol: 'BTCUSDT',
  pattern: 'k/1m/{YYYY}{MM}{DD}/{SYMBOL}.zip', ...over,
});

const publish = async (over: Partial<Found>, files: [string, string][]) => {
  const series = recordSeries(db, id, found(over), { first: files[0]![1] });

  await putFiles(db, files.map(([path, date]) => ({
    venueId: id, path, date, size: 7, etag: 'abc', modified: '2026-01-01T00:00:00.000Z',
    existence: 'confirmed' as const, seriesId: series.id!, seenAt: 'T1',
  })));
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bucket-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  id  = putVenue(db, 'binance', 'https://data.binance.vision', 'data/');
  _test_shapes.clear();
  _test_scopes.clear();
  expected.length = 0;

  const days = (symbol: string, folder: string, dates: string[]): [string, string][] =>
    dates.map(date => [`${folder}/${date}/${symbol}.zip`, date]);

  await publish({}, days('BTCUSDT', 'k/1m', ['20200101', '20200102', '20200201', '20210105']));
  await publish({ symbol: 'ETHUSDT', urlSymbol: 'ETHUSDT' }, days('ETHUSDT', 'k/1m', ['20200101', '20200301']));
  await publish({ symbol: '1INCHUSDT', urlSymbol: '1INCHUSDT' }, days('1INCHUSDT', 'k/1m', ['20200101']));
  await publish({ variant: '1h', pattern: 'k/1h/{YYYY}{MM}/{SYMBOL}.zip' },
    [['k/1h/202001/BTCUSDT.zip', '202001'], ['k/1h/202002/BTCUSDT.zip', '202002']]);
  await publish({ dataset: 'quotes', variant: '', pattern: 'q/{YYYY}{MM}{DD}/{SYMBOL}.zip' },
    [['q/20200101/BTCUSDT.zip', '20200101']]);
  await publish({ dataset: 'trades', variant: '', pattern: 't/{YYYY}{MM}/{SYMBOL}.zip' },
    [['t/202001/BTCUSDT.zip', '202001']]);
  await publish({ dataset: 'trades', variant: 'default', pattern: 'td/{YYYY}{MM}/{SYMBOL}.zip' },
    [['td/202001/BTCUSDT.zip', '202001']]);

  for (const [folder, month, letter, symbol, date] of [
    ['klines,1h', '202001', 'B', 'BTCUSDT', '202001'],
    ['klines,1h', '202002', 'B', 'BTCUSDT', '202002'],
    ['klines,1m', '202001', 'B', 'BTCUSDT', '20200101'],
    ['klines,1m', '202001', 'B', 'BTCUSDT', '20200102'],
    ['klines,1m', '202001', 'E', 'ETHUSDT', '20200101'],
    ['klines,1m', '202001', '_', '1INCHUSDT', '20200101'],
    ['klines,1m', '202002', 'B', 'BTCUSDT', '20200201'],
    ['klines,1m', '202003', 'E', 'ETHUSDT', '20200301'],
    ['klines,1m', '202101', 'B', 'BTCUSDT', '20210105'],
    ['quotes',    '202001', 'B', 'BTCUSDT', '20200101'],
    ['trades',    '202001', 'B', 'BTCUSDT', '202001'],
    ['trades,default', '202001', 'B', 'BTCUSDT', '202001'],
  ] as const)
    expected.push(`perp/${folder}/${month}/${letter}/${symbol}/binance|perp|${folder}|${symbol}|${date}.zip`);

  expected.sort();

  const surveys: Surveys = {
    venues: () => ['binance'], start: () => undefined, running: () => false,
    passing: () => false, paused: () => false, pause: () => false,
  };

  app = express();
  app.use(express.json());
  mount(app, db, '', surveys);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (path: string, init: RequestInit = {}) => {
  const server = app.listen(0);
  const port   = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
    });

    return { status: res.status, body: await res.json() as Record<string, unknown> & { Contents: { Key: string; FileId: number; Url: string }[] } };
  } finally {
    server.close();
  }
};

/** Every key of a walk, page by page, as a client following `NextMarker` would collect them. */
const walk = async (query = '', headers: Record<string, string> = {}): Promise<string[]> => {
  const keys: string[] = [];
  let marker = '';

  for (let pages = 0; pages < 100; pages++) {
    const { body } = await call(`/buckets/binance?max-keys=3${query}${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`, { headers });

    keys.push(...body.Contents.map(one => one.Key));

    if (! body['IsTruncated']) return keys;

    marker = String(body['NextMarker']);
  }

  throw new Error('The walk never ended');
};

describe('a bucket listing', () => {
  it('names every file by what it is, in byte order, once each', async () => {
    expect(await walk()).toEqual(expected);
  });

  /** `,` sorts below `/`, so a variant's folder comes before its bare dataset's. */
  it('orders keys as bytes, not as their parts', async () => {
    const keys    = await walk();
    const variant = keys.findIndex(one => one.startsWith('perp/trades,default/'));
    const bare    = keys.findIndex(one => one.startsWith('perp/trades/'));

    expect([...keys].sort()).toEqual(keys);
    expect(variant).toBeLessThan(bare);
  });

  it('gives a dataset without variants no comma', async () => {
    expect(await walk()).toContain('perp/quotes/202001/B/BTCUSDT/binance|perp|quotes|BTCUSDT|20200101.zip');
  });

  it('joins BaseUrl and Url into the venue address', async () => {
    const { body } = await call('/buckets/binance?max-keys=1');

    expect(`${String(body['BaseUrl'])}${body.Contents[0]!.Url}`)
      .toBe('https://data.binance.vision/data/k/1h/202001/BTCUSDT.zip');
  });

  it('lists only what is still owed when asked', async () => {
    markDownloaded(db, [{ venueId: id, path: 'k/1m/20200101/BTCUSDT.zip' }], 'T2');

    const keys = await walk('&pending=true');

    expect(keys).toHaveLength(expected.length - 1);
    expect(keys.some(one => one.endsWith('|BTCUSDT|20200101.zip') && one.includes('klines,1m'))).toBe(false);
  });

  it('takes 500 by default, 1,000 at most, and refuses what is not a count', async () => {
    expect((await call('/buckets/binance')).body['MaxKeys']).toBe(500);
    expect((await call('/buckets/binance?max-keys=5000')).body['MaxKeys']).toBe(1000);
    expect((await call('/buckets/binance?max-keys=zero')).status).toBe(400);
  });

  it('answers in XML unless JSON is asked for, as S3 does', async () => {
    const server = app.listen(0);
    const port   = (server.address() as { port: number }).port;

    try {
      for (const accept of [undefined, '*/*', 'text/html,application/xml;q=0.9,*/*;q=0.8']) {
        const res  = await fetch(`http://127.0.0.1:${port}/buckets/binance?max-keys=1`, accept ? { headers: { accept } } : {});
        const body = await res.text();

        expect(res.headers.get('content-type')).toMatch(/^application\/xml/);
        expect(body).toContain('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">');
        expect(body).toContain('<ETag>&quot;abc&quot;</ETag>');
        expect(body).toMatch(/<FileId>\d+<\/FileId>/);
        expect(body).toContain('<IsTruncated>true</IsTruncated>');
      }

      const missing = await fetch(`http://127.0.0.1:${port}/buckets/nowhere`);

      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain('<Code>NoSuchBucket</Code>');
    } finally {
      server.close();
    }
  });

  it('answers in V2 shape when asked, resuming the same way', async () => {
    const first  = await call('/buckets/binance?list-type=2&max-keys=4');
    const second = await call(`/buckets/binance?list-type=2&max-keys=4&continuation-token=${encodeURIComponent(String(first.body['NextContinuationToken']))}`);

    expect(first.body['KeyCount']).toBe(4);
    expect([...first.body.Contents, ...second.body.Contents].map(one => one.Key)).toEqual(expected.slice(0, 8));
  });
});

describe('a lens', () => {
  const lens = async (definition: unknown) =>
    call('/lenses', { method: 'POST', body: JSON.stringify({ slug: 'to-2020', definition }) });

  it('leaves out what it does not let through', async () => {
    await lens({ format: 1, venues: { '*': [{ effect: 'include', to: '202012' }] } });

    expect(await walk('', { 'x-catalog-lens': 'to-2020' })).toEqual(expected.filter(one => ! one.includes('/202101/')));
  });

  it('is a 404 when it does not exist, never the whole bucket', async () => {
    expect((await call('/buckets/binance', { headers: { 'x-catalog-lens': 'nope' } })).status).toBe(404);
  });
});

describe('a report by FileId', () => {
  /** The parser's own refusal reaches the caller as it is, never as a fault of this service. */
  it('answers a body over the limit with 413, not 500', async () => {
    const { status } = await call('/buckets/binance/report', {
      method: 'POST',
      body:   JSON.stringify({ downloaded: Array.from({ length: 30_000 }, (_, n) => 1_000_000 + n) }),
    });

    expect(status).toBe(413);
  });

  it('records what was downloaded, and counts ids that name nothing', async () => {
    const { body: page } = await call('/buckets/binance?max-keys=1');
    const { body }       = await call('/buckets/binance/report', {
      method: 'POST',
      body:   JSON.stringify({ downloaded: [page.Contents[0]!.FileId, 999_999, 'not-an-id'] }),
    });

    expect(body).toMatchObject({ recorded: 1, unknown: 2 });
    expect(await walk('&pending=true')).toEqual(expected.slice(1));
  });

  /** An id is the catalog's, not the venue's — one from another venue names nothing here. */
  it('refuses an id that belongs to another venue', async () => {
    putVenue(db, 'okx', 'https://static.okx.com', 'cdn/');

    const { body: page } = await call('/buckets/binance?max-keys=1');
    const { body }       = await call('/buckets/okx/report', {
      method: 'POST',
      body:   JSON.stringify({ downloaded: [page.Contents[0]!.FileId] }),
    });

    expect(body).toMatchObject({ recorded: 0, unknown: 1 });
    expect(await walk('&pending=true')).toEqual(expected);
  });
});
