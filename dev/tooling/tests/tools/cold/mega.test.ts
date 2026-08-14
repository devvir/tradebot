import { describe, expect, it } from 'vitest';
import {
  _test_parseListing as parseListing,
  _test_parseSummary as parseSummary,
} from '../../../src/tools/cold/mega';

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
