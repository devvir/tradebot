import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { Haulable } from '../src/types';
import { dropHeld } from '../src/held';

/**
 * One file brought to disk: fetched, found there already and touched, or found
 * different and replaced once a file that agrees is in hand. See `fetch.ts`.
 */

const cfg = vi.hoisted(() => ({ archivesDir: '', catalogApi: '', catalogToken: '', venues: [], lens: '', concurrency: 2, minFreeGb: 0 }));

vi.mock('../src/config', () => ({ default: cfg }));

/** A volume that will not set a file's date, as one owned by another user. */
const disk = vi.hoisted(() => ({ touchRefused: false }));

vi.mock('../src/store', async (actual) => {
  const real = await actual<typeof import('../src/store')>();

  return {
    ...real,
    touch: async (path: string) => {
      if (disk.touchRefused) throw Object.assign(new Error('EPERM: operation not permitted, utime'), { code: 'EPERM' });

      await real.touch(path);
    },
  };
});

const { haul, abandon, _test_resume, _test_retryAfter } = await import('../src/fetch');
const { refused: turnedAway, setHosts, _test_forget, _test_hostsOf } = await import('../src/hosts');
const { sweepPartials } = await import('../src/store');

const BODY = 'the file';
const md5  = (text: string | Buffer) => createHash('md5').update(text).digest('hex');

/** A file stored compressed, served as stored: `content-encoding` says what it is, not how it travels. */
const GZIPPED = gzipSync(Buffer.from('a,b,c\n1,2,3\n'.repeat(100)));

let server:   Server;
let base:     string;
let asked:    number;
let requests: { url: string; encoding: string | undefined }[];

/** What `/answers.zip` says, one step per request: a status, or `drop` for a connection lost before any answer. */
let answers:  string[];

