import { describe, it, expect } from 'vitest';
import { localState, remoteState, megaState } from '../../../../src/tools/data/status/state';
import type { DayState } from '../../../../src/tools/data/scan/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function ds(opts: Partial<DayState> = {}): DayState {
  return {
    day:               '20260101',
    localSuffixes:     [],
    localTmpSuffixes:  [],
    remoteSuffixes:    {},
    remoteTmpSuffixes: {},
    localBucket:       false,
    localBucketTmp:    false,
    megaBucket:        false,
    ...opts,
  };
}

// ── localState ────────────────────────────────────────────────────────────────

describe('localState', () => {
  it('undefined ds → absent (non-WS, past)', () => {
    expect(localState(undefined, 'past', false)).toEqual({ kind: 'absent' });
  });

  it('undefined ds, today, WS → missing', () => {
    expect(localState(undefined, 'today', true)).toEqual({ kind: 'missing' });
  });

  it('undefined ds, today, REST → absent', () => {
    expect(localState(undefined, 'today', false)).toEqual({ kind: 'absent' });
  });

  it('.tmp today + WS → progress', () => {
    expect(localState(ds({ localTmpSuffixes: ['.local'] }), 'today', true)).toEqual({ kind: 'progress' });
  });

  it('.tmp today + REST → progress', () => {
    expect(localState(ds({ localBucketTmp: true }), 'today', false)).toEqual({ kind: 'progress' });
  });

  it('.tmp pending (yesterday in grace window) + WS → pending', () => {
    expect(localState(ds({ localTmpSuffixes: ['.local'] }), 'pending', true)).toEqual({ kind: 'pending' });
  });

  it('.tmp pending + REST → progress (REST never stalls)', () => {
    expect(localState(ds({ localBucketTmp: true }), 'pending', false)).toEqual({ kind: 'progress' });
  });

  it('.tmp past + WS → incomplete (stalled)', () => {
    expect(localState(ds({ localTmpSuffixes: ['.local'] }), 'past', true)).toEqual({ kind: 'incomplete' });
  });

  it('.tmp past + REST → progress (REST backfills historical, not stalled)', () => {
    expect(localState(ds({ localBucketTmp: true }), 'past', false)).toEqual({ kind: 'progress' });
  });

  it('bucket + sources → mixed', () => {
    expect(localState(ds({ localBucket: true, localSuffixes: ['.local'] }), 'past', true)).toEqual({ kind: 'mixed' });
  });

  it('bucket only → buckets', () => {
    expect(localState(ds({ localBucket: true }), 'past', false)).toEqual({ kind: 'buckets' });
  });

  it('sources only → sources', () => {
    expect(localState(ds({ localSuffixes: ['.local'] }), 'past', true)).toEqual({ kind: 'sources' });
  });
});

// ── remoteState ───────────────────────────────────────────────────────────────

describe('remoteState', () => {
  it('undefined ds → absent', () => {
    expect(remoteState(undefined, 'antel', 'past', true)).toEqual({ kind: 'absent' });
  });

  it('undefined ds, today, WS → missing', () => {
    expect(remoteState(undefined, 'antel', 'today', true)).toEqual({ kind: 'missing' });
  });

  it('undefined ds, today, REST → absent', () => {
    expect(remoteState(undefined, 'antel', 'today', false)).toEqual({ kind: 'absent' });
  });

  it('.tmp today → progress', () => {
    expect(remoteState(ds({ remoteTmpSuffixes: { antel: ['.antel'] } }), 'antel', 'today', true)).toEqual({ kind: 'progress' });
  });

  it('.tmp pending → pending', () => {
    expect(remoteState(ds({ remoteTmpSuffixes: { antel: ['.antel'] } }), 'antel', 'pending', true)).toEqual({ kind: 'pending' });
  });

  it('.tmp past → incomplete', () => {
    expect(remoteState(ds({ remoteTmpSuffixes: { antel: ['.antel'] } }), 'antel', 'past', true)).toEqual({ kind: 'incomplete' });
  });

  it('sources present → sources', () => {
    expect(remoteState(ds({ remoteSuffixes: { antel: ['.antel'] } }), 'antel', 'past', true)).toEqual({ kind: 'sources' });
  });

  it('sources for different remote → absent for queried remote', () => {
    expect(remoteState(ds({ remoteSuffixes: { other: ['.other'] } }), 'antel', 'past', true)).toEqual({ kind: 'absent' });
  });
});

// ── megaState ─────────────────────────────────────────────────────────────────

const BUCKET = true;
const NONE   = false;

/**
 * The bucket is the only artifact a day is expected to have in Mega.
 *
 * A second root once held the raw sources a bucket was built from, and a table
 * with a preparation stage needed both to read `stored` — either alone rendered
 * as a split cell. Source backup was retired with BitMEX collection, so the
 * question is no longer which half is present, and `sourced` no longer changes
 * the answer.
 */
describe('megaState', () => {
  it('bucket present → stored', () => {
    expect(megaState(BUCKET, 'past')).toEqual({ kind: 'stored' });
  });

  it('no bucket + past day → missing', () => {
    expect(megaState(NONE, 'past')).toEqual({ kind: 'missing' });
  });

  /** Still in flight: absence is expected, not a gap. */
  it('no bucket + today → absent', () => {
    expect(megaState(NONE, 'today')).toEqual({ kind: 'absent' });
  });

  it('no bucket + pending → absent (mega not expected yet)', () => {
    expect(megaState(NONE, 'pending')).toEqual({ kind: 'absent' });
  });

  /** A prepared table is judged by the same rule as any other. */
  it('answers the same for a table that has a preparation stage', () => {
    expect(megaState(BUCKET, 'past')).toEqual({ kind: 'stored' });
    expect(megaState(NONE,   'past')).toEqual({ kind: 'missing' });
  });
});
