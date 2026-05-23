import { describe, it, expect } from 'vitest';
import { computeSpaceMode, neededDownloadBytes } from '../../../../src/tools/db/restore/space';
import type { RestoreTarget } from '../../../../src/tools/db/restore/types';

function localOnly(size: number): RestoreTarget {
  return { collection: 'x', key: '2024', filename: '2024.archive.gz', local: { path: '/x', size }, mega: null };
}

function megaOnly(size: number): RestoreTarget {
  return { collection: 'x', key: '2024', filename: '2024.archive.gz', local: null, mega: { path: 'mega:/x', size } };
}

function both(localSize: number, megaSize: number): RestoreTarget {
  return {
    collection: 'x', key: '2024', filename: '2024.archive.gz',
    local: { path: '/x', size: localSize },
    mega:  { path: 'mega:/x', size: megaSize },
  };
}

// ── neededDownloadBytes ────────────────────────────────────────────────────────

describe('neededDownloadBytes', () => {
  it('is zero when everything is local-only', () => {
    expect(neededDownloadBytes([localOnly(1_000), localOnly(2_000)])).toBe(0);
  });

  it('is zero when everything is already on local even if Mega also has it', () => {
    expect(neededDownloadBytes([both(1_000, 1_000), both(2_000, 2_000)])).toBe(0);
  });

  it('sums Mega-only target sizes', () => {
    expect(neededDownloadBytes([megaOnly(1_000), megaOnly(2_500)])).toBe(3_500);
  });

  it('ignores Mega-and-local targets — they are not re-downloaded', () => {
    expect(neededDownloadBytes([megaOnly(1_000), both(99, 5_000), localOnly(99)])).toBe(1_000);
  });
});

// ── computeSpaceMode ───────────────────────────────────────────────────────────

describe('computeSpaceMode', () => {
  it('returns proceed when nothing needs to be downloaded', () => {
    expect(computeSpaceMode(0, 0)).toBe('proceed');
    expect(computeSpaceMode(0, 1_000_000_000)).toBe('proceed');
  });

  it('rejects when ratio is below 1', () => {
    expect(computeSpaceMode(1_000, 500)).toBe('reject');
    expect(computeSpaceMode(1_000, 999)).toBe('reject');
  });

  it('offers download-only when ratio is in [1, 2)', () => {
    expect(computeSpaceMode(1_000, 1_000)).toBe('download-only-offer');
    expect(computeSpaceMode(1_000, 1_500)).toBe('download-only-offer');
    expect(computeSpaceMode(1_000, 1_999)).toBe('download-only-offer');
  });

  it('warns when ratio is in [2, 3)', () => {
    expect(computeSpaceMode(1_000, 2_000)).toBe('warn-then-proceed');
    expect(computeSpaceMode(1_000, 2_500)).toBe('warn-then-proceed');
    expect(computeSpaceMode(1_000, 2_999)).toBe('warn-then-proceed');
  });

  it('proceeds silently when ratio is 3 or more', () => {
    expect(computeSpaceMode(1_000, 3_000)).toBe('proceed');
    expect(computeSpaceMode(1_000, 10_000)).toBe('proceed');
  });
});
