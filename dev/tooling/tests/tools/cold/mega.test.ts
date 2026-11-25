import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _test_with as standIns, megaCmd, notThere } from '../../../src/tools/cold/shared/mega/exec';
import { landed, listing } from '../../../src/tools/cold/shared/mega/listing';
import { _test_parseListing as parseListing } from '../../../src/tools/cold/shared/mega/listing';
import { _test_parseSummary as parseSummary, _test_unsay as unsay, queue, queuedPaths, transferName } from '../../../src/tools/cold/shared/mega/transfers';
import { warn } from '../../../src/shared/ui/logger';
import { _test_roundOf as roundOf } from '../../../src/tools/cold/push/archives/work';
import { runPush } from '../../../src/tools/cold/push/archives';
import { runPushVault } from '../../../src/tools/cold/push/vault';
import type { ColdConfig } from '../../../src/tools/cold/types';
import * as mega from '../../../src/tools/cold/shared/mega';
import * as record from '../../../src/tools/cold/shared/record';

vi.mock('../../../src/shared/ui/logger', async actual => ({
  ...await actual<object>(),
  warn: vi.fn(),
}));

/**
 * Both of these read mega-cmd's human output, so they are the parts most likely
 * to break silently when it changes — and the pacing one decides whether the
 * packer runs at all.
 */
describe('what the upload queue has left', () => {
  const SUMMARY = [
    '   NUM DOWNLOADS  DOWNLOADED       TOTAL    %             NUM UPLOADS    UPLOADED       TOTAL    %   ',
    '               0    0.00   B    0.00   B   0.00%                   11    3.89 GB    50.25 GB   7.75%',
  ].join('\n');

  const GiB = 1024 ** 3;

  it('reads the upload half, not the download half', () => {
    const state = parseSummary(SUMMARY);

    expect(state).toMatchObject({ transfers: 11 });
    expect(state!.total).toBeCloseTo(50.25 * GiB, 0);
  });

  /**
   * **Mega's `GB` is a GiB.** A tar of 2,001,274,880 bytes on disk comes back
   * from `mega-transfers` as `1908.56 MB` — that figure over 1024², not 1000².
   */
  it('reads the labels as binary, which is what Mega means by them', () => {
    const total = parseSummary(
      '   NUM DOWNLOADS  DOWNLOADED       TOTAL    %             NUM UPLOADS    UPLOADED       TOTAL    %\n'
      + '               0    0.00   B    0.00   B   0.00%                    1    0.00   B 1908.56 MB   0.00%',
    )!.total;

    // Mega prints two decimals, so the most it can pin down is ±0.005 MiB.
    expect(Math.abs(total - 2001274880)).toBeLessThan(0.005 * 1024 ** 2);

    // Binary, not decimal: 1024² over 1000² more than the figure printed.
    expect(total / (1908.56 * 1e6)).toBeCloseTo(1.048576, 3);
  });

  /**
   * `TOTAL` is the queue as it stands — active plus waiting, with finished
   * transfers already gone — so the difference is what is still to send.
   */
  it('reports what remains rather than what has gone', () => {
    expect(parseSummary(SUMMARY)!.remaining).toBeCloseTo((50.25 - 3.89) * GiB, 0);
  });

  it('handles a queue that has drained', () => {
    const state = parseSummary(
      '   NUM DOWNLOADS  DOWNLOADED       TOTAL    %             NUM UPLOADS    UPLOADED       TOTAL    %\n'
      + '               0    0.00   B    0.00   B   0.00%                    0    0.00   B    0.00   B   0.00%');

    expect(state).toMatchObject({ transfers: 0, remaining: 0 });
  });

  it('says nothing rather than guessing when the shape is unfamiliar', () => {
    expect(parseSummary('mega-cmd is not running')).toBeNull();
  });
});

