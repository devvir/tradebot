import { afterEach, describe, expect, it } from 'vitest';
import { _test_with as standIns, megaCmd, notThere } from '../../../src/tools/cold/shared/mega/exec';
import { listing } from '../../../src/tools/cold/shared/mega/listing';
import { _test_parseListing as parseListing } from '../../../src/tools/cold/shared/mega/listing';
import { _test_parseSummary as parseSummary } from '../../../src/tools/cold/shared/mega/transfers';
import * as mega from '../../../src/tools/cold/shared/mega';
import * as record from '../../../src/tools/cold/shared/record';

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
   * Reading the labels as decimal made the queue measure 7.4% light, so packing
   * ran further ahead than the configured target asked for.
   */
  it('reads the labels as binary, which is what Mega means by them', () => {
    const total = parseSummary(
      '   NUM DOWNLOADS  DOWNLOADED       TOTAL    %             NUM UPLOADS    UPLOADED       TOTAL    %\n'
      + '               0    0.00   B    0.00   B   0.00%                    1    0.00   B 1908.56 MB   0.00%',
    )!.total;

    // Mega prints two decimals, so the most it can pin down is ±0.005 MiB.
    expect(Math.abs(total - 2001274880)).toBeLessThan(0.005 * 1024 ** 2);

    // Read as decimal it would have come back ~7.4% light, which is the bug.
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
    '/Tradebot/sources/vault/bybit/2024:',
    'FLAGS VERS      SIZE            DATE          HANDLE NAME',
    '----    1   1998765432 05Aug2026 22:09:10 H:7BtQjCAL 202405.p01.tar',
    '----    1    998765432 05Aug2026 22:11:02 H:7AkyiIDQ 202405.p02.tar',
  ].join('\n');

  it('reads the size and the handle of the file asked for', () => {
    expect(parseListing(LISTING, '202405.p02.tar'))
      .toEqual({ bytes: 998765432, handle: 'H:7AkyiIDQ' });
  });

  /** A file Mega does not hold is how "not uploaded yet" is expressed. */
  it('returns nothing when the name is absent', () => {
    expect(parseListing(LISTING, '202405.p09.tar')).toBeNull();
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
  afterEach(() => standIns(null, null));

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

  it('takes a tree that is not there for an empty one, and no other failure for it', async () => {
    mega({ 'mega-ls': [Object.assign(new Error('exit 53'), { stderr: 'cmd ERR  Couldn\'t find /x/none' })], 'mega-whoami': ['me'] });

    expect((await listing('/x/none')).size).toBe(0);

    mega({ 'mega-ls': [new Error('timed out')], 'mega-whoami': ['me'] });

    await expect(listing('/x')).rejects.toThrow(/timed out/);
  });

  /** Mega works through one thing at a time: a command behind something long was not refused, it was not reached. */
  it('waits and asks again where a command got no answer in its time, however long that goes on', async () => {
    const late = Object.assign(new Error('Command failed: mega-get'), { killed: true, signal: 'SIGTERM' });
    const { asked, waits } = mega({ 'mega-get': [late, late, late, 'queued'] });

    expect((await megaCmd('mega-get', [], { timeout: 1 })).stdout).toBe('queued');

    expect(waits).toEqual([5_000, 10_000, 20_000]);
    expect(asked).toEqual(['mega-get', 'mega-get', 'mega-get', 'mega-get']);
  });

  /** It was only the answer that never came: what was asked for is under way, and is not asked for twice. */
  it('does not send it again where what it was for has come about meanwhile', async () => {
    const late = Object.assign(new Error('Command failed: mega-get'), { killed: true, signal: 'SIGTERM' });
    const { asked } = mega({ 'mega-get': [late, late] });

    let looked = 0;

    await megaCmd('mega-get', [], { timeout: 1, settled: async () => ++looked === 2 });

    expect(asked).toEqual(['mega-get', 'mega-get']);
  });

  it('tells a path that is not there from any other failure', () => {
    expect(notThere({ stderr: '[cmd ERR  Couldn\'t find "/a/b"]' })).toBe(true);
    expect(notThere(new Error('ETIMEDOUT'))).toBe(false);
  });
});
