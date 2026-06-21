import { describe, it, expect } from 'vitest';
import { databaseState, localState, remoteState, megaState } from '../../../../src/tools/data/status/state';
import type { DayState } from '../../../../src/tools/data/scan/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function ds(opts: Partial<DayState> = {}): DayState {
  return {
    day:               '20260101',
    localSuffixes:     [],
    localTmpSuffixes:  [],
    remoteSuffixes:    {},
    remoteTmpSuffixes: {},
    megaSources:       [],
    localBucket:       false,
    localBucketTmp:    false,
    megaBucket:        false,
    database:          'absent',
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

describe('megaState', () => {
  it('hasTar → stored regardless of other state', () => {
    expect(megaState(undefined, 'rest', 'today', true)).toEqual({ kind: 'stored' });
    expect(megaState(undefined, 'ws',   'today', true)).toEqual({ kind: 'stored' });
  });

  it('REST + hasBucket → stored', () => {
    expect(megaState(ds({ megaBucket: true }), 'rest', 'past', false)).toEqual({ kind: 'stored' });
  });

  it('REST + no bucket + past day → missing', () => {
    expect(megaState(ds(), 'rest', 'past', false)).toEqual({ kind: 'missing' });
  });

  it('REST + no bucket + today → absent', () => {
    expect(megaState(ds(), 'rest', 'today', false)).toEqual({ kind: 'absent' });
  });

  it('REST + no bucket + pending → absent (mega not expected yet)', () => {
    expect(megaState(ds(), 'rest', 'pending', false)).toEqual({ kind: 'absent' });
  });

  it('WS + bucket + sources → stored', () => {
    expect(megaState(ds({ megaBucket: true, megaSources: ['.local'] }), 'ws', 'past', false)).toEqual({ kind: 'stored' });
  });

  it('WS + neither + past day → missing', () => {
    expect(megaState(ds(), 'ws', 'past', false)).toEqual({ kind: 'missing' });
  });

  it('WS + neither + today → absent', () => {
    expect(megaState(ds(), 'ws', 'today', false)).toEqual({ kind: 'absent' });
  });

  it('WS + neither + pending → absent (mega not expected yet)', () => {
    expect(megaState(ds(), 'ws', 'pending', false)).toEqual({ kind: 'absent' });
  });

  it('WS + bucket only → half: bucket stored, sources missing', () => {
    expect(megaState(ds({ megaBucket: true }), 'ws', 'past', false)).toEqual({
      kind: 'half', bucket: 'stored', sources: 'missing',
    });
  });

  it('WS + sources only → half: bucket missing, sources stored', () => {
    expect(megaState(ds({ megaSources: ['.local'] }), 'ws', 'past', false)).toEqual({
      kind: 'half', bucket: 'missing', sources: 'stored',
    });
  });
});

// ── databaseState ─────────────────────────────────────────────────────────────

describe('databaseState', () => {
  it('done → imported', () => {
    expect(databaseState(ds({ database: 'done' }), 'past')).toEqual({ kind: 'imported' });
    expect(databaseState(ds({ database: 'done' }), 'today')).toEqual({ kind: 'imported' });
    expect(databaseState(ds({ database: 'done' }), 'pending')).toEqual({ kind: 'imported' });
  });

  it('partial → importing (regardless of dayKind — optimistic)', () => {
    expect(databaseState(ds({ database: 'partial' }), 'past')).toEqual({ kind: 'importing' });
    expect(databaseState(ds({ database: 'partial' }), 'today')).toEqual({ kind: 'importing' });
    expect(databaseState(ds({ database: 'partial' }), 'pending')).toEqual({ kind: 'importing' });
  });

  it('absent + past → missing (farmer should have imported it)', () => {
    expect(databaseState(ds(), 'past')).toEqual({ kind: 'missing' });
  });

  it('absent + today → absent (farmer only works on settled days)', () => {
    expect(databaseState(ds(), 'today')).toEqual({ kind: 'absent' });
  });

  it('absent + pending → absent (not yet expected)', () => {
    expect(databaseState(ds(), 'pending')).toEqual({ kind: 'absent' });
  });

  it('undefined ds + past → missing', () => {
    expect(databaseState(undefined, 'past')).toEqual({ kind: 'missing' });
  });

  it('undefined ds + today → absent', () => {
    expect(databaseState(undefined, 'today')).toEqual({ kind: 'absent' });
  });
});
