import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTEMPTS, compact, isDue, load, record, retryAbsences } from '../src/absences';
import { download } from '../src/download';
import type { Absence } from '../src/types';

vi.mock('../src/download', () => ({ download: vi.fn() }));

const mocked = vi.mocked(download);

const HOURS = 60 * 60 * 1000;

const entry = (over: Partial<Absence> = {}): Absence => ({
  venue: 'okx', dataset: 'swap-trades', symbol: 'BTC-USDT-SWAP',
  date: '20240101', period: 'daily',
  url: `https://x/${over.date ?? '20240101'}.zip`, path: `p/${over.date ?? '20240101'}.zip`,
  firstSeen: new Date(Date.now() - 48 * HOURS).toISOString(),
  lastTried: new Date(Date.now() - 48 * HOURS).toISOString(),
  attempts: 1,
  ...over,
});

beforeEach(async () => {
  mocked.mockReset();
  await compact([]);   // empty ledger
});

describe('the ledger', () => {
  it('supersedes earlier records of the same URL and survives a compact', async () => {
    await record(entry({ attempts: 1 }));
    await record(entry({ attempts: 2 }));

    const loaded = await load();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.attempts).toBe(2);

    await compact(loaded);

    expect(await load()).toHaveLength(1);
  });

  it('waits longer between attempts as they accumulate', () => {
    const now = Date.now();
    const at  = (hoursAgo: number, attempts: number): Absence =>
      entry({ attempts, lastTried: new Date(now - hoursAgo * HOURS).toISOString() });

    expect(isDue(at(2, 1), now)).toBe(false);    // 6 h backoff after one attempt
    expect(isDue(at(7, 1), now)).toBe(true);
    expect(isDue(at(7, 3), now)).toBe(false);    // 72 h after three
    expect(isDue(at(73, 3), now)).toBe(true);
  });
});

describe('retryAbsences', () => {
  it('drops an entry once the file downloads', async () => {
    await record(entry());
    mocked.mockResolvedValue({ status: 'downloaded', bytes: 10 });

    await retryAbsences();

    expect(await load()).toHaveLength(0);
  });

  /**
   * A failed probe is a transport problem, not evidence of absence. Counting it
   * would let a few bad-network evenings write off a file the ledger exists to
   * protect.
   */
  it('does not count a failed probe as an absence attempt', async () => {
    await record(entry({ attempts: MAX_ATTEMPTS - 1 }));
    mocked.mockResolvedValue({ status: 'failed', bytes: 0 });

    await retryAbsences();

    const kept = await load();

    expect(kept).toHaveLength(1);
    expect(kept[0]!.attempts).toBe(MAX_ATTEMPTS - 1);   // unchanged
  });

  it('counts an absent probe, and accepts the absence at the limit', async () => {
    const longAgo = new Date(Date.now() - 100 * HOURS).toISOString();

    await record(entry({ date: '20240101', attempts: 1 }));
    await record(entry({ date: '20240102', attempts: MAX_ATTEMPTS - 1, lastTried: longAgo }));
    mocked.mockResolvedValue({ status: 'absent', bytes: 0 });

    await retryAbsences();

    const kept = await load();

    expect(kept).toHaveLength(1);                 // the exhausted one was dropped
    expect(kept[0]!.date).toBe('20240101');
    expect(kept[0]!.attempts).toBe(2);
  });

  it('leaves entries that are not yet due untouched', async () => {
    await record(entry({ lastTried: new Date().toISOString() }));

    await retryAbsences();

    expect(mocked).not.toHaveBeenCalled();
    expect(await load()).toHaveLength(1);
  });
});
