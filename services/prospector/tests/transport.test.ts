import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@devvir/service-kit';
import { deliver } from '../src/deliver';
import { _test_closeTransport, _test_lanes, carry, openTransport } from '../src/transport';
import type { Server } from 'node:http';
import type { Carried } from '../src/types';

/**
 * Requests carried on a worker thread: what crosses, what comes back, and what
 * happens when a worker is gone. See `transport.ts`.
 *
 * **In-process carrying is a stub here**, so a reply that comes back with the
 * stub's status was carried on this thread and any other was carried by a
 * worker, which runs the real `deliver` against a local server.
 */
vi.mock('../src/deliver', () => ({
  deliver: vi.fn(async (): Promise<Carried> => ({ status: 299, headers: { carried: 'in-process' }, page: null })),
}));

/** Read past timers a test may have faked. */
const pause = setTimeout;

const until = async (ok: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;

  while (! ok()) {
    if (Date.now() > end) throw new Error('timed out');

    await new Promise(resolve => pause(resolve, 10));
  }
};

let here: string;

beforeEach(() => {
  here = mkdtempSync(join(tmpdir(), 'transport-'));
  vi.mocked(deliver).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});

afterEach(async () => {
  vi.useRealTimers();

  await _test_closeTransport();

  rmSync(here, { recursive: true, force: true });
});

/** The messages `logger.error` was called with, in order, with what each said. */
const errors = (message: string): Record<string, unknown>[] =>
  vi.mocked(logger.error).mock.calls
    .filter(call => call[1] === message)
    .map(call => call[0] as unknown as Record<string, unknown>);

describe('a worker file that is not built', () => {
  it('starts no worker, says so once, and carries every request in-process', async () => {
    openTransport(3_000, join(here, 'transport.worker.js'));

    expect(_test_lanes()).toEqual([]);
    expect(vi.mocked(logger.warn).mock.calls.map(call => call[1]))
      .toEqual(['Transport worker not built; carrying requests in-process']);

    const carried = await carry('https://venue.example/a.zip', null);

    expect(carried.status).toBe(299);
    expect(deliver).toHaveBeenCalledWith('https://venue.example/a.zip', null);
  });
});

/**
 * **A worker that cannot start is not started for ever.** Each exit of a
 * worker that never settled waits twice as long as the last before the next
 * try, and after a handful the slot is left empty.
 */
describe('a worker that keeps exiting', () => {
  it('is replaced after a wait that doubles, then no longer replaced', async () => {
    const started = join(here, 'started');
    const dying   = join(here, 'dying.js');

    writeFileSync(started, '');
    writeFileSync(dying,
      `require('node:fs').appendFileSync(${JSON.stringify(started)}, 'x'); process.exit(1);`);

    vi.useFakeTimers({ toFake: ['setTimeout'] });

    openTransport(1, dying);

    const spawns  = (): number => readFileSync(started, 'utf8').length;
    const replace = 'Transport worker exited; starting another';

    for (let exit = 1; exit <= 4; exit++) {
      await until(() => errors(replace).length === exit);

      const inMs = errors(replace)[exit - 1]!.inMs as number;

      expect(inMs).toBe(1_000 * 2 ** (exit - 1));

      // Nothing is started before the wait is over.
      vi.advanceTimersByTime(inMs - 1);

      expect(_test_lanes()).toEqual([null]);

      vi.advanceTimersByTime(1);

      expect(_test_lanes()[0]).not.toBeNull();
    }

    await until(() => errors('Transport worker keeps exiting; no longer replacing it').length === 1);

    vi.advanceTimersByTime(10 * 60_000);

    await new Promise(resolve => pause(resolve, 200));

    expect(spawns()).toBe(5);
    expect(_test_lanes()).toEqual([null]);

    // With no worker serving, requests are carried here.
    expect((await carry('https://venue.example/a.zip', null)).status).toBe(299);
  }, 30_000);

  it('starts nothing for a while after the first exit', async () => {
    const started = join(here, 'started');
    const dying   = join(here, 'dying.js');

    writeFileSync(started, '');
    writeFileSync(dying,
      `require('node:fs').appendFileSync(${JSON.stringify(started)}, 'x'); process.exit(1);`);

    openTransport(1, dying);

    await new Promise(resolve => pause(resolve, 2_000));

    expect(readFileSync(started, 'utf8').length).toBeLessThan(5);
  }, 10_000);
});

