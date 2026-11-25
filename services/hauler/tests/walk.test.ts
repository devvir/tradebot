import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@devvir/service-kit';
import type { Server } from 'node:http';
import type { Report } from '../src/types';

/**
 * A venue walked as a bucket: every page, through the lens, only what is owed,
 * and a report per page. See `venue.ts`.
 */

const cfg = vi.hoisted(() => ({ archivesDir: '', catalogApi: '', catalogToken: 'secret', venues: [], lens: 'backfill-20', concurrency: 2, minFreeGb: 0 }));

vi.mock('../src/config', () => ({ default: cfg }));

/** A volume that can be made to run out of inodes, or to refuse every download for want of room. */
const volume = vi.hoisted(() => ({ noInodes: false, noRoom: false }));

vi.mock('node:fs/promises', async (actual) => {
  const real = await actual<typeof import('node:fs/promises')>();

  return {
    ...real,
    statfs: async (path: string) => {
      const info = await real.statfs(path);

      return volume.noInodes ? { ...info, files: 1_000_000, ffree: 0 } : info;
    },
    open: async (path: string, flags?: string) => {
      if (volume.noRoom && path.endsWith('.part'))
        throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' });

      return await real.open(path, flags);
    },
  };
});

const { walkVenue, _test_safe, _test_lookAgain, _test_turns } = await import('../src/venue');
const { _test_forgetRefusal } = await import('../src/store');
const { setHosts } = await import('../src/hosts');
const { halt, page, venues, _test_unhalt } = await import('../src/catalog');

let server:  Server;
let asked:   { url: string; lens: string | undefined; token: string | undefined }[];
let reports: Report[];
let served:  number;
let drops:   number;
let refused: boolean;
let failing: number;
let flying:  number;
let most:    number;

/** Large files answered all at once: once one more than may be in flight has arrived, or nothing more has for a while. */
let bigHeld:  (() => void)[];
let bigQuiet: ReturnType<typeof setTimeout> | undefined;

/** How the catalog takes a report, and how often it was asked while it could not answer. */
let reportStatus: number;
let busyAsked:    number;

/** A server turning every request away for so many seconds, how often it was asked, and requests at once of either server. */
let outFor:   string;
let outAsked: number;
let inFlight: number;
let peak:     number;

/** Large files begun and in flight at once, small files served, and how many of those when the seventh large one began. */
let heavyBegun:  number;
let heavyFlying: number;
let heavyMost:   number;
let lightServed: number;
let lightBefore: number | null;

/** When the first slow large file was done, and when the first small file of a later page was served, from the walk's start. */
let walkStart:   number;
let slowDoneAt:  number | null;
let nextPageAt:  number | null;

/** Large files refused before they are served, and those served in flight at once. */
let laterRefusals: number;
let laterFlying:   number;
let laterMost:     number;
let laterServed:   number;

/** Nothing held or waited for by any walk: what every walk leaves behind it. */
const NO_TURNS = { flying: 0, queued: 0, flyingLarge: 0, queuedLarge: 0, largeFreed: 0 };

const KEYS = ['binance/a/1.zip', 'binance/a/2.zip', 'binance/b/3.zip'];
const SIZED = ['sized/a/0.zip', 'sized/a/1.zip', 'sized/a/2.zip', 'sized/a/3.zip'];
const DIFFERS = 'differs/a/0.zip';
const VERDICTS = ['verdicts/a/k1.zip', 'verdicts/a/k2.zip', 'verdicts/a/k3.zip'];
const STRAY = 'stray/a/ok.zip';

