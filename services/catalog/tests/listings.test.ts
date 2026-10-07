import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catchUp, lensNamed } from '@tradebot/lenses';
import { markDownloaded, openScratch, putFiles, putVenue, recordSeries, storeLens } from './fixture';
import type { LensDefinition } from '../src/types';
import type { Application } from 'express';
import type { SeriesSpec as Found } from './types';
import type { DatabaseSync } from 'node:sqlite';

const cfg = vi.hoisted(() => ({ port: 0, dbPath: '', token: '', prospectorApi: '' }));

vi.mock('../src/config', () => ({ default: cfg }));

const { mount } = await import('../src/api');

/**
 * The catalog as one bucket: keys say what each file *is*, sort as bytes, and a
 * walk by the last key returns every file exactly once. See `listing.ts`.
 */

let dir: string;
let db:  DatabaseSync;
let app: Application;
let binance: number;
let gate:    number;

const found = (over: Partial<Found>): Found => ({
  market: 'perp', dataset: 'klines', variant: '1m', symbol: 'BTCUSDT', urlSymbol: 'BTCUSDT',
  pattern: 'k/1m/{YYYY}{MM}{DD}/{SYMBOL}.zip', ...over,
});

const publish = async (venue: number, over: Partial<Found>, files: [string, string][]) => {
  const series = recordSeries(db, venue, found(over), { first: files[0]![1] });

  await putFiles(db, files.map(([path, date]) => ({
    venueId: venue, path, date, size: 7, etag: 'abc', modified: '2026-01-01T00:00:00.000Z',
    existence: 'confirmed' as const, seriesId: series.id, seenAt: 'T1',
  })));
};

const days = (symbol: string, folder: string, dates: string[]): [string, string][] =>
  dates.map(date => [`${folder}/${date}/${symbol}.zip`, date]);

/** Every key the bucket holds, as the listing must name them, in byte order. */
const EXPECTED = [
  'binance/perp/klines,1h/B/BTCUSDT/202001/binance|perp|klines,1h|BTCUSDT|202001.zip',
  'binance/perp/klines,1h/B/BTCUSDT/202002/binance|perp|klines,1h|BTCUSDT|202002.zip',
  'binance/perp/klines,1m/B/BTCUSDT/202001/binance|perp|klines,1m|BTCUSDT|20200101.zip',
  'binance/perp/klines,1m/B/BTCUSDT/202001/binance|perp|klines,1m|BTCUSDT|20200102.zip',
  'binance/perp/klines,1m/B/BTCUSDT/202002/binance|perp|klines,1m|BTCUSDT|20200201.zip',
  'binance/perp/klines,1m/B/BTCUSDT/202101/binance|perp|klines,1m|BTCUSDT|20210105.zip',
  'binance/perp/klines,1m/E/ETHUSDT/202001/binance|perp|klines,1m|ETHUSDT|20200101.zip',
  'binance/perp/klines,1m/E/ETHUSDT/202003/binance|perp|klines,1m|ETHUSDT|20200301.zip',
  'binance/perp/klines,1m/_/1INCHUSDT/202001/binance|perp|klines,1m|1INCHUSDT|20200101.zip',
  'binance/perp/quotes/B/BTCUSDT/202001/binance|perp|quotes|BTCUSDT|20200101.zip',
  'binance/perp/trades,default/B/BTCUSDT/202001/binance|perp|trades,default|BTCUSDT|202001.zip',
  'binance/perp/trades/B/BTCUSDT/202001/binance|perp|trades|BTCUSDT|202001.zip',
  'binance/perp/trades/B/BTCUSDT/202001/binance|perp|trades|BTCUSDT|20200101.zip',
  'binance/perp/trades/B/BTCUSDT/202001/binance|perp|trades|BTCUSDT|20200102.zip',
  'binance/perp/trades/B/BTCUSDT/202002/binance|perp|trades|BTCUSDT|202002.zip',
  'gate/spot/books/B/BTC_USDT/202107/gate|spot|books|BTC_USDT|20210726.part03.gz',
  'gate/spot/books/B/BTC_USDT/202107/gate|spot|books|BTC_USDT|20210726.part04.gz',
  'gate/spot/trades/@/202107/gate|spot|trades|@|202107.gz',
  'gate/spot/trades/@/202108/gate|spot|trades|@|202108.gz',
  'gate/spot/trades/A/ADA_USDT/202107/gate|spot|trades|ADA_USDT|202107.gz',
].sort();