/**
 * The real worker, run from its TypeScript source through `ts-node`, carrying
 * requests to a local server.
 */
describe('a running worker', () => {
  let server: Server;
  let url:    string;

  /** A port nothing listens on: a server opened and closed again. */
  let closed: string;

  /** Requests the server has taken and will never answer. */
  let hanging: number;

  beforeEach(async () => {
    hanging = 0;
    server  = createServer((req, res) => {
      if (req.url?.startsWith('/hang')) {
        hanging++;

        return;
      }

      res.writeHead(200, { 'x-asked': req.url ?? '' });
      res.end();
    });

    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));

    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const gone = createServer();

    await new Promise<void>(ready => gone.listen(0, '127.0.0.1', ready));

    closed = `http://127.0.0.1:${(gone.address() as { port: number }).port}`;

    await new Promise(done => gone.close(done));
  });

  afterEach(async () => {
    server.closeAllConnections();

    await new Promise(done => server.close(done));
  });

  /** A worker file that runs `transport.worker.ts` itself. */
  const source = (): string => {
    const boot   = join(here, 'boot.js');
    const tsNode = createRequire(import.meta.url).resolve('ts-node');

    writeFileSync(boot, [
      `require(${JSON.stringify(tsNode)}).register({`,
      `  transpileOnly: true, project: ${JSON.stringify(join(__dirname, '..', 'tsconfig.json'))},`,
      '});',
      `require(${JSON.stringify(join(__dirname, '..', 'src', 'transport.worker.ts'))});`,
    ].join('\n'));

    return boot;
  };

  it('answers each request with its own reply', async () => {
    openTransport(1, source());

    const paths   = Array.from({ length: 20 }, (_, n) => `/file-${n}.zip`);
    const carried = await Promise.all(paths.map(path => carry(`${url}${path}`, null)));

    expect(carried.map(one => one.status)).toEqual(paths.map(() => 200));
    expect(carried.map(one => one.headers['x-asked'])).toEqual(paths);
    expect(deliver).not.toHaveBeenCalled();
  }, 20_000);

  /** The reason a request failed survives the crossing, so a log line still says it. */
  it('fails a request with the cause the worker saw', async () => {
    openTransport(1, source());

    const failed = await carry(`${closed}/?prefix=`, { format: 's3', prefix: '' }).catch((err: Error) => err);

    expect(failed).toBeInstanceOf(Error);
    expect(((failed as Error).cause as { code?: string }).code).toBe('ECONNREFUSED');
  }, 20_000);

  it('fails what a worker held when it exits, and its replacement serves what follows', async () => {
    openTransport(1, source());

    // Running, and answering.
    expect((await carry(`${url}/first.zip`, null)).status).toBe(200);

    const held = [carry(`${url}/hang/a`, null), carry(`${url}/hang/b`, null)];

    await until(() => hanging === 2);

    await _test_lanes()[0]!.worker.terminate();

    for (const one of held) await expect(one).rejects.toThrow('Transport worker exited');

    // Until the replacement starts, requests are carried here.
    expect(_test_lanes()).toEqual([null]);
    expect((await carry(`${url}/between.zip`, null)).status).toBe(299);

    await until(() => _test_lanes()[0] !== null);

    const after = await carry(`${url}/after.zip`, null);

    expect(after.status).toBe(200);
    expect(after.headers['x-asked']).toBe('/after.zip');
  }, 20_000);
});