beforeEach(async () => {
  cfg.archivesDir = mkdtempSync(join(tmpdir(), 'haul-'));
  asked = 0;
  requests = [];
  answers  = [];

  // No waiting between attempts: the jitter draws from zero.
  vi.spyOn(Math, 'random').mockReturnValue(0);

  server = createServer((req, res) => {
    requests.push({ url: req.url!, encoding: req.headers['accept-encoding'] });

    if (req.url === '/file.zip') { res.writeHead(200); res.end(BODY); return; }
    if (req.url === '/answers.zip') {
      const answer = answers.shift() ?? '404';

      if (answer === 'drop') { req.socket.destroy(); return; }

      res.writeHead(Number(answer), answer === '403' ? { 'retry-after': '0' } : {});
      res.end();
      return;
    }
    // An edge having a bad day: it answers every request with a server error.
    if (req.url!.startsWith('/broken/')) { res.writeHead(500); res.end(); return; }
    if (req.url === '/gzipped.gz') { res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/gzip' }); res.end(GZIPPED); return; }
    if (req.url === '/moved.zip') { res.writeHead(302, { location: '/file.zip' }); res.end(); return; }
    // Less than it said it would send, the connection then lost: the first time only, or every time.
    if (req.url === '/truncated.zip' || (req.url === '/truncated-once.zip' && asked === 0)) {
      asked++;
      res.writeHead(200, { 'content-length': String(BODY.length) });
      res.write(BODY.slice(0, 3), () => res.socket?.destroy());
      return;
    }
    if (req.url === '/truncated-once.zip') { res.writeHead(200); res.end(BODY); return; }
    if (req.url === '/short.zip') { res.writeHead(200); res.end('short'); return; }
    if (req.url === '/busy.zip') { asked++; res.writeHead(503); res.end(); return; }
    // Begun and never finished: a download slow enough to outlast a stop.
    if (req.url === '/slow.zip') { asked++; res.writeHead(200); res.write('BO'); return; }
    // An address having a bad moment: all is well, says the status, and there is nothing in the body.
    if (req.url === '/empty.zip') { asked++; res.writeHead(200); res.end(); return; }
    if (req.url === '/empty-once.zip') { res.writeHead(200); res.end(++asked === 1 ? '' : BODY); return; }
    // Refusals say how long to wait, so a test is never held for the default.
    if (req.url === '/forbidden.zip') { asked++; res.writeHead(403, { 'retry-after': '0' }); res.end(); return; }
    if (req.url === '/refused.zip') { asked++; res.writeHead(429, { 'retry-after': '1' }); res.end(); return; }
    if (req.url === '/refused-long.zip') { asked++; res.writeHead(429, { 'retry-after': '3600' }); res.end(); return; }
    if (req.url === '/gone.zip') asked++;

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));

  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  _test_forget();
  setHosts('binance', { '': [`${base}/`] });
  setHosts('gate', { '': [`${base}/`] });
  setHosts('nowhere', { '': ['http://127.0.0.1:1/'] });
});

afterEach(async () => {
  vi.restoreAllMocks();

  disk.touchRefused = false;

  _test_resume();

  // What a test left held is not the next one's.
  for (const venue of ['binance', 'gate', 'nowhere']) await dropHeld(venue);

  await new Promise(done => server.close(done));
  rmSync(cfg.archivesDir, { recursive: true, force: true });
});

const file = (over: Partial<Haulable> = {}): Haulable => ({
  venue: 'binance', key: 'binance/perp/trades/B/BTCUSDT/202001/x.zip', server: '', path: 'file.zip',
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

  it('is reported as a mismatch, and not put in place, when the venue serves something else', async () => {
    const one = file({ path: 'short.zip' });

    expect(await haul(one)).toEqual({ outcome: 'mismatched', size: 5, etag: md5('short') });
    expect(existsSync(at(one))).toBe(false);
  });

  /** The catalog is told what was received, so it can tell a same-sized different file from the one it lists. */
  it('is reported as a mismatch, with the MD5 it came as, where it is the listed size and not the listed file', async () => {
    const one = file({ etag: `"${md5('another file')}"` });

    expect(await haul(one)).toEqual({ outcome: 'mismatched', size: BODY.length, etag: md5(BODY) });
    expect(existsSync(at(one))).toBe(false);
  });

  /** Likely the venue's newer file: once the catalog has asked and says the same, that download is the file. */
  it('is not fetched twice where the catalog comes to agree with what was fetched', async () => {
    const one = file({ path: 'short.zip' });

    await haul(one);

    // The same file, as the catalog has it after asking the venue — at a path that would fail if it were asked for again.
    expect(await haul({ ...one, path: 'gone.zip', size: 5, etag: `"${md5('short')}"` })).toEqual({ outcome: 'downloaded' });
    expect(readFileSync(at(one), 'utf8')).toBe('short');
    expect(asked).toBe(0);
  });

  it('is dropped and fetched like any other where the catalog settles on something else', async () => {
    const one = file({ path: 'short.zip' });

    await haul(one);

    expect(await haul({ ...one, path: 'file.zip' })).toEqual({ outcome: 'downloaded' });
    expect(readFileSync(at(one), 'utf8')).toBe(BODY);
  });

  /** A venue with nothing owed has nothing left to settle. */
  it('is dropped with everything else held of its venue once that venue owes nothing', async () => {
    const one = file({ path: 'short.zip' });

    await haul(one);

    expect(await dropHeld('binance')).toBe(1);
    expect(readdirSync(join(cfg.archivesDir, '.hauler-tmp'))).toEqual([]);

    // Nothing held any more: it is asked of the venue, which no longer has it at that path.
    expect((await haul({ ...one, path: 'gone.zip', size: 5, etag: `"${md5('short')}"` })).outcome).toBe('failed');
  });

  /** The venue's own answer that the file is not there makes it `failed`. */
  it('fails, at once, where the venue says it is not there', async () => {
    expect((await haul(file({ path: 'gone.zip' }))).outcome).toBe('failed');
    expect(asked).toBe(1);
  });

  /** A busy venue says nothing about the file: it is tried again, then left owed, unreported. */
  it('is unreached, after every attempt, where the venue is only busy', async () => {
    expect((await haul(file({ path: 'busy.zip' }))).outcome).toBe('unreached');
    expect(asked).toBe(3);
  });

  /** Nothing where there should be something is a transfer that failed, not a file that differs. */
  it('is asked for again where the venue serves nothing, and fetched once it serves the file', async () => {
    const one = file({ path: 'empty-once.zip' });

    expect(await haul(one)).toEqual({ outcome: 'downloaded' });
    expect(readFileSync(at(one), 'utf8')).toBe(BODY);
    expect(asked).toBe(2);
  });

  it('is unreached, and not a mismatch, where every attempt is served nothing', async () => {
    const one = file({ path: 'empty.zip' });

    expect(await haul(one)).toEqual({ outcome: 'unreached' });
    expect(asked).toBe(3);
    expect(existsSync(at(one))).toBe(false);
  });

  /** A file the catalog says is empty is a file like any other. */
  it('is fetched as it is where the catalog says it is empty', async () => {
    const one = file({ path: 'empty.zip', size: 0, etag: undefined });

    expect(await haul(one)).toEqual({ outcome: 'downloaded' });
    expect(readFileSync(at(one), 'utf8')).toBe('');
  });

  /** A stop that has waited long enough: the file is left owed, nothing of it is kept, and nothing is asked again. */
  it('is unreached, at once, where a download in flight is given up', async () => {
    const one     = file({ path: 'slow.zip' });
    const hauling = haul(one);

    while (asked === 0) await new Promise(done => setTimeout(done, 10));

    abandon();

    expect(await hauling).toEqual({ outcome: 'unreached' });
    expect(asked).toBe(1);
    expect(existsSync(at(one))).toBe(false);
    expect(readdirSync(join(cfg.archivesDir, '.hauler-tmp'))).toEqual([]);
  });

  /** A stop that has waited long enough does not wait out an hour's refusal either. */
  it('is unreached, at once, where downloads are given up while it waits for its server', async () => {
    const hauling = haul(file({ path: 'refused-long.zip' }));

    while (asked === 0) await new Promise(done => setTimeout(done, 10));

    await new Promise(done => setTimeout(done, 100));

    const since = Date.now();

    abandon();

    expect(await hauling).toEqual({ outcome: 'unreached' });
    expect(Date.now() - since).toBeLessThan(200);
    expect(asked).toBe(1);
  });

  /** Whoever asked paces the waits: each is run through its pause, and a stop ends it with nothing more asked. */
  it('waits through the pause it is given, and asks nothing more once stopped', async () => {
    let paused = 0;
    let stop   = false;

    const hauling = haul(file({ path: 'refused-long.zip' }), {
      pause: async (wait) => { paused++; await wait(); },
      stopped: () => stop,
    });

    while (paused === 0) await new Promise(done => setTimeout(done, 10));

    stop = true;

    const since = Date.now();

    expect(await hauling).toEqual({ outcome: 'unreached' });
    expect(Date.now() - since).toBeLessThan(1_500);
    expect(paused).toBe(1);
    expect(asked).toBe(1);
  });

  /** A `403` may be aimed at us, so it is tried again — and reported only where it holds. */
  it('fails, after every attempt, where the venue keeps answering 403', async () => {
    expect((await haul(file({ path: 'forbidden.zip' }))).outcome).toBe('failed');
    expect(asked).toBe(3);
  });

  /** A `403` is taken for the venue's word only where the listed address said nothing else. */
  it('is unreached where the listed address answers anything but 403 before it does', async () => {
    for (const first of [['503', '503', '403'], ['drop', '403', '403']]) {
      answers  = [...first];
      requests = [];

      expect((await haul(file({ path: 'answers.zip' }))).outcome).toBe('unreached');
      expect(requests).toHaveLength(3);
    }

    answers = ['403', '403', '403'];

    expect((await haul(file({ path: 'answers.zip' }))).outcome).toBe('failed');
  });

  /** A refusal is aimed at us by the address that gave it: every file it alone serves waits it out, other venues do not. */
  it('leaves an address alone when it refuses, and waits for it where there is no other', async () => {
    const refused = haul(file({ path: 'refused.zip' }));

    while (asked === 0) await new Promise(done => setTimeout(done, 10));

    const since = Date.now();

    expect((await haul(file({ venue: 'gate', key: 'gate/spot/trades/B/BTC_USDT/202001/x.zip' }))).outcome).toBe('downloaded');
    expect(Date.now() - since).toBeLessThan(500);

    expect((await haul(file({ key: 'binance/perp/trades/B/BTCUSDT/202001/z.zip' }))).outcome).toBe('downloaded');
    expect(Date.now() - since).toBeGreaterThanOrEqual(900);

    expect((await refused).outcome).toBe('unreached');
  });

  /** Only the listed address speaks for the venue: another that lacks a file is asked no more for it. */
  it('asks the listed address where another does not have the file', async () => {
    setHosts('binance', { '': [`${base}/`, `${base}/elsewhere/`] });
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    expect((await haul(file())).outcome).toBe('downloaded');
    expect(_test_hostsOf('binance', '').map(host => [host.ok, host.errors])).toEqual([[1, 0], [0, 1]]);
  });

  /** A withdrawal is rare; an edge without a file its bucket holds is not one. */
  it('takes a file for gone only when every address says so', async () => {
    setHosts('binance', { '': [`${base}/elsewhere/`, `${base}/`] });

    expect((await haul(file())).outcome).toBe('downloaded');

    asked = 0;

    expect((await haul(file({ path: 'gone.zip', key: 'binance/perp/trades/B/BTCUSDT/202001/y.zip' }))).outcome).toBe('failed');
    expect(asked).toBe(1);
  });

  /** An edge that has lost a file says nothing for the venue: the listed address must have been asked too. */
  it('is unreached, not failed, where an edge lacks it and the listed address is out of rotation', async () => {
    setHosts('binance', { '': [`${base}/`, `${base}/elsewhere/`] });
    turnedAway(_test_hostsOf('binance', '')[0]!, 429, 60_000);

    expect(await haul(file())).toEqual({ outcome: 'unreached' });
    expect(requests.map(one => one.url)).toEqual(['/elsewhere/file.zip']);
  });

  it('fails where an edge lacks it and the listed address, in rotation, says it is gone too', async () => {
    setHosts('binance', { '': [`${base}/`, `${base}/elsewhere/`] });
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    expect((await haul(file({ path: 'gone.zip' }))).outcome).toBe('failed');
    expect(requests.map(one => one.url)).toEqual(['/elsewhere/gone.zip', '/gone.zip']);
  });

  /** An address tried for a file and failing is not asked again for it: the listed one is waited for instead. */
  it('waits for the listed address, and does not ask a failing edge again, where the listed one is out', async () => {
    setHosts('binance', { '': [`${base}/`, `${base}/broken/`] });
    turnedAway(_test_hostsOf('binance', '')[0]!, 429, 300);

    expect(await haul(file())).toEqual({ outcome: 'downloaded' });
    expect(requests.map(one => one.url)).toEqual(['/broken/file.zip', '/file.zip']);
  });

  it('reads Retry-After as seconds or as a date', () => {
    expect(_test_retryAfter('120')).toBe(120_000);
    expect(_test_retryAfter(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(55_000);
    expect(_test_retryAfter('soon')).toBeNull();
    expect(_test_retryAfter(undefined)).toBeNull();
  });

  it('is unreached where no connection opens', async () => {
    expect((await haul(file({ venue: 'nowhere' }))).outcome).toBe('unreached');
  });

  /** The archive is the bytes the venue holds: a file stored compressed is stored compressed. */
  it('is stored byte for byte, never decoded, and asked for as it is', async () => {
    const one = file({ path: 'gzipped.gz', size: GZIPPED.length, etag: `"${md5(GZIPPED)}"` });

    expect(await haul(one)).toEqual({ outcome: 'downloaded' });

    const stored = readFileSync(at(one));

    expect(stored.equals(GZIPPED)).toBe(true);
    expect([stored[0], stored[1]]).toEqual([0x1f, 0x8b]);
    expect(requests.map(one => one.encoding)).toEqual(['identity']);
  });

  it('follows a redirect to the file', async () => {
    const one = file({ path: 'moved.zip' });

    expect(await haul(one)).toEqual({ outcome: 'downloaded' });
    expect(readFileSync(at(one), 'utf8')).toBe(BODY);
    expect(requests.map(one => one.url)).toEqual(['/moved.zip', '/file.zip']);
  });

  /** Fewer bytes than the response promised is a transfer that failed, whatever the catalog knows of the file. */
  it('is asked for again where the body is shorter than promised, and fetched once it is whole', async () => {
    const one = file({ path: 'truncated-once.zip', size: undefined, etag: undefined });

    expect(await haul(one)).toEqual({ outcome: 'downloaded' });
    expect(readFileSync(at(one), 'utf8')).toBe(BODY);
    expect(requests).toHaveLength(2);
  });

  it('is unreached, and never in place, where every body is shorter than promised', async () => {
    const one = file({ path: 'truncated.zip', size: undefined, etag: undefined });

    expect(await haul(one)).toEqual({ outcome: 'unreached' });
    expect(asked).toBe(3);
    expect(existsSync(at(one))).toBe(false);
  });
});

describe('a file the disk will not take', () => {
  /** The address served; asking it again would come to the same. */
  const unreachedAtOnce = async (one: Haulable) => {
    expect(await haul(one)).toEqual({ outcome: 'unreached' });
    expect(requests).toHaveLength(1);
    expect(_test_hostsOf('binance', '').map(host => host.errors)).toEqual([0]);
    expect(readdirSync(join(cfg.archivesDir, '.hauler-tmp'))).toEqual([]);
  };

  it('is unreached at once, held against nobody, where a directory stands at its path', async () => {
    const one = file();

    mkdirSync(join(at(one), 'in the way'), { recursive: true });

    await unreachedAtOnce(one);
  });

  it('is unreached at once, held against nobody, where a file stands in place of its folder', async () => {
    const one = file();

    mkdirSync(dirname(dirname(at(one))), { recursive: true });
    writeFileSync(dirname(at(one)), 'not a folder');

    await unreachedAtOnce(one);
  });

  it('is unreached at once, held against nobody, where the download cannot be written', async () => {
    const one = file();

    writeFileSync(join(cfg.archivesDir, '.hauler-tmp'), 'not a folder');

    expect(await haul(one)).toEqual({ outcome: 'unreached' });
    expect(requests).toHaveLength(1);
    expect(_test_hostsOf('binance', '').map(host => host.errors)).toEqual([0]);
    expect(existsSync(at(one))).toBe(false);
  });
});

describe('a file already on disk', () => {
  /** Its new date is what says this pass accounted for it. */
  it('is touched, not fetched, where it matches', async () => {
    const one = file({ path: 'gone.zip' });

    place(one, BODY);

    expect(await haul(one)).toEqual({ outcome: 'present' });
    expect(statSync(at(one)).mtime.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('is fetched again where it differs, and moved aside as .bak, then .bak.2, once the new one agrees', async () => {
    const one = file();

    place(one, 'stale one');
    expect(await haul(one)).toEqual({ outcome: 'downloaded' });

    place(one, 'stale two');
    expect(await haul(one)).toEqual({ outcome: 'downloaded' });

    expect(readFileSync(`${at(one)}.bak`, 'utf8')).toBe('stale one');
    expect(readFileSync(`${at(one)}.bak.2`, 'utf8')).toBe('stale two');
    expect(readFileSync(at(one), 'utf8')).toBe(BODY);
  });

  /** Its date is a record of the pass; the file is no less there for keeping the old one. */
  it('is present where it matches, even where its date cannot be set', async () => {
    const one = file({ path: 'gone.zip' });

    place(one, BODY);
    disk.touchRefused = true;

    expect(await haul(one)).toEqual({ outcome: 'present' });
  });

  /** What the disk will not do is no answer about the file: it stays owed, and the download is not kept. */
  it('is unreached, and left where it is, where it differs and cannot be moved aside', async () => {
    const one = file();

    place(one, 'stale one');
    mkdirSync(join(`${at(one)}.bak`, 'taken'), { recursive: true });

    expect(await haul(one)).toEqual({ outcome: 'unreached' });
    expect(readFileSync(at(one), 'utf8')).toBe('stale one');
    expect(requests).toHaveLength(1);
    expect(_test_hostsOf('binance', '').map(host => host.errors)).toEqual([0]);
    expect(readdirSync(join(cfg.archivesDir, '.hauler-tmp'))).toEqual([]);
  });

  /** Nothing is moved until a file that agrees is in hand to take its place. */
  it('stays where it is, with nothing moved aside, where it differs and the venue says it is gone', async () => {
    const one = file({ path: 'gone.zip' });

    place(one, 'stale one');

    expect((await haul(one)).outcome).toBe('failed');
    expect(readFileSync(at(one), 'utf8')).toBe('stale one');
    expect(existsSync(`${at(one)}.bak`)).toBe(false);
  });

  it('stays where it is, with nothing moved aside, where it differs and the venue cannot be reached', async () => {
    const one = file({ path: 'busy.zip' });

    place(one, 'stale one');

    expect((await haul(one)).outcome).toBe('unreached');
    expect(readFileSync(at(one), 'utf8')).toBe('stale one');
    expect(existsSync(`${at(one)}.bak`)).toBe(false);
  });

  it('stays where it is, with nothing moved aside, where what is fetched does not agree either', async () => {
    const one = file({ path: 'short.zip' });

    place(one, 'stale one');

    expect(await haul(one)).toEqual({ outcome: 'mismatched', size: 5, etag: md5('short') });
    expect(readFileSync(at(one), 'utf8')).toBe('stale one');
    expect(existsSync(`${at(one)}.bak`)).toBe(false);
  });

  /** The catalog was what was wrong: once it rules for the file on disk, the download held is dropped and nothing is kept twice. */
  it('is present, the download held for it dropped, where the catalog comes to agree with it', async () => {
    const one = file({ size: 5, etag: `"${md5('short')}"` });

    place(one, BODY);

    expect(await haul(one)).toEqual({ outcome: 'mismatched', size: BODY.length, etag: md5(BODY) });

    expect(await haul({ ...one, size: BODY.length, etag: `"${md5(BODY)}"` })).toEqual({ outcome: 'present' });
    expect(readFileSync(at(one), 'utf8')).toBe(BODY);
    expect(existsSync(`${at(one)}.bak`)).toBe(false);
    expect(readdirSync(join(cfg.archivesDir, '.hauler-tmp'))).toEqual([]);
  });
});

describe('a key already being hauled', () => {
  /** Two downloads of one key would write one partial between them. */
  it('is unreached at once, and the haul in hand carries on', async () => {
    const one = file();

    const [first, second] = await Promise.all([haul(one), haul(one)]);

    expect(first).toEqual({ outcome: 'downloaded' });
    expect(second).toEqual({ outcome: 'unreached' });
    expect(readFileSync(at(one), 'utf8')).toBe(BODY);

    // Once in hand no longer, it is hauled as ever.
    expect(await haul(one)).toEqual({ outcome: 'present' });
  });
});

describe('a start', () => {
  /** A partial is a download that never finished; a `.bak` is a whole file kept for a person. */
  it('removes every unfinished download, and keeps everything else', async () => {
    const put = (rel: string) => {
      const at = join(cfg.archivesDir, rel);

      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, 'x');

      return at;
    };

    const partials = [put('.hauler-tmp/aaaa.part'), put('.hauler-tmp/bbbb.part')];
    const kept     = [put('binance/a/b/c.zip'), put('binance/a/b/d.zip.bak'), put('gate/x.zip.bak.2')];

    expect(await sweepPartials()).toBe(2);
    expect(partials.some(existsSync)).toBe(false);
    expect(kept.every(existsSync)).toBe(true);
  });

  it('finds nothing to do where nothing was left unfinished', async () => {
    expect(await sweepPartials()).toBe(0);
  });
});