beforeEach(async () => {
  cfg.archivesDir = mkdtempSync(join(tmpdir(), 'walk-'));
  asked   = [];
  reports = [];
  served  = 0;
  drops   = 0;
  refused = false;
  failing = 0;
  flying  = 0;
  most    = 0;
  bigHeld = [];
  reportStatus = 200;
  busyAsked    = 0;
  outFor  = '3';
  outAsked = inFlight = peak = 0;
  heavyBegun = heavyFlying = heavyMost = lightServed = 0;
  lightBefore = null;
  walkStart = Date.now();
  slowDoneAt = nextPageAt = null;
  laterRefusals = laterFlying = laterMost = laterServed = 0;

  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');

    // Large files are held until a seventh arrives or none has for 300 ms, so that every one allowed at once is seen at once.
    if (url.pathname.startsWith('/files/big/')) {
      flying++;
      most = Math.max(most, flying);
      bigHeld.push(() => { flying--; res.writeHead(200); res.end('x'); });

      const release = () => { clearTimeout(bigQuiet); for (const answer of bigHeld.splice(0)) answer(); };

      clearTimeout(bigQuiet);

      if (bigHeld.length >= 7) release();
      else bigQuiet = setTimeout(release, 300);

      return;
    }

    if (url.pathname.startsWith('/files/missing/')) { res.writeHead(404); res.end(); return; }
    if (url.pathname.startsWith('/files/short/')) { res.writeHead(200); res.end('short'); return; }

    if (url.pathname.startsWith('/files/out/')) {
      outAsked++;
      peak = Math.max(peak, inFlight + 1);
      res.writeHead(429, { 'retry-after': outFor });
      res.end();
      return;
    }

    // Each held a moment, so that what runs at once is seen.
    if (url.pathname.startsWith('/files/quick/')) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      setTimeout(() => { inFlight--; res.writeHead(200); res.end(url.pathname); }, 50);
      return;
    }

    if (url.pathname.startsWith('/files/heavy/')) {
      if (++heavyBegun === 7) lightBefore = lightServed;
      heavyMost = Math.max(heavyMost, ++heavyFlying);
      setTimeout(() => { heavyFlying--; res.writeHead(200); res.end('x'); }, 200);
      return;
    }

    // Large files that take a while, and small files of a page listed after them.
    if (url.pathname.startsWith('/files/slow/')) {
      setTimeout(() => { slowDoneAt ??= Date.now() - walkStart; res.writeHead(200); res.end('x'); }, 600);
      return;
    }

    if (url.pathname.startsWith('/files/next/')) { nextPageAt ??= Date.now() - walkStart; res.writeHead(200); res.end(url.pathname); return; }

    // Large files whose server turns the first six requests away for a second, and then serves each a moment.
    if (url.pathname.startsWith('/files/later/')) {
      if (laterRefusals > 0) { laterRefusals--; res.writeHead(429, { 'retry-after': '1' }); res.end(); return; }

      laterMost = Math.max(laterMost, ++laterFlying);
      setTimeout(() => { laterFlying--; laterServed++; res.writeHead(200); res.end('x'); }, 100);
      return;
    }

    if (url.pathname.startsWith('/files/light/')) { lightServed++; res.writeHead(200); res.end(url.pathname); return; }

    if (url.pathname.startsWith('/files/')) { served++; res.writeHead(200); res.end(url.pathname); return; }

    if (url.pathname === '/listings/report') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        reports.push(JSON.parse(body));

        if (reportStatus !== 200) { res.writeHead(reportStatus); res.end('no'); return; }

        res.writeHead(refused ? 207 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(refused ? { Error: [{ Key: KEYS[0], Code: 'NoSuchKey', Message: 'No file' }] } : {}));
      });
      return;
    }

    if (drops > 0) { drops--; req.socket.destroy(); return; }

    // A catalog that cannot answer: a server error, as while it is stuck or restarting.
    if (failing > 0) { failing--; busyAsked++; res.writeHead(503); res.end('busy'); return; }

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
        Contents: Array.from({ length: 18 }, (_, at) => `big/spot/trades/B/BTC/202001/f-${at}`)
          .map(Key => ({ Key, Path: `files/${Key}`, Host: '', Size: 60 * 1024 ** 2 })),
      }));
      return;
    }

    // Venues of four files each: one whose server turns everything away, two that serve slowly.
    for (const venue of ['out', 'quick', 'brisk']) if (url.searchParams.get('prefix') === `${venue}/`) {
      const path = venue === 'out' ? 'out' : 'quick';

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Name: 'catalog', Prefix: `${venue}/`, Marker: '', MaxKeys: 1000, IsTruncated: false,
        Contents: [0, 1, 2, 3].map(at => ({ Key: `${venue}/spot/trades/B/BTC/202001/f-${at}`, Path: `files/${path}/${venue}-${at}`, Host: '' })),
      }));
      return;
    }

    // A listing the catalog refuses from its second page on.
    if (url.searchParams.get('prefix') === 'cut/') {
      if (url.searchParams.get('marker') !== null) { res.writeHead(422); res.end('no such lens'); return; }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Name: 'catalog', Prefix: 'cut/', Marker: '', MaxKeys: 2, IsTruncated: true, NextMarker: 'cut/a/1.zip',
        Contents: ['cut/a/0.zip', 'cut/a/1.zip'].map(Key => ({ Key, Path: `files/${Key}`, Host: '' })),
      }));
      return;
    }

    // A listing the catalog refuses outright.
    if (url.searchParams.get('prefix') === 'refused/') { res.writeHead(422); res.end('no such lens'); return; }

    // A venue with one file of every verdict: gone, served other than listed, and fine.
    if (url.searchParams.get('prefix') === 'verdicts/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Name: 'catalog', Prefix: 'verdicts/', Marker: '', MaxKeys: 1000, IsTruncated: false,
        Contents: [
          { Key: VERDICTS[0], Path: 'files/missing/k1', Host: '' },
          { Key: VERDICTS[1], Path: 'files/short/k2', Host: '', Size: 8 },
          { Key: VERDICTS[2], Path: `files/${VERDICTS[2]}`, Host: '' },
        ],
      }));
      return;
    }

    // A venue listing a key that belongs to another.
    if (url.searchParams.get('prefix') === 'stray/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Name: 'catalog', Prefix: 'stray/', Marker: '', MaxKeys: 1000, IsTruncated: false,
        Contents: ['gate/x.zip', STRAY].map(Key => ({ Key, Path: `files/${Key}`, Host: '' })),
      }));
      return;
    }

    // Twenty large files listed ahead of twenty small ones.
    if (url.searchParams.get('prefix') === 'mixed/') {
      const heavy = Array.from({ length: 20 }, (_, at) => ({
        Key: `mixed/spot/trades/B/BTC/202001/h-${at}`, Path: `files/heavy/h-${at}`, Host: '', Size: 60 * 1024 ** 2,
      }));
      const light = Array.from({ length: 20 }, (_, at) => ({
        Key: `mixed/spot/trades/B/ETH/202001/l-${at}`, Path: `files/light/l-${at}`, Host: '', Size: `/files/light/l-${at}`.length,
      }));

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Name: 'catalog', Prefix: 'mixed/', Marker: '', MaxKeys: 1000, IsTruncated: false, Contents: [...heavy, ...light] }));
      return;
    }

    // A venue of two servers, the files of one listed among the other's.
    if (url.searchParams.get('prefix') === 'two/') {
      const fine = (at: number) => ({ Key: `two/spot/trades/B/ETH/202001/y-${at}`, Path: `files/two/y-${at}`, Host: 'fine' });
      const out  = (at: number) => ({ Key: `two/spot/trades/B/BTC/202001/x-${at}`, Path: `files/out/x-${at}`, Host: 'away' });

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Name: 'catalog', Prefix: 'two/', Marker: '', MaxKeys: 1000, IsTruncated: false,
        Contents: [out(0), ...[0, 1, 2, 3, 4].map(fine), out(1), ...[5, 6, 7, 8, 9].map(fine)],
      }));
      return;
    }

    // A page of slow large files, then — a moment later — a page of small ones.
    if (url.searchParams.get('prefix') === 'paged/') {
      const marker = url.searchParams.get('marker');
      const answer = (Contents: object[], more: boolean) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          Name: 'catalog', Prefix: 'paged/', Marker: marker ?? '', MaxKeys: 1000, IsTruncated: more,
          ...(more ? { NextMarker: 'paged/spot/trades/B/BTC/202001/h-9' } : {}), Contents,
        }));
      };

      if (marker === null) answer(Array.from({ length: 10 }, (_, at) => ({
        Key: `paged/spot/trades/B/BTC/202001/h-${at}`, Path: `files/slow/h-${at}`, Host: '', Size: 60 * 1024 ** 2,
      })), true);
      else setTimeout(() => answer(Array.from({ length: 10 }, (_, at) => ({
        Key: `paged/spot/trades/B/ETH/202001/l-${at}`, Path: `files/next/l-${at}`, Host: '', Size: `/files/next/l-${at}`.length,
      })), false), 50);
      return;
    }

    // Large files whose server first turns them away.
    if (url.searchParams.get('prefix') === 'later/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Name: 'catalog', Prefix: 'later/', Marker: '', MaxKeys: 1000, IsTruncated: false,
        Contents: Array.from({ length: 10 }, (_, at) => ({
          Key: `later/spot/trades/B/BTC/202001/f-${at}`, Path: `files/later/f-${at}`, Host: '', Size: 60 * 1024 ** 2,
        })),
      }));
      return;
    }

    // A venue that owes nothing.
    if (url.searchParams.get('prefix') === 'empty/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Name: 'catalog', Prefix: 'empty/', Marker: '', MaxKeys: 1000, IsTruncated: false, Contents: [] }));
      return;
    }

    // A venue whose listing says what each file weighs: each is served as its own path.
    if (url.searchParams.get('prefix') === 'sized/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Name: 'catalog', Prefix: 'sized/', Marker: '', MaxKeys: 1000, IsTruncated: false,
        Contents: SIZED.map(Key => ({ Key, Path: `files/${Key}`, Host: '', Size: `/files/${Key}`.length })),
      }));
      return;
    }

    // A venue whose one file the catalog lists at a size it is not served at.
    if (url.searchParams.get('prefix') === 'differs/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Name: 'catalog', Prefix: 'differs/', Marker: '', MaxKeys: 1000, IsTruncated: false,
        Contents: [{ Key: DIFFERS, Path: `files/${DIFFERS}`, Host: '', Size: 3 }],
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
  vi.restoreAllMocks();

  await new Promise(done => server.close(done));
  rmSync(cfg.archivesDir, { recursive: true, force: true });
});

