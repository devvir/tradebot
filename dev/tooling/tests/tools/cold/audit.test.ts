import { describe, expect, it } from 'vitest';
import {
  _test_againstMega as againstMega,
  _test_between as between,
  _test_gaps as gaps,
  _test_backedMonths as backedMonths,
  _test_monthBytes as monthBytes,
  _test_orphans as orphans,
} from '../../../src/tools/cold/audit';
import { tarSize } from '../../../src/tools/cold/tar';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, PartRow } from '../../../src/tools/cold/types';

/**
 * A checker that only ever reports "fine" is worthless, so these break things
 * on purpose and insist it notices.
 */
const part = (over: Partial<PartRow> = {}): PartRow => ({
  id: 1, origin: 'vault', venue: 'gate', month: '201901', seq: 1,
  name: '201901.p01.tar',
  remote: 'gate/2019/201901.p01.tar',
  local: 'gate/201901.p01.tar',
  bytes: 100, files: 1, uploadedAt: '2026-08-11T00:00:00Z', handle: 'H:aaa', ...over,
});

const members = [{ path: 'a.parquet', bytes: 1_000, mtime: 1 }];

/** Stands in for the database, answering only what `againstMega` asks it. */
const withMembers = (rows: { path: string; bytes: number; mtime: number }[]) =>
  ({ prepare: () => ({ all: () => rows }) }) as unknown as DatabaseSync;

const mega = (over: Record<string, { bytes: number; handle: string | null }>) => new Map(Object.entries(over));

/**
 * The remote root is the deployment's, not the part's. Only the resolved
 * `detail` of a finding depends on it, which is the point: move the account and
 * every stored path still says where its own object lives.
 */
const config = { megaRoot: '/mega/vault', coldRoot: '/cold' } as ColdConfig;

describe('a part the record calls backed up', () => {
  const db = withMembers(members);
  const right = tarSize(members);

  it('passes when Mega holds exactly what its members imply', () => {
    expect(againstMega(db, config, [part()], mega({
      'gate/2019/201901.p01.tar': { bytes: right, handle: 'H:aaa' },
    }))).toEqual([]);
  });

  it('is a problem when Mega holds nothing', () => {
    const found = againstMega(db, config, [part()], mega({}));

    expect(found[0]).toMatchObject({ severity: 'problem', kind: 'missing from Mega' });
  });

  /** The size is computed from the members, so this proves the object is not theirs. */
  it('is a problem when the size disagrees with the member list', () => {
    const found = againstMega(db, config, [part()], mega({
      'gate/2019/201901.p01.tar': { bytes: right + 10_240, handle: 'H:aaa' },
    }));

    expect(found[0]).toMatchObject({ severity: 'problem', kind: 'size disagrees' });
  });

  /** Same size, different object — only the handle can tell. */
  it('is a problem when the object was replaced behind our back', () => {
    const found = againstMega(db, config, [part()], mega({
      'gate/2019/201901.p01.tar': { bytes: right, handle: 'H:zzz' },
    }));

    expect(found[0]).toMatchObject({ severity: 'problem', kind: 'object replaced' });
  });

  /** A part not yet uploaded is a backlog, not a fault. */
  it('says nothing about a part that was never uploaded', () => {
    expect(againstMega(db, config, [part({ uploadedAt: null })], mega({}))).toEqual([]);
  });
});

describe('objects nothing describes', () => {
  /** No ghosts recorded, so an undescribed object is genuinely unexplained. */
  const noGhosts = ({ prepare: () => ({ all: () => [] }) }) as unknown as DatabaseSync;

  it('names a tar in Mega with no part row', () => {
    const found = orphans(noGhosts, 'vault', [part()], mega({
      'gate/2019/201901.p01.tar': { bytes: 1, handle: null },
      'gate/2019/201902.p09.tar': { bytes: 2, handle: null },
    }));

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'problem', kind: 'nothing describes it' });
  });

  /**
   * A replan drops the rows of the parts it supersedes, so its orphans have no
   * part row *by design* — and are already recorded for removal. Reporting them
   * as problems buries the objects that really are unexplained.
   */
  it('softens one a replan orphaned on purpose', () => {
    const ghost = ({ prepare: () => ({
      all: () => [{ remote: 'gate/2019/201902.p09.tar' }],
    }) }) as unknown as DatabaseSync;

    const found = orphans(ghost, 'vault', [part()], mega({
      'gate/2019/201901.p01.tar': { bytes: 1, handle: null },
      'gate/2019/201902.p09.tar': { bytes: 2, handle: null },
    }));

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'check', kind: 'awaiting removal' });
  });
});

