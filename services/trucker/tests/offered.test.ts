import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveFile, Dataset, InventoryShape } from '../src/types';
import type { VenueArchive } from '../src/venues';

let dir: string;

vi.mock('../src/config', () => ({
  default: {
    get dataDir() { return dir; },
    get sharedDir() { return join(dir, 'shared'); },
    rescanHours: 6,
    symbols:     [],
    concurrency: 1,
    minFreeGb:   0,
    startMonth:  null,
    endMonth:    null,
    venues:      [],
  },
}));

const { _test_offered: offered, _test_stale: stale } = await import('../src/sync');
const inventory = await import('../src/inventory');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'offered-'));

  // The ledger is held per venue and dataset for the life of the process, so a
  // fresh temp dir alone would still be read through the previous test's copy.
  inventory._test_reset();
});

const dataset: Dataset = { id: 'spot-trades', kind: 'trades', market: 'spot', path: 'trades' };

const file = (date: string): ArchiveFile => ({
  url:    `https://h/spot/daily/trades/BTCUSDT/BTCUSDT-trades-${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}.zip`,
  path:   `spot/daily/trades/BTCUSDT/BTCUSDT-trades-${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}.zip`,
  date,
  symbol: 'BTCUSDT',
  period: 'daily',
});

/** A listing venue whose whole published history is `dates`. */
const listing = (dates: string[]) => {
  const files = vi.fn(async (_d: Dataset, _s: string, since: string | null) =>
    dates.filter(date => ! since || date > since).map(file));

  return { venue: { name: 'fake', floor: '202601', datasets: [dataset], symbols: async () => ['BTCUSDT'], files } as unknown as VenueArchive, files };
};

const stock = () => inventory.cached('fake', dataset.id);

/** `yyyymmdd` n days before today, for the cases that turn on "still live". */
const daysAgo = (n: number): string => {
  const d = new Date();

  d.setUTCDate(d.getUTCDate() - n);

  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

const shapesFor = async (dates: string[], asOf: string) => {
  const known = await stock();

  await inventory.record('fake', dataset.id, inventory.shapesOf(dates.map(file), asOf), known);

  return known;
};

describe('offered', () => {
  /**
   * The fault this whole design exists for: the month-major walk asked every
   * symbol's whole history once per month and kept a month of the answer. On
   * binance that is ~87 pages per symbol per month, and no month ever finished.
   */
  it('asks the venue once, then answers every later month from the ledger', async () => {
    const { venue, files } = listing(['20260701', '20260702', '20260801']);
    const known = await stock();

    const july = await offered(venue, dataset, 'BTCUSDT', null, '20260731', known);

    expect(files).toHaveBeenCalledTimes(1);
    expect(july.map(f => f.date)).toEqual(['20260701', '20260702']);

    const august = await offered(venue, dataset, 'BTCUSDT', '20260702', '20260831', known);

    // The second month is the point: no request at all.
    expect(files).toHaveBeenCalledTimes(1);
    expect(august.map(f => f.date)).toEqual(['20260801']);
  });

  it('survives a restart, because the ledger is on disk', async () => {
    const { venue, files } = listing(['20260701', '20260801']);

    await offered(venue, dataset, 'BTCUSDT', null, '20260731', await stock());

    // A fresh map is what a restarted process gets.
    const reloaded = await inventory.load('fake', dataset.id);
    const august   = await offered(venue, dataset, 'BTCUSDT', '20260701', '20260831', reloaded);

    expect(files).toHaveBeenCalledTimes(1);
    expect(august.map(f => f.date)).toEqual(['20260801']);
  });

  it('offers nothing twice, and skips nothing the venue published', async () => {
    const dates = ['20260701', '20260703', '20260801'];
    const { venue } = listing(dates);
    const known = await stock();

    const seen: string[] = [];
    let cursor: string | null = null;

    for (const [limit, through] of [['20260731', '20260703'], ['20260831', '20260801']] as const) {
      const batch = await offered(venue, dataset, 'BTCUSDT', cursor, limit, known);

      seen.push(...batch.map(f => f.date));
      cursor = through;
    }

    expect(seen).toEqual(dates);
    expect(new Set(seen).size).toBe(seen.length);
  });

  /**
   * A constructed-URL venue has no listing to remember, and a ledger of guesses
   * would record what we assumed exists rather than what does.
   */
  it('leaves constructed-URL venues asking the venue every time', async () => {
    const { venue, files } = listing(['20260701']);
    const constructing = { ...venue, constructsUrls: true } as VenueArchive;
    const known = await stock();

    await offered(constructing, dataset, 'BTCUSDT', null, '20260731', known);
    await offered(constructing, dataset, 'BTCUSDT', null, '20260831', known);

    expect(files).toHaveBeenCalledTimes(2);
    expect(known.size).toBe(0);          // nothing recorded
  });

  it('extends the ledger at the tip without losing what it already held', async () => {
    // Dated against today, since "still publishing" is measured from now — a
    // fixed date here would pass this week and fail next.
    const held  = daysAgo(2);
    const fresh = daysAgo(1);
    const old   = '20260101';

    const { venue, files } = listing([old, held, fresh]);

    // Enumerated a while ago, through a date still inside the live window: the
    // one case that earns a second question.
    const known = await shapesFor([old, held], '2020-01-01T00:00:00.000Z');

    // Walking the tip month, the venue is asked again — from where the ledger
    // ends, not from the beginning.
    const tip = await offered(venue, dataset, 'BTCUSDT', held, fresh, known);

    expect(files).toHaveBeenCalledTimes(1);
    expect(files).toHaveBeenLastCalledWith(dataset, 'BTCUSDT', held);
    expect(tip.map(f => f.date)).toEqual([fresh]);

    // And the old history is still there — a refresh must never narrow the
    // record to the window it happened to ask about.
    expect(inventory.filesIn(known, 'BTCUSDT', null, fresh).map(f => f.date))
      .toEqual([old, held, fresh]);
  });
});

describe('stale', () => {
  const now = new Date('2026-08-05T00:00:00Z');

  const shapes = (through: string, asOf: string): Map<string, InventoryShape> => {
    const known = new Map<string, InventoryShape>();

    for (const shape of inventory.shapesOf([file(through)], asOf))
      known.set(`${shape.symbol}\t${shape.period}\t${shape.url}`, shape);

    return known;
  };

  it('never re-asks while the walk is still behind what it knows', () => {
    const known = shapes('20260801', '2020-01-01T00:00:00.000Z');

    // Walking 2026-06 with files known through 2026-08: re-listing cannot
    // change a month that is already settled history.
    expect(stale(known, 'BTCUSDT', '20260630', now)).toBe(false);
  });

  /** A symbol whose newest file has aged past the window has stopped publishing. */
  it('never re-asks a symbol that stopped publishing', () => {
    const known = shapes('20240101', '2020-01-01T00:00:00.000Z');

    expect(stale(known, 'BTCUSDT', '20260831', now)).toBe(false);
  });

  it('re-asks a live symbol once the walk reaches the tip and the answer is old', () => {
    const known = shapes('20260804', '2020-01-01T00:00:00.000Z');

    expect(stale(known, 'BTCUSDT', '20260831', now)).toBe(true);
  });

  it('does not re-ask a live symbol that was just asked', () => {
    const known = shapes('20260804', new Date().toISOString());

    expect(stale(known, 'BTCUSDT', '20260831', now)).toBe(false);
  });

  it('always asks about a symbol it has never seen', () => {
    expect(stale(new Map(), 'BTCUSDT', '20260831', now)).toBe(true);
  });
});
