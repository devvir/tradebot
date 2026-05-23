import { describe, it, expect } from 'vitest';
import { pairsExisting, pairsNotOnMega } from '../../../src/tools/db/utils/existing';
import { pairKey } from '../../../src/tools/db/types';
import { parseDateRange } from '../../../src/tools/db/utils/dates';
import type { Pair, ExistingStatus } from '../../../src/tools/db/types';

const d2024 = parseDateRange('2024');
const d2025 = parseDateRange('2025');

const pairs: Pair[] = [
  { collection: 'quote', date: d2024 },
  { collection: 'quote', date: d2025 },
  { collection: 'trade', date: d2024 },
];

function status(pairs: Pair[], statuses: ExistingStatus[]): Map<string, ExistingStatus> {
  const map = new Map<string, ExistingStatus>();
  pairs.forEach((p, i) => map.set(pairKey(p), statuses[i]));
  return map;
}

describe('pairsExisting', () => {
  it('returns pairs present locally or on mega (or both)', () => {
    const s = status(pairs, [
      { local: true,  mega: true  },
      { local: false, mega: true  },
      { local: false, mega: false },
    ]);
    expect(pairsExisting(pairs, s).map(pairKey)).toEqual(['quote|2024', 'quote|2025']);
  });

  it('returns empty when nothing exists anywhere', () => {
    const s = status(pairs, [
      { local: false, mega: false },
      { local: false, mega: false },
      { local: false, mega: false },
    ]);
    expect(pairsExisting(pairs, s)).toEqual([]);
  });

  it('returns all when everything exists', () => {
    const s = status(pairs, pairs.map(() => ({ local: true, mega: true })));
    expect(pairsExisting(pairs, s)).toEqual(pairs);
  });

  it('treats missing map entries as not existing', () => {
    expect(pairsExisting(pairs, new Map())).toEqual([]);
  });
});

describe('pairsNotOnMega', () => {
  it('returns pairs without a mega backup, regardless of local presence', () => {
    const s = status(pairs, [
      { local: true,  mega: false },  // local-only, no mega
      { local: false, mega: true  },  // mega-only
      { local: false, mega: false },  // nowhere
    ]);
    expect(pairsNotOnMega(pairs, s).map(pairKey)).toEqual(['quote|2024', 'trade|2024']);
  });

  it('returns all when nothing is on mega', () => {
    const s = status(pairs, pairs.map(() => ({ local: true, mega: false })));
    expect(pairsNotOnMega(pairs, s)).toEqual(pairs);
  });

  it('returns empty when everything is on mega', () => {
    const s = status(pairs, pairs.map(() => ({ local: false, mega: true })));
    expect(pairsNotOnMega(pairs, s)).toEqual([]);
  });

  it('treats missing map entries as not on mega (safe default)', () => {
    expect(pairsNotOnMega(pairs, new Map())).toEqual(pairs);
  });
});