beforeEach(async () => {
  dir     = mkdtempSync(join(tmpdir(), 'bucket-'));
  db      = openScratch(join(dir, 'catalog.db'));
  binance = putVenue(db, 'binance', 'https://data.binance.vision', 'data/');
  gate    = putVenue(db, 'gate', 'https://gate.example', '');

  await publish(binance, {}, days('BTCUSDT', 'k/1m', ['20200101', '20200102', '20200201', '20210105']));
  await publish(binance, { symbol: 'ETHUSDT', urlSymbol: 'ETHUSDT' }, days('ETHUSDT', 'k/1m', ['20200101', '20200301']));
  await publish(binance, { symbol: '1INCHUSDT', urlSymbol: '1INCHUSDT' }, days('1INCHUSDT', 'k/1m', ['20200101']));
  await publish(binance, { variant: '1h', pattern: 'k/1h/{YYYY}{MM}/{SYMBOL}.zip' },
    [['k/1h/202001/BTCUSDT.zip', '202001'], ['k/1h/202002/BTCUSDT.zip', '202002']]);
  await publish(binance, { dataset: 'quotes', variant: '', pattern: 'q/{YYYY}{MM}{DD}/{SYMBOL}.zip' },
    [['q/20200101/BTCUSDT.zip', '20200101']]);
  await publish(binance, { dataset: 'trades', variant: 'default', pattern: 'td/{YYYY}{MM}/{SYMBOL}.zip' },
    [['td/202001/BTCUSDT.zip', '202001']]);

  // A monthly and a daily rendering under one prefix: one stream, by date.
  await publish(binance, { dataset: 'trades', variant: '', pattern: 't/{YYYY}{MM}/{SYMBOL}.zip' },
    [['t/202001/BTCUSDT.zip', '202001'], ['t/202002/BTCUSDT.zip', '202002']]);
  await publish(binance, { dataset: 'trades', variant: '', pattern: 'td/{YYYY}{MM}{DD}/{SYMBOL}.zip' },
    [['td/20200101/BTCUSDT.zip', '20200101'], ['td/20200102/BTCUSDT.zip', '20200102']]);

  // A day in parts, the part named by the pattern's {PART}.
  await publish(gate, { market: 'spot', dataset: 'books', variant: '', symbol: 'BTC_USDT', urlSymbol: 'BTC_USDT',
    pattern: 'spot/orderbooks/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}{DD}{PART}.gz' },
  [['spot/orderbooks/202107/BTC_USDT-2021072604.gz', '20210726'], ['spot/orderbooks/202107/BTC_USDT-2021072603.gz', '20210726']]);

  // The venue-wide file has no letter folder, and lists before every instrument.
  await publish(gate, { market: 'spot', dataset: 'trades', variant: '', symbol: '@', urlSymbol: '@',
    pattern: 'spot/trades/{YYYY}{MM}/all-{YYYY}{MM}.gz' },
  [['spot/trades/202107/all-202107.gz', '202107'], ['spot/trades/202108/all-202108.gz', '202108']]);
  await publish(gate, { market: 'spot', dataset: 'trades', variant: '', symbol: 'ADA_USDT', urlSymbol: 'ADA_USDT',
    pattern: 'spot/trades/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}.gz' },
  [['spot/trades/202107/ADA_USDT-202107.gz', '202107']]);

  app = express();
  app.use(express.json({ limit: '5mb' }));
  mount(app, db, '');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (path: string, init: RequestInit = {}) => {
  const server = app.listen(0);
  const port   = (server.address() as { port: number }).port;

  try {
    const res  = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();

    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> & { Contents: { Key: string; Url: string }[] } };
  } finally {
    server.close();
  }
};

/** Every key of a walk, page by page, as a client following `NextMarker` would collect them. */
const walk = async (query = '', headers: Record<string, string> = {}): Promise<string[]> => {
  const keys: string[] = [];
  let marker = '';

  for (let pages = 0; pages < 100; pages++) {
    const { body } = await call(`/listings?max-keys=3${query}${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`, { headers });

    keys.push(...body.Contents.map(one => one.Key));

    if (! body['IsTruncated']) return keys;

    marker = String(body['NextMarker']);
  }

  throw new Error('The walk never ended');
};

describe('the bucket', () => {
  it('names every file by what it is, in byte order, once each', async () => {
    expect(await walk()).toEqual(EXPECTED);
  });

  /** `,` sorts below `/`, so a variant's folder comes before its bare dataset's. */
  it('orders keys as bytes, not as their parts', async () => {
    const keys = await walk();

    expect([...keys].sort()).toEqual(keys);
    expect(keys.findIndex(one => one.includes('/trades,default/')))
      .toBeLessThan(keys.findIndex(one => one.includes('/trades/')));
  });

  /** Two series under one prefix are one stream: a month's file, then its days, then the next month. */
  it('interleaves a monthly and a daily rendering by date', async () => {
    expect((await walk('&prefix=binance/perp/trades/')).map(one => one.split('|').at(-1)))
      .toEqual(['202001.zip', '20200101.zip', '20200102.zip', '202002.zip']);
  });

  it('names each part of a split day apart, in order', async () => {
    expect(await walk('&prefix=gate/')).toEqual(EXPECTED.filter(one => one.startsWith('gate/')));
  });

  /** The address is not the listing's to give: a server can be reached at several, and `/venues` lists them. */
  it('gives each object its file\'s path and its server\'s name, and no address', async () => {
    const { body } = await call('/listings?prefix=binance/perp/quotes/');

    expect(body.Contents).toMatchObject([{ Path: 'q/20200101/BTCUSDT.zip', Host: '' }]);
    expect(body.Contents[0]).not.toHaveProperty('Url');
  });

  it('lists only what is still owed when asked', async () => {
    markDownloaded(db, [{ venueId: binance, path: 'k/1m/20200101/BTCUSDT.zip' }], 'T2');

    expect(await walk('&pending=true')).toEqual(EXPECTED.filter(one => ! one.endsWith('klines,1m|BTCUSDT|20200101.zip')));
  });

  it('takes 500 by default, 1,000 at most, and refuses what is not a count', async () => {
    expect((await call('/listings')).body['MaxKeys']).toBe(500);
    expect((await call('/listings?max-keys=5000')).body['MaxKeys']).toBe(1000);
    expect((await call('/listings?max-keys=zero')).status).toBe(400);
  });

  it('answers in XML unless JSON is asked for, as S3 does', async () => {
    const server = app.listen(0);
    const port   = (server.address() as { port: number }).port;

    try {
      const res  = await fetch(`http://127.0.0.1:${port}/listings?max-keys=1`);
      const body = await res.text();

      expect(res.headers.get('content-type')).toMatch(/^application\/xml/);
      expect(body).toContain('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">');
      expect(body).toContain('<ETag>&quot;abc&quot;</ETag>');
      expect(body).toContain('<IsTruncated>true</IsTruncated>');
    } finally {
      server.close();
    }
  });

  it('answers in V2 shape when asked, resuming the same way', async () => {
    const first  = await call('/listings?list-type=2&max-keys=4');
    const second = await call(`/listings?list-type=2&max-keys=4&continuation-token=${encodeURIComponent(String(first.body['NextContinuationToken']))}`);

    expect(first.body['KeyCount']).toBe(4);
    expect([...first.body.Contents, ...second.body.Contents].map(one => one.Key)).toEqual(EXPECTED.slice(0, 8));
  });
});

describe('a prefix', () => {
  it('narrows to a venue', async () => {
    expect(await walk('&prefix=binance/')).toEqual(EXPECTED.filter(one => one.startsWith('binance/')));
  });

  it('narrows to anything finer, down into a month', async () => {
    expect(await walk('&prefix=binance/perp/klines,1m/B/BTCUSDT/2020'))
      .toEqual(EXPECTED.filter(one => one.startsWith('binance/perp/klines,1m/B/BTCUSDT/2020')));
  });

  /** `@` is only ever the bucket, so a prefix reaching into its months is read at its depth. */
  it('narrows into the bucket\'s months, a level shallower', async () => {
    expect(await walk('&prefix=gate/spot/trades/@/2021')).toEqual([
      'gate/spot/trades/@/202107/gate|spot|trades|@|202107.gz',
      'gate/spot/trades/@/202108/gate|spot|trades|@|202108.gz',
    ]);
  });

  it('lists the bucket before every instrument of its dataset', async () => {
    expect((await walk('&prefix=gate/spot/trades/')).map(one => one.split('/')[3]))
      .toEqual(['@', '@', 'A']);
  });

  it('answers nothing where nothing starts with it', async () => {
    expect(await walk('&prefix=okx/')).toEqual([]);
  });

  it('resumes inside it from a marker', async () => {
    const all = EXPECTED.filter(one => one.startsWith('binance/perp/klines,1m/'));

    expect(await walk(`&prefix=binance/perp/klines,1m/&marker=${encodeURIComponent(all[2]!)}`.replace(/&marker=.*$/, '')))
      .toEqual(all);

    const { body } = await call(`/listings?prefix=binance/perp/klines,1m/&marker=${encodeURIComponent(all[2]!)}`);

    expect(body.Contents.map(one => one.Key)).toEqual(all.slice(3));
  });
});

describe('a lens', () => {
  /** A lens in the catalog, as prospector stores one: this service only reads through it. */
  const lens = async (slug: string, definition: unknown) =>
    storeLens(db, slug, '', '', definition as LensDefinition);

  it('leaves out what it does not let through', async () => {
    await lens('to-2020', { format: 1, venues: { '*': [{ effect: 'include', to: '202012' }] } });

    expect(await walk('', { 'x-catalog-lens': 'to-2020' })).toEqual(EXPECTED.filter(one => one.split('/')[5]! <= '202012'));
  });

  /** Named in the query too, so a browser can look through one; a header, where sent, wins. */
  it('takes the lens from the query where no header names it', async () => {
    await lens('to-2020', { format: 1, venues: { '*': [{ effect: 'include', to: '202012' }] } });

    const through = EXPECTED.filter(one => one.split('/')[5]! <= '202012');

    expect(await walk('&lens=to-2020')).toEqual(through);
    expect(await walk('&lens=nope', { 'x-catalog-lens': 'to-2020' })).toEqual(through);
    expect((await call('/listings?lens=nope')).status).toBe(422);
  });

  /** An include and an exclude can leave a series two spans; both are listed, the hole is not. */
  it('lists both sides of a hole it cuts', async () => {
    await lens('holed', { format: 1, venues: { binance: [
      { effect: 'include', datasets: [{ dataset: 'klines', variant: '1m' }] },
      { effect: 'exclude', from: '202002', to: '202012' },
    ] } });

    expect(await walk('&prefix=binance/perp/klines,1m/B/', { 'x-catalog-lens': 'holed' })).toEqual([
      'binance/perp/klines,1m/B/BTCUSDT/202001/binance|perp|klines,1m|BTCUSDT|20200101.zip',
      'binance/perp/klines,1m/B/BTCUSDT/202001/binance|perp|klines,1m|BTCUSDT|20200102.zip',
      'binance/perp/klines,1m/B/BTCUSDT/202101/binance|perp|klines,1m|BTCUSDT|20210105.zip',
    ]);
  });

  /** A series found after the lens was saved is in it once prospector has folded it in. */
  it('takes in series that appear after it was saved', async () => {
    await lens('gate-only', { format: 1, venues: { gate: [{ effect: 'include' }] } });

    await publish(gate, { market: 'spot', dataset: 'books', variant: '', symbol: 'ETH_USDT', urlSymbol: 'ETH_USDT',
      pattern: 'spot/orderbooks/{YYYY}{MM}/{SYMBOL}-{YYYY}{MM}{DD}{PART}.gz' },
    [['spot/orderbooks/202107/ETH_USDT-2021072600.gz', '20210726']]);

    while (catchUp(db, lensNamed(db, 'gate-only')!, 1_000));

    expect(await walk('', { 'x-catalog-lens': 'gate-only' })).toContain(
      'gate/spot/books/E/ETH_USDT/202107/gate|spot|books|ETH_USDT|20210726.part00.gz');
  });

  it('is a 422 when it does not exist, never the whole bucket', async () => {
    expect((await call('/listings', { headers: { 'x-catalog-lens': 'nope' } })).status).toBe(422);
  });
});

describe('a report', () => {
  /** A stand-in prospector, recording what it was asked to settle; it can drop the first connections it gets. */
  const prospector = async (status = 200, drops = 0) => {
    const got: unknown[] = [];
    const server = createServer((req, res) => {
      if (drops > 0) { drops--; req.socket.destroy(); return; }

      let body = '';

      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        got.push({ url: req.url, body: JSON.parse(body) });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });

    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
    cfg.prospectorApi = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    return { got, close: () => new Promise(done => server.close(done)) };
  };

  const report = (body: unknown, headers: Record<string, string> = {}) =>
    call('/listings/report', { method: 'POST', body: JSON.stringify(body), headers });

  const idOf = (path: string): number =>
    (db.prepare('SELECT rowid AS id FROM file WHERE path = ?').get(path) as { id: number }).id;

  it('settles every key it can name, by id, and answers 200', async () => {
    const stand = await prospector();

    try {
      const { status } = await report({
        downloaded: [EXPECTED.find(one => one.endsWith('part03.gz'))],
        mismatched: [{ Key: EXPECTED.find(one => one.endsWith('quotes|BTCUSDT|20200101.zip')), Size: 9 }],
      });

      expect(status).toBe(200);
      expect(stand.got).toEqual([{ url: '/reports', body: {
        downloaded: [idOf('spot/orderbooks/202107/BTC_USDT-2021072603.gz')],
        failed:     [],
        mismatched: [{ FileId: idOf('q/20200101/BTCUSDT.zip'), Size: 9 }],
      } }]);
    } finally {
      await stand.close();
    }
  });

  /** The request succeeded; some of its parts did not — 207, with only those in the body. */
  it('answers 207 with the keys it could not settle', async () => {
    const stand = await prospector();

    try {
      const { status, body } = await report({ downloaded: [EXPECTED[0], 'binance/perp/klines,1m/B/BTCUSDT/202001/binance|perp|klines,1m|BTCUSDT|20200109.zip'] });

      expect(status).toBe(207);
      expect(body['Error']).toMatchObject([{ Code: 'NoSuchKey' }]);
      expect((stand.got[0] as { body: { downloaded: number[] } }).body.downloaded).toHaveLength(1);
    } finally {
      await stand.close();
    }
  });

  it('refuses a key the lens it reads through does not let through', async () => {
    const stand = await prospector();

    try {
      storeLens(db, 'to-2020', '', '', { format: 1, venues: { '*': [{ effect: 'include', to: '202012' }] } });

      const late = EXPECTED.find(one => one.includes('/202101/'))!;
      const { status, body } = await report({ downloaded: [late, EXPECTED[0]] }, { 'x-catalog-lens': 'to-2020' });

      expect(status).toBe(207);
      expect(body['Error']).toMatchObject([{ Key: late, Code: 'AccessDenied' }]);
    } finally {
      await stand.close();
    }
  });

  it('settles the bucket by its key', async () => {
    const stand = await prospector();

    try {
      expect((await report({ downloaded: ['gate/spot/trades/@/202108/gate|spot|trades|@|202108.gz'] })).status).toBe(200);
      expect(stand.got).toMatchObject([{ body: { downloaded: [idOf('spot/trades/202108/all-202108.gz')] } }]);
    } finally {
      await stand.close();
    }
  });

  it('refuses a body that is not a report, and more keys than one report may name', async () => {
    expect((await report({ downloaded: 'nope' })).status).toBe(400);
    expect((await report({ downloaded: Array.from({ length: 10_001 }, (_, n) => `k${n}`) })).status).toBe(400);
  });

  it('is a 422 through a lens that does not exist', async () => {
    expect((await report({ downloaded: [] }, { 'x-catalog-lens': 'nope' })).status).toBe(422);
  });

  /** A connection prospector drops is tried again, not a report lost. */
  it('settles the report when prospector drops the connection once', async () => {
    const stand = await prospector(200, 1);

    try {
      expect((await report({ downloaded: [EXPECTED[0]] })).status).toBe(200);
      expect(stand.got).toHaveLength(1);
    } finally {
      await stand.close();
    }
  });

  it('says the collector is not answering rather than failing', async () => {
    cfg.prospectorApi = 'http://127.0.0.1:1';

    expect((await report({ downloaded: [EXPECTED[0]] })).status).toBe(502);
  });
});