describe('a walk', () => {
  it('fetches every object of every page to its key, and reports each page', async () => {
    const walked = await walkVenue('binance', () => false);

    expect(walked).toEqual({ listed: 3, progressed: 3, failed: 0, mismatched: 0, unreached: 0, full: false, cut: false, nothingOwed: false });

    for (const key of KEYS) expect(readFileSync(join(cfg.archivesDir, key), 'utf8')).toBe(`/files/${key}`);

    // Fetched two at a time, so a page's files are reported in whichever order they finished.
    expect(reports.map(one => ({ ...one, downloaded: [...one.downloaded].sort() }))).toEqual([
      { downloaded: [KEYS[0], KEYS[1]], failed: [], mismatched: [] },
      { downloaded: [KEYS[2]], failed: [], mismatched: [] },
    ]);
  });

  /** What was received instead is told to the catalog: its size and its MD5. */
  it('reports a file served other than the catalog lists it, with the size and MD5 it came as', async () => {
    setHosts('differs', { '': [`${cfg.catalogApi}/`] });

    const body = `/files/${DIFFERS}`;

    expect(await walkVenue('differs', () => false)).toMatchObject({ listed: 1, progressed: 0, mismatched: 1 });
    expect(reports).toEqual([{
      downloaded: [], failed: [],
      mismatched: [{ Key: DIFFERS, Size: body.length, ETag: createHash('md5').update(body).digest('hex') }],
    }]);
  });

  /**
   * Below the floor nothing is fetched and nothing is reported: the
   * walk ends saying the volume is why, and the files stay owed.
   */
  it('takes no file while the volume is below its floor', async () => {
    cfg.minFreeGb = 1e9;
    _test_lookAgain();

    try {
      // Nothing settled, and still owing: what it did not reach is owed all the same.
      expect(await walkVenue('binance', () => false)).toMatchObject({ listed: 0, progressed: 0, full: true, nothingOwed: false });
      expect(served).toBe(0);
      expect(reports).toEqual([]);
    } finally {
      cfg.minFreeGb = 0;
      _test_lookAgain();
    }
  });

  /** A volume of small files runs out of inodes long before it runs out of space. */
  it('takes no file while the volume is out of inodes', async () => {
    volume.noInodes = true;
    _test_lookAgain();

    try {
      expect(await walkVenue('binance', () => false)).toMatchObject({ listed: 0, progressed: 0, full: true });
      expect(served).toBe(0);
    } finally {
      volume.noInodes = false;
      _test_lookAgain();
    }
  });

  /** A quota spent is a volume full that no look at it shows. */
  it('takes no further file once a download is refused for want of room', async () => {
    cfg.concurrency = 1;
    volume.noRoom = true;
    _test_lookAgain();

    try {
      expect(await walkVenue('binance', () => false)).toMatchObject({ progressed: 0, unreached: 1, full: true });
      expect(served).toBe(1);
      // Nothing came of it to tell the catalog: the file is owed all the same.
      expect(reports).toEqual([]);
    } finally {
      cfg.concurrency = 2;
      volume.noRoom = false;
      _test_forgetRefusal();
      _test_lookAgain();
    }
  });

  it('says so where the venue owes nothing', async () => {
    expect(await walkVenue('empty', () => false)).toEqual({
      listed: 0, progressed: 0, failed: 0, mismatched: 0, unreached: 0, full: false, cut: false, nothingOwed: true,
    });
    expect(reports).toEqual([]);
  });

  /** A connection the catalog dropped is asked again, not a walk lost for half an hour. */
  it('asks again when the catalog drops the connection', async () => {
    drops = 1;

    expect(await walkVenue('binance', () => false)).toEqual({ listed: 3, progressed: 3, failed: 0, mismatched: 0, unreached: 0, full: false, cut: false, nothingOwed: false });
  });

  /** A 5xx is the catalog away, not a verdict: waited for, and the walk carries on. */
  it('waits for a catalog that cannot answer, and loses nothing', async () => {
    failing = 2;

    expect(await walkVenue('binance', () => false)).toEqual({ listed: 3, progressed: 3, failed: 0, mismatched: 0, unreached: 0, full: false, cut: false, nothingOwed: false });
    expect(reports).toHaveLength(2);
  });

  /** A stop finishes what is in flight and reports it, and takes nothing new. */
  it('takes no new file once stopped, and reports the one it finished', async () => {
    cfg.concurrency = 1;

    try {
      // Asked to stop the moment the first file has been served.
      const walked = await walkVenue('binance', () => served > 0);

      expect(walked).toEqual({ listed: 2, progressed: 1, failed: 0, mismatched: 0, unreached: 0, full: false, cut: false, nothingOwed: false });
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

      expect(walked.listed).toBe(18);
      expect(most).toBe(6);
    } finally {
      cfg.concurrency = 2;
    }
  });

  /** Files waiting six at a time hold up nobody: the small ones behind them are taken meanwhile. */
  it('takes the small files behind a run of large ones while the large wait their turn', async () => {
    cfg.concurrency = 10;
    setHosts('mixed', { '': [`${cfg.catalogApi}/`] });

    try {
      const walked = await walkVenue('mixed', () => false);

      expect(walked.listed).toBe(40);
      expect(lightServed).toBe(20);
      expect(lightBefore).toBe(20);
      expect(heavyBegun).toBe(20);
      expect(heavyMost).toBe(6);
    } finally {
      cfg.concurrency = 2;
    }
  });

  /** Small files listed after a page of large ones are taken as soon as they are listed, not once a large one is done. */
  it('takes the small files of a later page while the large files of an earlier one wait their turn', async () => {
    cfg.concurrency = 10;
    setHosts('paged', { '': [`${cfg.catalogApi}/`] });

    try {
      walkStart = Date.now();

      expect(await walkVenue('paged', () => false)).toMatchObject({ listed: 20, unreached: 0 });
      expect(nextPageAt).not.toBeNull();
      expect(slowDoneAt).not.toBeNull();
      expect(nextPageAt!).toBeLessThan(slowDoneAt!);
      expect(_test_turns()).toEqual(NO_TURNS);
    } finally {
      cfg.concurrency = 2;
    }
  });

  /** A large file that must wait gives its turn for one back, and takes one again before it goes on: never more than six, and none lost. */
  it('fetches large files six at a time through a server turning them away, and leaves every turn as it found it', async () => {
    cfg.concurrency = 20;
    laterRefusals = 6;
    setHosts('later', { '': [`${cfg.catalogApi}/`] });
    setHosts('big', { '': [`${cfg.catalogApi}/`] });

    // No wait between attempts but the one the server asks for.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      expect(await walkVenue('later', () => false)).toMatchObject({ listed: 10, mismatched: 10, unreached: 0 });
      expect(laterRefusals).toBe(0);
      expect(laterServed).toBe(10);
      expect(laterMost).toBeLessThanOrEqual(6);
      expect(_test_turns()).toEqual(NO_TURNS);

      // A later walk has every turn for a large file there was.
      expect(await walkVenue('big', () => false)).toMatchObject({ listed: 18 });
      expect(most).toBe(6);
      expect(_test_turns()).toEqual(NO_TURNS);
    } finally {
      cfg.concurrency = 2;
    }
  });

  /** The budget is the machine's: two venues walking at once share it, and both get through. */
  it('shares one budget between venues walking at once', async () => {
    setHosts('quick', { '': [`${cfg.catalogApi}/`] });
    setHosts('brisk', { '': [`${cfg.catalogApi}/`] });

    const [quick, brisk] = await Promise.all([walkVenue('quick', () => false), walkVenue('brisk', () => false)]);

    expect(quick).toMatchObject({ listed: 4, progressed: 4, unreached: 0 });
    expect(brisk).toMatchObject({ listed: 4, progressed: 4, unreached: 0 });
    expect(peak).toBeLessThanOrEqual(2);
  });

  /** Each file's verdict goes to the catalog: gone as failed, and what came instead with its size and MD5. */
  it('reports what failed and what was served otherwise beside what was downloaded', async () => {
    setHosts('verdicts', { '': [`${cfg.catalogApi}/`] });

    expect(await walkVenue('verdicts', () => false)).toMatchObject({ listed: 3, progressed: 1, failed: 1, mismatched: 1 });
    expect(reports).toEqual([{
      downloaded: [VERDICTS[2]],
      failed:     [VERDICTS[0]],
      mismatched: [{ Key: VERDICTS[1], Size: 5, ETag: createHash('md5').update('short').digest('hex') }],
    }]);
  });

  /** A key is where its file goes: one outside the venue's folder is never fetched, nor said anything of. */
  it('neither fetches nor reports a key outside the venue', async () => {
    setHosts('stray', { '': [`${cfg.catalogApi}/`] });

    expect(await walkVenue('stray', () => false)).toMatchObject({ listed: 2, progressed: 1, failed: 0, mismatched: 0 });
    expect(served).toBe(1);
    expect(reports).toEqual([{ downloaded: [STRAY], failed: [], mismatched: [] }]);
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

describe('a file that cannot be hauled', () => {
  const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

  /** One file the disk will not move aside is that file left owed, not the walk lost. */
  it('is left owed, and the rest of its page is reported, the walk over when it says it is', async () => {
    setHosts('sized', { '': [`${cfg.catalogApi}/`] });

    const stale = join(cfg.archivesDir, SIZED[0]!);

    mkdirSync(join(`${stale}.bak`, 'taken'), { recursive: true });
    writeFileSync(stale, 'not the file');

    const walked = await walkVenue('sized', () => false);

    expect(walked).toMatchObject({ listed: 4, progressed: 3, unreached: 1 });
    expect(reports).toHaveLength(1);
    expect([...reports[0]!.downloaded].sort()).toEqual(SIZED.slice(1));

    const after = served;

    await pause(300);
    expect(served).toBe(after);
  });

  /** A volume that cannot be looked at is taken to be as it was last seen, and nothing is lost to it. */
  it('is not one the volume could not be looked at for', async () => {
    cfg.archivesDir = join(cfg.archivesDir, 'not-yet');
    _test_lookAgain();

    try {
      expect(await walkVenue('binance', () => false)).toMatchObject({ listed: 3, progressed: 3, unreached: 0, full: false, cut: false, nothingOwed: false });
    } finally {
      _test_lookAgain();
    }
  });

  /** A fault of the walk itself ends it, and only once nothing of it is running. */
  it('that is a fault of the walk itself ends the walk, with no worker left fetching', async () => {
    setHosts('many', { '': [`${cfg.catalogApi}/`] });

    const info = logger.info.bind(logger);
    let thrown = false;

    vi.spyOn(logger, 'info').mockImplementation(((obj: unknown, msg?: string) => {
      if (msg === 'Page done' && ! thrown) {
        thrown = true;

        throw new Error('a fault of the walk');
      }

      return info(obj as object, msg);
    }) as typeof logger.info);

    await expect(walkVenue('many', () => false)).rejects.toThrow('a fault of the walk');

    const after = served;

    expect(after).toBeLessThan(44);
    await pause(300);
    expect(served).toBe(after);
  });
});

describe('a venue whose server turns every request away', () => {
  const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

  beforeEach(() => {
    setHosts('out', { '': [`${cfg.catalogApi}/`] });
    setHosts('quick', { '': [`${cfg.catalogApi}/`] });
  });

  /** The budget is the machine's: a venue waiting holds none of it, and the rest share it as ever. */
  it('holds up no other venue while it waits, and the budget holds', async () => {
    let stop = false;
    let over = false;

    const out = walkVenue('out', () => stop).finally(() => { over = true; });

    await pause(200);

    const since = Date.now();

    expect(await walkVenue('quick', () => false)).toMatchObject({ listed: 4, progressed: 4 });
    expect(Date.now() - since).toBeLessThan(1_500);
    expect(outAsked).toBeGreaterThan(0);
    expect(over).toBe(false);

    stop = true;

    expect(await out).toMatchObject({ progressed: 0, failed: 0, mismatched: 0 });
    expect(peak).toBeLessThanOrEqual(2);
  });

  /** A server out of rotation holds up its own files, and not those of the venue's other servers listed behind them. */
  it('takes the files of its other servers meanwhile', async () => {
    cfg.concurrency = 4;
    setHosts('two', { away: [`${cfg.catalogApi}/`], fine: [`${cfg.catalogApi}/`] });

    const since = Date.now();

    try {
      const walked = await walkVenue('two', () => served >= 10 || Date.now() - since > 2_500);

      expect(served).toBe(10);
      expect(Date.now() - since).toBeLessThan(2_500);
      expect(walked).toMatchObject({ progressed: 10, failed: 0, mismatched: 0 });
      expect(_test_turns()).toEqual(NO_TURNS);
    } finally {
      cfg.concurrency = 2;
    }
  });

  /** A stop is not held up by a refusal it would take a minute to wait out. */
  it('ends promptly when stopped while it waits, its files left owed', async () => {
    outFor = '60';

    let stop = false;

    const walking = walkVenue('out', () => stop);

    while (outAsked === 0) await pause(10);

    await pause(100);

    stop = true;

    const since  = Date.now();
    const walked = await walking;

    expect(Date.now() - since).toBeLessThan(1_500);
    expect(walked).toMatchObject({ progressed: 0, failed: 0, mismatched: 0 });
    expect(walked.unreached).toBeGreaterThan(0);
    expect(reports).toEqual([]);
  });
});

describe('the catalog', () => {
  /** A `4xx` is the catalog's answer, and not one to wait out. */
  it('refusing the listing fails the walk with what it said', async () => {
    await expect(walkVenue('refused', () => false)).rejects.toThrow(/422/);
  });

  /** Past the first page, what was listed is walked; the walk says it was cut short, since it says nothing of the rest. */
  it('refusing a later page ends the walk with what was listed, cut short', async () => {
    setHosts('cut', { '': [`${cfg.catalogApi}/`] });

    expect(await walkVenue('cut', () => false)).toMatchObject({ listed: 2, progressed: 2, full: false, cut: true });
    expect(reports).toHaveLength(1);
  });

  /** The files a lost report named are listed again on the next walk, found on disk, and reported then. */
  it('refusing a report does not fail the walk', async () => {
    reportStatus = 400;

    expect(await walkVenue('binance', () => false)).toMatchObject({ listed: 3, progressed: 3 });
    expect(reports).toHaveLength(2);
  });

  /** Once hauler is stopping, a catalog that cannot answer is given its attempts and not waited for. */
  it('is asked three times, and no more, once halted', { timeout: 10_000 }, async () => {
    failing = 99;
    halt();

    try {
      await expect(page('binance', null)).rejects.toThrow(/503/);
      expect(busyAsked).toBe(3);
    } finally {
      _test_unhalt();
      failing = 0;
    }
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
