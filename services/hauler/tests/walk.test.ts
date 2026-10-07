import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

/**
 * A venue walked as a bucket: every page, through the lens, only what is owed,
 * and a report per page. See `venue.ts`.
 */

const cfg = vi.hoisted(() => ({ archivesDir: '', catalogApi: '', catalogToken: 'secret', venues: [], lens: 'backfill-20', concurrency: 2, minFreeGb: 0 }));

vi.mock('../src/config', () => ({ default: cfg }));

const { walkVenue, _test_safe, _test_lookAgain } = await import('../src/venue');
const { setHosts } = await import('../src/hosts');
const { venues } = await import('../src/catalog');

let server:  Server;
let asked:   { url: string; lens: string | undefined; token: string | undefined }[];
let reports: unknown[];
let served:  number;
let drops:   number;
let refused: boolean;
let flying:  number;
let most:    number;

const KEYS = ['binance/a/1.zip', 'binance/a/2.zip', 'binance/b/3.zip'];

beforeEach(async () => {
  cfg.archivesDir = mkdtempSync(join(tmpdir(), 'walk-'));
  asked   = [];
  reports = [];
  served  = 0;
  drops   = 0;
  refused = false;
  flying  = 0;
  most    = 0;

  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');

    // Large files are held a moment, so that how many are in flight at once can be seen.
    if (url.pathname.startsWith('/files/big/')) {
      flying++;
      most = Math.max(most, flying);
      setTimeout(() => { flying--; res.writeHead(200); res.end('x'); }, 25);
      return;
    }

    if (url.pathname.startsWith('/files/')) { served++; res.writeHead(200); res.end(url.pathname); return; }

    if (url.pathname === '/listings/report') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        reports.push(JSON.parse(body));
        res.writeHead(refused ? 207 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(refused ? { Error: [{ Key: KEYS[0], Code: 'NoSuchKey', Message: 'No file' }] } : {}));
      });
      return;
    }

    if (drops > 0) { drops--; req.socket.destroy(); return; }

    asked.push({ url: req.url!, lens: req.headers['x-catalog-lens'] as string, token: req.headers['x-catalog-token'] as string });

    if (url.pathname === '/venues') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [
        { venue: 'binance', hosts: { '': ['https://bucket.example/', 'https://cdn.example/'] }, files: 3 },
        { venue: 'gate', hosts: { '': ['https://gate.example/'] }, files: 1 },
      ] }));
      return;
    }

    if (url.searchParams.get('prefix') === 'big/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Name: 'catalog', Prefix: 'big/', Marker: '', MaxKeys: 1000, IsTruncated: false,
        Contents: Array.from({ length: 30 }, (_, at) => `big/spot/trades/B/BTC/202001/f-${at}`)
          .map(Key => ({ Key, Path: `files/${Key}`, Host: '', Size: 60 * 1024 ** 2 })),
      }));
      return;
    }

    // A venue with more listed than is ever held ready: pages of four, said to be pages of one.
    if (url.searchParams.get('prefix') === 'many/') {
      const from = Number(url.searchParams.get('marker')?.split('-').at(-1) ?? -1) + 1;
      const keys = [0, 1, 2, 3].map(at => `many/spot/trades/B/BTC/202001/f-${from + at}`);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Name: 'catalog', Prefix: 'many/', Marker: '', MaxKeys: 1, IsTruncated: from < 40, NextMarker: keys.at(-1),
        Contents: keys.map(Key => ({ Key, Path: `files/${Key}`, Host: '' })),
      }));
      return;
    }

    const marker = url.searchParams.get('marker');
    const keys   = marker === null ? KEYS.slice(0, 2) : KEYS.slice(2);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      Name: 'catalog', Prefix: url.searchParams.get('prefix'), Marker: marker ?? '', MaxKeys: 2, IsTruncated: marker === null,
      ...(marker === null ? { NextMarker: keys.at(-1) } : {}),
      Contents: keys.map(Key => ({ Key, Path: `files/${Key}`, Host: '' })),
    }));
  });

  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));

  cfg.catalogApi = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  setHosts('binance', { '': [`${cfg.catalogApi}/`] });
});

afterEach(async () => {
  await new Promise(done => server.close(done));
  rmSync(cfg.archivesDir, { recursive: true, force: true });
});