describe('holes in a venue range', () => {
  it('notices a month missing from the middle', () => {
    const found = gaps([
      part({ month: '201901' }), part({ month: '201902' }), part({ month: '201904' }),
    ]);

    expect(found[0]?.detail).toContain('201903');
  });

  it('says nothing about a continuous run', () => {
    expect(gaps([part({ month: '201901' }), part({ month: '201902' })])).toEqual([]);
  });

  /** Unsent months are not holes — they have not been tried yet. */
  it('ignores parts that are not in Mega', () => {
    expect(gaps([
      part({ month: '201901' }), part({ month: '201903', uploadedAt: null }),
    ])).toEqual([]);
  });

  it('walks months across a year boundary', () => {
    expect(between('202411', '202502')).toEqual(['202411', '202412', '202501', '202502']);
  });
});

/**
 * What the alignment section counts: a venue-month is backed up only when every
 * part of it is in Mega. A restore needs all of them, so a month with one part
 * still to send has none of the safety the count would be claiming — and since
 * eviction reads that count to decide what may go, an optimistic month is the
 * one mistake this must not make.
 */
describe('months a venue has fully in cold storage', () => {
  const rows = (parts: { venue: string; month: string; uploadedAt: string | null }[]) =>
    ({ prepare: () => ({ all: () => parts }) }) as unknown as DatabaseSync;

  it('counts a month whose every part is uploaded', () => {
    const found = backedMonths(rows([
      { venue: 'gate', month: '201901', uploadedAt: 'x' },
      { venue: 'gate', month: '201901', uploadedAt: 'x' },
    ]), 'vault');

    expect([...found.get('gate')!]).toEqual(['201901']);
  });

  it('drops a month with any part still to send', () => {
    const found = backedMonths(rows([
      { venue: 'gate', month: '201901', uploadedAt: 'x' },
      { venue: 'gate', month: '201901', uploadedAt: null },
    ]), 'vault');

    expect(found.get('gate')?.size ?? 0).toBe(0);
  });

  /** Order must not decide it — the unsent part may be read after the sent one. */
  it('drops it whichever way round the parts arrive', () => {
    const found = backedMonths(rows([
      { venue: 'gate', month: '201901', uploadedAt: null },
      { venue: 'gate', month: '201901', uploadedAt: 'x' },
    ]), 'vault');

    expect(found.get('gate')?.size ?? 0).toBe(0);
  });

  it('keeps a venue’s other months when one is incomplete', () => {
    const found = backedMonths(rows([
      { venue: 'gate', month: '201901', uploadedAt: 'x' },
      { venue: 'gate', month: '201902', uploadedAt: null },
    ]), 'vault');

    expect([...found.get('gate')!]).toEqual(['201901']);
  });
});

/**
 * Sizing those months. Raw is what eviction frees, so the figure beside every
 * count is the source's own bytes — planned or sent, since the question is how
 * much disk the month occupies rather than how much of it is backed up.
 */
describe('how much raw a venue-month is', () => {
  const rows = (parts: { venue: string; month: string; bytes: number }[]) =>
    ({ prepare: () => ({ all: () => parts }) }) as unknown as DatabaseSync;

  it('sums every part of the month', () => {
    const size = monthBytes(rows([
      { venue: 'gate', month: '201901', bytes: 100 },
      { venue: 'gate', month: '201901', bytes: 50 },
      { venue: 'gate', month: '201902', bytes: 7 },
    ]), 'archives');

    expect(size.get('gate/201901')).toBe(150);
    expect(size.get('gate/201902')).toBe(7);
  });

  /**
   * The distinction the table turns into "unplanned": a month nothing describes
   * is absent, not zero. Binance had 58 of them against 297GB on disk, and `0B`
   * would have read as nothing to gain.
   */
  it('has no entry for a month no part describes', () => {
    const size = monthBytes(rows([{ venue: 'gate', month: '201901', bytes: 100 }]), 'archives');

    expect(size.has('binance/201901')).toBe(false);
  });
});
