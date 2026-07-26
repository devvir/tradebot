import { describe, it, expect } from 'vitest';
import { buildLayout } from '../../../../src/tools/data/status/layout';
import { nextDay } from '../../../../src/tools/data/ranges';
import type { DayState, TableState, VaultState } from '../../../../src/tools/data/scan/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A day present everywhere: stored locally and bucketed. */
function fullDay(day: string): DayState {
  return {
    day,
    localSuffixes:     ['csv.gz'],
    localTmpSuffixes:  [],
    remoteSuffixes:    {},
    remoteTmpSuffixes: {},
    megaSources:       [],
    localBucket:       true,
    localBucketTmp:    false,
    megaBucket:        true,
  };
}

function yesterdayYmd(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);

  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * A REST table complete from `start` through `to` (yesterday by default). The
 * starts used here are the real ones from holes.ts's TABLE_START — days before
 * a table's own start are structural pre-history and never open a range.
 */
function completeTable(name: string, start: string, to = yesterdayYmd()): TableState {
  const days = new Map<string, DayState>();

  for (let d = start; d <= to; d = nextDay(d)) days.set(d, fullDay(d));

  return { name, origin: 'rest', sourced: false, days, megaBucketTars: [], megaSourceTars: [] };
}

function vaultState(tables: TableState[]): VaultState {
  return {
    config:    { localBase: '/tmp', remotes: [], megaVault: 'vault', megaRaw: 'raw' },
    tables,
    scannedAt: new Date(),
  };
}

// ── Grouping on the first range's start ───────────────────────────────────────

describe('buildLayout — grouping', () => {
  // The first range always opens on the table's own first day, so its date says
  // nothing about the table's state: two tables complete from their start are in
  // the same condition whether that start was 2014 or 2016.
  it('merges tables whose only difference is the year they started in', async () => {
    const layout = await buildLayout(vaultState([
      completeTable('funding', '20160507'),   // 2016
      completeTable('tick',    '20141106'),   // 2014
    ]));

    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0]!.names).toEqual(['funding', 'tick']);
  });

  it('keeps tables apart when a later endpoint differs', async () => {
    const short = yesterdayYmd();

    const layout = await buildLayout(vaultState([
      completeTable('funding',    '20160507'),
      completeTable('insurance',  '20160228', previousDay(previousDay(short))),
    ]));

    expect(layout.groups).toHaveLength(2);
  });

  it('leaves the stored range untouched — only the grouping key is normalised', async () => {
    const layout = await buildLayout(vaultState([
      completeTable('funding', '20160507'),
      completeTable('tick',    '20141106'),
    ]));

    // The merged group renders its first member's real dates; only the display
    // labels that endpoint "start".
    expect(layout.groups[0]!.ranges[0]!.startKey).toBe('20160507');
  });
});

function previousDay(day: string): string {
  const d = new Date(Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(4, 6)) - 1,
    Number(day.slice(6, 8)) - 1,
  ));

  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
