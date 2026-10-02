import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { Haulable } from '../src/types';

/**
 * One file brought to disk: fetched, found there already and touched, or found
 * different and moved aside first. See `fetch.ts`.
 */

const cfg = vi.hoisted(() => ({ archivesDir: '', catalogApi: '', catalogToken: '', venues: [], lens: '', concurrency: 2 }));

vi.mock('../src/config', () => ({ default: cfg }));

const { haul } = await import('../src/fetch');
const { sweepPartials } = await import('../src/store');

const BODY = 'the file';
const md5  = (text: string) => createHash('md5').update(text).digest('hex');

let server: Server;
let base:   string;
let asked:  number;

beforeEach(async () => {
  cfg.archivesDir = mkdtempSync(join(tmpdir(), 'haul-'));
  asked = 0;

  // No waiting between attempts: the jitter draws from zero.
  vi.spyOn(Math, 'random').mockReturnValue(0);

  server = createServer((req, res) => {
    if (req.url === '/file.zip') { res.writeHead(200); res.end(BODY); return; }
    if (req.url === '/short.zip') { res.writeHead(200); res.end('short'); return; }
    if (req.url === '/busy.zip') { asked++; res.writeHead(503); res.end(); return; }
    if (req.url === '/forbidden.zip') { asked++; res.writeHead(403); res.end(); return; }
    if (req.url === '/gone.zip') asked++;

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));

  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise(done => server.close(done));
  rmSync(cfg.archivesDir, { recursive: true, force: true });
});

const file = (over: Partial<Haulable> = {}): Haulable => ({
  venue: 'binance', key: 'binance/perp/trades/B/BTCUSDT/202001/x.zip', url: `${base}/file.zip`,
  size: BODY.length, etag: `"${md5(BODY)}"`, ...over,
});

const at = (one: Haulable) => join(cfg.archivesDir, one.key);

const place = (one: Haulable, text: string, when = new Date('2020-01-01')) => {
  mkdirSync(dirname(at(one)), { recursive: true });
  writeFileSync(at(one), text);
  utimesSync(at(one), when, when);
};

describe('a file not yet on disk', () => {
  it('is fetched to the venue folder at its key', async () => {
    const one = file();

    expect(await haul(one)).toEqual({ outcome: 'downloaded' });
    expect(readFileSync(at(one), 'utf8')).toBe(BODY);
  });

  it('is reported as a mismatch, and nothing is kept, when the venue serves something else', async () => {
    const one = file({ url: `${base}/short.zip` });

    expect(await haul(one)).toEqual({ outcome: 'mismatched', size: 5 });
    expect(existsSync(at(one))).toBe(false);
    expect(existsSync(`${at(one)}.part`)).toBe(false);
  });

  /** The venue's own answer that the file is not there is the only thing that makes it `failed`. */
  it('fails, at once, where the venue says it is not there', async () => {
    expect((await haul(file({ url: `${base}/gone.zip` }))).outcome).toBe('failed');
    expect((await haul(file({ url: `${base}/forbidden.zip` }))).outcome).toBe('failed');
    expect(asked).toBe(2);
  });

  /** A busy venue says nothing about the file: it is tried again, then left owed, unreported. */
  it('is unreached, after every attempt, where the venue is only busy', async () => {
    expect((await haul(file({ url: `${base}/busy.zip` }))).outcome).toBe('unreached');
    expect(asked).toBe(3);
  });

  it('is unreached where no connection opens', async () => {
    expect((await haul(file({ url: 'http://127.0.0.1:1/file.zip' }))).outcome).toBe('unreached');
  });
});

describe('a file already on disk', () => {
  /** Its new date is what says this pass accounted for it. */
  it('is touched, not fetched, where it matches', async () => {
    const one = file({ url: `${base}/gone.zip` });

    place(one, BODY);

    expect(await haul(one)).toEqual({ outcome: 'present' });
    expect(statSync(at(one)).mtime.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('is moved aside as .bak, then .bak.2, and fetched again, where it differs', async () => {
    const one = file();

    place(one, 'stale one');
    expect(await haul(one)).toEqual({ outcome: 'downloaded' });

    place(one, 'stale two');
    expect(await haul(one)).toEqual({ outcome: 'downloaded' });

    expect(readFileSync(`${at(one)}.bak`, 'utf8')).toBe('stale one');
    expect(readFileSync(`${at(one)}.bak.2`, 'utf8')).toBe('stale two');
    expect(readFileSync(at(one), 'utf8')).toBe(BODY);
  });
});

describe('a start', () => {
  /** A partial is a download that never finished; a `.bak` is a whole file kept for a person. */
  it('removes every unfinished download, at any depth, and keeps everything else', async () => {
    const put = (rel: string) => {
      const at = join(cfg.archivesDir, rel);

      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, 'x');

      return at;
    };

    const partials = [put('binance/a/b/c.zip.part'), put('gate/x.zip.part')];
    const kept     = [put('binance/a/b/c.zip'), put('binance/a/b/d.zip.bak'), put('gate/x.zip.bak.2')];

    expect(await sweepPartials(cfg.archivesDir)).toBe(2);
    expect(partials.some(existsSync)).toBe(false);
    expect(kept.every(existsSync)).toBe(true);
  });

  it('finds nothing to do in an archive that is not there yet', async () => {
    expect(await sweepPartials(join(cfg.archivesDir, 'nowhere'))).toBe(0);
  });
});