describe('confirming a file landed', () => {
  const LISTING = [
    '/Tradebot/sources/archives/bybit/2024:',
    'FLAGS VERS      SIZE            DATE          HANDLE NAME',
    '----    1   1998765432 2026-08-05T22:09:10 H:7BtQjCAL bybit-202405.001.tar',
    '----    1    998765432 2026-08-05T22:11:02 H:7AkyiIDQ bybit-202405.002.tar',
  ].join('\n');

  it('reads the size, the handle and the modification time of the file asked for', () => {
    expect(parseListing(LISTING, 'bybit-202405.002.tar'))
      .toEqual({ bytes: 998765432, handle: 'H:7AkyiIDQ', modified: '2026-08-05T22:11:02' });
  });

  /** What says a file has arrived: Mega lists that very file — its size and its own modification time. */
  it('takes a file as landed only where Mega lists it at its size and its own time, whatever zone either is in', () => {
    const file = path.join(os.tmpdir(), `landed-${process.pid}.bin`);

    fs.writeFileSync(file, 'abcd');
    fs.utimesSync(file, new Date('2026-08-05T20:11:02.700Z'), new Date('2026-08-05T20:11:02.700Z'));

    try {
      expect(landed(file, { bytes: 4, handle: 'H', modified: '2026-08-05T20:11:02' })).toBe(true);

      // Written in another zone: the same moment.
      expect(landed(file, { bytes: 4, handle: 'H', modified: '2026-08-05T22:11:02' })).toBe(true);
      expect(landed(file, { bytes: 4, handle: 'H', modified: '2026-08-06T01:41:02' })).toBe(true);

      // The same size, left there by an earlier upload.
      expect(landed(file, { bytes: 4, handle: 'H', modified: '2026-08-05T20:11:03' })).toBe(false);
      expect(landed(file, { bytes: 4, handle: 'H', modified: '2026-08-04T20:11:02' })).toBe(false);

      expect(landed(file, { bytes: 5, handle: 'H', modified: '2026-08-05T20:11:02' })).toBe(false);
      expect(landed(file, null)).toBe(false);
      expect(landed(`${file}.gone`, { bytes: 4, handle: 'H', modified: '2026-08-05T20:11:02' })).toBe(false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  /** A file Mega does not hold is how "not uploaded yet" is expressed. */
  it('returns nothing when the name is absent', () => {
    expect(parseListing(LISTING, 'bybit-202405.009.tar')).toBeNull();

    // A name that only ends with one listed is not it.
    expect(parseListing(LISTING, 'it-202405.001.tar')).toBeNull();
  });
});

describe('what a file being moved is called', () => {
  it('names a tar by its own name, which carries its venue and month', () => {
    expect(transferName('/Tradebot/sources/archives/binance/2024/binance-202405.001.tar')).toBe('binance-202405.001.tar');
    expect(transferName('/data/cold/archives/staging/binance/binance-202405.001.tar')).toBe('binance-202405.001.tar');
  });

  it('names a vault file by the partition it is of, since every slice has a file called after its month', () => {
    const one = transferName('/Tradebot/sources/vault/venue=binance/market=spot/dataset=trades/BTCUSDT/2024-05.parquet');
    const two = transferName('/Tradebot/sources/vault/venue=bybit/market=spot/dataset=trades/BTCUSDT/2024-05.parquet');

    expect(one).not.toBe(two);
    expect(one).toContain('BTCUSDT');
  });
});

/** Commands reach both through one name each: a function missing there is a command that fails as it starts. */
describe('what the commands reach Mega and the record through', () => {
  it('holds every function they call', () => {
    for (const name of ['available', 'queueUpload', 'queueDownload', 'downloadingPaths', 'queue', 'queuedPaths', 'transfers', 'transferName', 'remove', 'listing', 'remote'] as const)
      expect(typeof mega[name], name).toBe('function');

    for (const name of ['open', 'close', 'tarsOf', 'storedOf', 'evictedOf', 'vaultFiles', 'totals'] as const)
      expect(typeof record[name], name).toBe('function');
  });
});

describe('a command sent while Mega is not answering', () => {
  afterEach(() => {
    standIns(null, null);
    vi.restoreAllMocks();
  });

  /** What is asked, in order, and what each attempt is answered with. */
  const mega = (answers: Record<string, (Error | string)[]>) => {
    const asked: string[] = [];
    const waits: number[] = [];

    standIns(async (command) => {
      asked.push(command);

      const next = answers[command]?.shift() ?? '';

      if (next instanceof Error) throw next;

      return { stdout: next, stderr: '' };
    }, async (ms) => { waits.push(ms); });

    return { asked, waits };
  };

  const down = new Error('mega-cmd server not running');

  /** Nothing is concluded from silence: it waits, longer each time, and sends the command again. */
  it('waits until Mega is back, then sends it again', async () => {
    const { asked, waits } = mega({
      'mega-ls':     [down, 'listed'],
      'mega-whoami': [down, down, down, down, down, down, 'me'],
    });

    expect((await megaCmd('mega-ls', [], { timeout: 1 })).stdout).toBe('listed');

    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(asked.filter(one => one === 'mega-ls')).toHaveLength(2);
  });

  /** Mega is there and said no: that is the command's own failure, and nothing to wait out. */
  it('fails at once where Mega is answering', async () => {
    const refused = new Error('Couldn\'t find /x');
    const { waits } = mega({ 'mega-ls': [refused], 'mega-whoami': ['me'] });

    await expect(megaCmd('mega-ls', [], { timeout: 1 })).rejects.toBe(refused);

    expect(waits).toEqual([]);
  });

  /** Nothing else holds the process while Mega is away: a wait that did not would end the run with nothing said. */
  it('holds the run open while it waits for Mega to come back', async () => {
    const real   = globalThis.setTimeout;
    const waited: { ms: number; held: () => boolean }[] = [];

    // Each wait taken at once, and kept to see whether it held the process.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((done: () => void, ms?: number) => {
      const timer = real(done, 0);

      waited.push({ ms: ms ?? 0, held: () => timer.hasRef() });

      return timer;
    }) as typeof setTimeout);

    let whoami = 0;

    standIns(async (command) => {
      if (command === 'mega-whoami' && ++whoami <= 2) throw down;
      if (command === 'mega-ls' && whoami === 0) throw down;

      return { stdout: 'listed', stderr: '' };
    }, null);

    expect((await megaCmd('mega-ls', [], { timeout: 1 })).stdout).toBe('listed');

    const forMega = waited.filter(one => one.ms === 5_000 || one.ms === 10_000);

    expect(forMega).toHaveLength(2);
    expect(forMega.every(one => one.held())).toBe(true);
  });

  /** A look given only so long: what it gets is what it gets, and Mega is not waited for. */
  it('with once, fails as it is and asks nothing more', async () => {
    const late = Object.assign(new Error('Command failed: mega-ls'), { killed: true, signal: 'SIGKILL' });
    const { asked, waits } = mega({ 'mega-ls': [late, down], 'mega-whoami': [down] });

    await expect(megaCmd('mega-ls', [], { timeout: 1, once: true })).rejects.toBe(late);
    await expect(megaCmd('mega-ls', [], { timeout: 1, once: true })).rejects.toBe(down);

    expect(asked).toEqual(['mega-ls', 'mega-ls']);
    expect(waits).toEqual([]);
  });

  it('gives a listing and a look at the queue the time they are asked for, and fails them once it is up', async () => {
    const given: Record<string, number> = {};

    standIns(async (command, _args, options) => {
      given[command] = options.timeout;

      if (command === 'mega-whoami') throw new Error('asked whether Mega is there');

      throw Object.assign(new Error(`Command failed: ${command}`), { killed: true });
    }, async () => {});

    await expect(listing('/x', { timeout: 1_234, once: true })).rejects.toThrow(/mega-ls/);
    await expect(queuedPaths({ timeout: 2_345, once: true })).rejects.toThrow(/mega-transfers/);

    expect(given).toEqual({ 'mega-ls': 1_234, 'mega-transfers': 2_345 });
  });

  it('takes a tree that is not there for an empty one, and no other failure for it', async () => {
    mega({ 'mega-ls': [Object.assign(new Error('exit 53'), { stderr: 'cmd ERR  Couldn\'t find /x/none' })], 'mega-whoami': ['me'] });

    expect((await listing('/x/none')).size).toBe(0);

    mega({ 'mega-ls': [new Error('timed out')], 'mega-whoami': ['me'] });

    await expect(listing('/x')).rejects.toThrow(/timed out/);
  });

  /** Mega works through one thing at a time: a command behind something long was not refused, it was not reached. */
  it('sends a command that got no answer again only once Mega says it is there', async () => {
    const late = Object.assign(new Error('Command failed: mega-get'), { killed: true, signal: 'SIGTERM' });
    const down = new Error('no answer');
    const { asked, waits } = mega({ 'mega-get': [late, late, 'queued'], 'mega-whoami': [down, down, 'me', 'me'] });

    expect((await megaCmd('mega-get', [], { timeout: 1 })).stdout).toBe('queued');

    // Asked who is logged in after each wait; the command goes again only after an answer.
    expect(asked).toEqual(['mega-get', 'mega-whoami', 'mega-whoami', 'mega-whoami', 'mega-get', 'mega-whoami', 'mega-get']);
    // 5, 10, 20 and 40 seconds, each waited a second at a time so that what is left can be said.
    expect(waits.every(wait => wait === 1_000)).toBe(true);
    expect(waits.reduce((sum, wait) => sum + wait, 0)).toBe(75_000);
  });

  /** It was only the answer that never came: what was asked for is under way, and is not asked for twice. */
  it('does not send it again where what it was for has come about meanwhile', async () => {
    const late = Object.assign(new Error('Command failed: mega-get'), { killed: true, signal: 'SIGTERM' });
    const { asked } = mega({ 'mega-get': [late, late] });

    let looked = 0;

    await megaCmd('mega-get', [], { timeout: 1, settled: async () => ++looked === 2 });

    expect(asked.filter(one => one === 'mega-get')).toHaveLength(2);
  });

  it('tells a path that is not there from any other failure', () => {
    expect(notThere({ stderr: '[cmd ERR  Couldn\'t find "/a/b"]' })).toBe(true);
    expect(notThere(new Error('ETIMEDOUT'))).toBe(false);
  });
});

/** Unknown is not empty: a queue that could not be read may be full, and nothing is packed for it. */
describe('how much the upload queue holds', () => {
  afterEach(() => standIns(null, null));

  const SUMMARY = '   NUM DOWNLOADS  DOWNLOADED       TOTAL    %             NUM UPLOADS    UPLOADED       TOTAL    %\n'
    + '               0    0.00   B    0.00   B   0.00%                    1    0.00   B    1.00 GB   0.00%';

  /** Mega answering each command in turn with one of these. */
  const answering = (...answers: (Error | string)[]): void =>
    standIns(async (command) => {
      if (command === 'mega-whoami') return { stdout: 'me', stderr: '' };

      const next = answers.shift() ?? '';

      if (next instanceof Error) throw next;

      return { stdout: next, stderr: '' };
    }, async () => {});

  const config = { queueTargetGb: 10 } as ColdConfig;

  it('is not known where Mega refuses to say, or says it in a shape that does not read', async () => {
    answering(new Error('Command failed: mega-transfers'));
    expect(await queue()).toBeNull();

    answering('a summary of some new shape');
    expect(await queue()).toBeNull();

    answering(SUMMARY);
    expect(await queue()).toMatchObject({ transfers: 1, remaining: 1024 ** 3 });
  });

  /** A queue that cannot be read holds packing back, so it is never held back without a word. */
  it('says once that Mega did not say, and once that what it said does not read', async () => {
    unsay();
    vi.mocked(warn).mockClear();

    answering(new Error('Command failed: mega-transfers --summary\nunknown option'), new Error('Command failed: mega-transfers --summary'));
    await queue();
    await queue();

    answering('a summary of some new shape', 'a summary of some new shape');
    await queue();
    await queue();

    const said = vi.mocked(warn).mock.calls.map(([line]) => String(line));

    expect(said).toHaveLength(2);
    expect(said[0]).toMatch(/did not say what its upload queue holds.*Command failed: mega-transfers --summary$/);
    expect(said[1]).toMatch(/does not read.*a summary of some new shape$/);
  });

  it('leaves room for a tar only where it is known to have room', async () => {
    answering('a summary of some new shape');
    expect(await roundOf(config).room()).toBe(false);

    answering(new Error('Command failed: mega-transfers'));
    expect(await roundOf(config).room()).toBe(false);

    answering(SUMMARY);
    expect(await roundOf(config).room()).toBe(true);
  });
});

/** A command that cannot start for want of Mega has failed, and says so to whatever ran it. */
describe('a command that finds Mega not there', () => {
  let dir: string;

  afterEach(() => {
    standIns(null, null);
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const away = (): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-away-'));

    for (const [name, value] of Object.entries({ DATA_DIR: dir, MEGA_ROOT: '/m', SOURCES_COLD_DIR: '', DATA_ARCHIVES_DIR: '', DATA_VAULT_DIR: '' }))
      vi.stubEnv(name, value);

    standIns(async () => { throw new Error('mega-cmd server not running'); }, async () => {});
  };

  it('ends a push of the archives with a failure', async () => {
    away();

    await runPush('archives', { venues: [] });

    expect(process.exitCode).toBe(1);
  });

  it('ends a push of the vault with a failure', async () => {
    away();

    await runPushVault({ venues: [] });

    expect(process.exitCode).toBe(1);
  });
});