describe('a walk', () => {
  it('fetches every object of every page to its key, and reports each page', async () => {
    const walked = await walkVenue('binance', () => false);

    expect(walked).toEqual({ listed: 3, progressed: 3, failed: 0, mismatched: 0, unreached: 0, full: false });

    for (const key of KEYS) expect(readFileSync(join(cfg.archivesDir, key), 'utf8')).toBe(`/files/${key}`);

    // Fetched two at a time, so a page's files are reported in whichever order they finished.
    expect(reports.map(one => ({ ...(one as { downloaded: string[] }), downloaded: [...(one as { downloaded: string[] }).downloaded].sort() }))).toEqual([
      { downloaded: [KEYS[0], KEYS[1]], failed: [], mismatched: [] },
      { downloaded: [KEYS[2]], failed: [], mismatched: [] },
    ]);
  });

  /**
   * Below the floor nothing is fetched and nothing is reported: the
   * walk ends saying the volume is why, and the files stay owed.
   */
  it('takes no file while the volume is below its floor', async () => {
    cfg.minFreeGb = 1e9;
    _test_lookAgain();

    try {
      expect(await walkVenue('binance', () => false)).toMatchObject({ progressed: 0, full: true });
      expect(served).toBe(0);
      expect(reports).toEqual([]);
    } finally {
      cfg.minFreeGb = 0;
      _test_lookAgain();
    }
  });

  /** A connection the catalog dropped is asked again, not a walk lost for half an hour. */
  it('asks again when the catalog drops the connection', async () => {
    drops = 1;

    expect(await walkVenue('binance', () => false)).toEqual({ listed: 3, progressed: 3, failed: 0, mismatched: 0, unreached: 0, full: false });
  });

  /** A stop finishes what is in flight and reports it, and takes nothing new. */
  it('takes no new file once stopped, and reports the one it finished', async () => {
    cfg.concurrency = 1;

    try {
      // Asked to stop the moment the first file has been served.
      const walked = await walkVenue('binance', () => served > 0);

      expect(walked).toEqual({ listed: 2, progressed: 1, failed: 0, mismatched: 0, unreached: 0, full: false });
      expect(reports).toEqual([{ downloaded: [KEYS[0]], failed: [], mismatched: [] }]);
    } finally {
      cfg.concurrency = 2;
    }
  });

  /** The listing is held back while enough is ready; a stop must not leave it waiting for room nobody will make. */
  it('ends when stopped while the listing is waiting for room', async () => {
    setHosts('many', { '': [`${cfg.catalogApi}/`] });

    const walked = await walkVenue('many', () => served > 0);

    expect(walked.progressed).toBeGreaterThan(0);
    expect(walked.progressed).toBeLessThan(40);
    expect(reports.flatMap(one => one.downloaded)).toHaveLength(walked.progressed);
  });

  /** A large file is bounded by the link: a hundred at once arrive no sooner than six, and starve everything else. */
  it('fetches large files six at a time, whatever the budget', async () => {
    cfg.concurrency = 20;
    setHosts('big', { '': [`${cfg.catalogApi}/`] });

    try {
      const walked = await walkVenue('big', () => false);

      expect(walked.listed).toBe(30);
      expect(most).toBe(6);
    } finally {
      cfg.concurrency = 2;
    }
  });

  it('asks only for what is owed, through the lens, with the token, resuming after the last key', async () => {
    await walkVenue('binance', () => false);

    expect(asked.map(one => one.url)).toEqual([
      `/listings?prefix=${encodeURIComponent('binance/')}&pending=true&max-keys=1000`,
      `/listings?prefix=${encodeURIComponent('binance/')}&pending=true&max-keys=1000&marker=${encodeURIComponent(KEYS[1]!)}`,
    ]);
    expect(asked.every(one => one.lens === 'backfill-20' && one.token === 'secret')).toBe(true);
  });
});

describe('a report the catalog could not settle in full', () => {
  /** A 207 is a report delivered; the keys it names are logged, and the walk goes on. */
  it('is not a failed walk', async () => {
    refused = true;

    expect(await walkVenue('binance', () => false)).toMatchObject({ listed: 3, progressed: 3 });
    expect(reports).toHaveLength(2);
  });
});

describe('the venues', () => {
  /** Only names are wanted; the lensed answer sizes the lens for every venue. */
  it('are asked for without the lens, but with the token, each with where its servers answer', async () => {
    expect(await venues()).toEqual([
      { venue: 'binance', hosts: { '': ['https://bucket.example/', 'https://cdn.example/'] } },
      { venue: 'gate', hosts: { '': ['https://gate.example/'] } },
    ]);
    expect(asked).toEqual([{ url: '/venues', lens: undefined, token: 'secret' }]);
  });
});

describe('a key', () => {
  it('may not leave its venue\'s folder', () => {
    expect(_test_safe('binance', 'binance/perp/trades/B/X/202001/x.zip')).toBe(true);
    expect(_test_safe('binance', 'gate/perp/trades/B/X/202001/x.zip')).toBe(false);
    expect(_test_safe('binance', 'binance/../escape.zip')).toBe(false);
    expect(_test_safe('binance', 'binance//etc/passwd')).toBe(false);
    expect(_test_safe('binance', '/etc/passwd')).toBe(false);
  });
});
