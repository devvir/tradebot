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

const cfg = vi.hoisted(() => ({ archivesDir: '', catalogApi: '', catalogToken: 'secret', venues: [], lens: 'backfill-20', concurrency: 2 }));

vi.mock('../src/config', () => ({ default: cfg }));

const { walkVenue, _test_safe } = await import('../src/venue');
const { venues } = await import('../src/catalog');

let server:  Server;
let asked:   { url: string; lens: string | undefined; token: string | undefined }[];
let reports: unknown[];
let served:  number;
let drops:   number;

const KEYS = ['a/1.zip', 'a/2.zip', 'b/3.zip'];

beforeEach(async () => {
  cfg.archivesDir = mkdtempSync(join(tmpdir(), 'walk-'));
  asked   = [];
  reports = [];
  served  = 0;
  drops   = 0;

  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');

    if (url.pathname.startsWith('/files/')) { served++; res.writeHead(200); res.end(url.pathname); return; }

    if (url.pathname === '/listings/binance/report') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { reports.push(JSON.parse(body)); res.writeHead(200); res.end('{}'); });
      return;
    }

    if (drops > 0) { drops--; req.socket.destroy(); return; }

    asked.push({ url: req.url!, lens: req.headers['x-catalog-lens'] as string, token: req.headers['x-catalog-token'] as string });

    if (url.pathname === '/contents/venues') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [{ venue: 'binance' }, { venue: 'gate' }] }));
      return;
    }

    const marker = url.searchParams.get('marker');
    const keys   = marker === null ? KEYS.slice(0, 2) : KEYS.slice(2);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      Name: 'binance', Marker: marker ?? '', MaxKeys: 2, IsTruncated: marker === null,
      ...(marker === null ? { NextMarker: keys.at(-1) } : {}),
      BaseUrl: `${cfg.catalogApi}/files/`,
      Contents: keys.map(Key => ({ Key, FileId: KEYS.indexOf(Key) + 1, Url: Key })),
    }));
  });

  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));

  cfg.catalogApi = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise(done => server.close(done));
  rmSync(cfg.archivesDir, { recursive: true, force: true });
});

describe('a walk', () => {
  it('fetches every object of every page to its key, and reports each page', async () => {
    const walked = await walkVenue('binance', () => false);

    expect(walked).toEqual({ listed: 3, progressed: 3, failed: 0, mismatched: 0, unreached: 0 });

    for (const key of KEYS) expect(readFileSync(join(cfg.archivesDir, 'binance', key), 'utf8')).toBe(`/files/${key}`);

    // Fetched two at a time, so a page's files are reported in whichever order they finished.
    expect(reports.map(one => ({ ...(one as { downloaded: number[] }), downloaded: [...(one as { downloaded: number[] }).downloaded].sort() }))).toEqual([
      { downloaded: [1, 2], failed: [], mismatched: [] },
      { downloaded: [3], failed: [], mismatched: [] },
    ]);
  });

  /** A connection the catalog dropped is asked again, not a walk lost for half an hour. */
  it('asks again when the catalog drops the connection', async () => {
    drops = 1;

    expect(await walkVenue('binance', () => false)).toEqual({ listed: 3, progressed: 3, failed: 0, mismatched: 0, unreached: 0 });
  });

  /** A stop finishes what is in flight and reports it, and takes nothing new. */
  it('takes no new file once stopped, and reports the one it finished', async () => {
    cfg.concurrency = 1;

    try {
      // Asked to stop the moment the first file has been served.
      const walked = await walkVenue('binance', () => served > 0);

      expect(walked).toEqual({ listed: 2, progressed: 1, failed: 0, mismatched: 0, unreached: 0 });
      expect(reports).toEqual([{ downloaded: [1], failed: [], mismatched: [] }]);
    } finally {
      cfg.concurrency = 2;
    }
  });

  it('asks only for what is owed, through the lens, with the token, resuming after the last key', async () => {
    await walkVenue('binance', () => false);

    expect(asked.map(one => one.url)).toEqual([
      '/listings/binance?pending=true&max-keys=1000',
      `/listings/binance?pending=true&max-keys=1000&marker=${encodeURIComponent('a/2.zip')}`,
    ]);
    expect(asked.every(one => one.lens === 'backfill-20' && one.token === 'secret')).toBe(true);
  });
});

describe('the venues', () => {
  /** Only names are wanted; the lensed answer sizes the lens for every venue. */
  it('are asked for without the lens, but with the token', async () => {
    expect(await venues()).toEqual(['binance', 'gate']);
    expect(asked).toEqual([{ url: '/contents/venues', lens: undefined, token: 'secret' }]);
  });
});

describe('a key', () => {
  it('may not leave the venue folder', () => {
    expect(_test_safe('perp/trades/202001/B/X/x.zip')).toBe(true);
    expect(_test_safe('../escape.zip')).toBe(false);
    expect(_test_safe('a/../../b')).toBe(false);
    expect(_test_safe('/etc/passwd')).toBe(false);
  });
});
