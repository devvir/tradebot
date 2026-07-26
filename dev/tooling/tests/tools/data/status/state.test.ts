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
    megaSources:       [],
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

const UNSOURCED = false;
const SOURCED   = true;
const BUCKET    = true;
const SOURCES   = true;
const NONE      = false;

describe('megaState', () => {
  // ── unsourced (bucket is the only artifact) ──────────────────────────────────

  it('unsourced + bucket → stored', () => {
    expect(megaState(BUCKET, NONE, UNSOURCED, 'past')).toEqual({ kind: 'stored' });
  });

  it('unsourced + no bucket + past day → missing', () => {
    expect(megaState(NONE, NONE, UNSOURCED, 'past')).toEqual({ kind: 'missing' });
  });

  it('unsourced + no bucket + today → absent', () => {
    expect(megaState(NONE, NONE, UNSOURCED, 'today')).toEqual({ kind: 'absent' });
  });

  it('unsourced + no bucket + pending → absent (mega not expected yet)', () => {
    expect(megaState(NONE, NONE, UNSOURCED, 'pending')).toEqual({ kind: 'absent' });
  });

  it('unsourced ignores sources (bucket is the only artifact)', () => {
    expect(megaState(NONE, SOURCES, UNSOURCED, 'past')).toEqual({ kind: 'missing' });
  });

  // ── sourced (both bucket and sources expected) ───────────────────────────────

  it('sourced + bucket + sources → stored', () => {
    expect(megaState(BUCKET, SOURCES, SOURCED, 'past')).toEqual({ kind: 'stored' });
  });

  it('sourced + neither + past day → missing', () => {
    expect(megaState(NONE, NONE, SOURCED, 'past')).toEqual({ kind: 'missing' });
  });

  it('sourced + neither + today → absent', () => {
    expect(megaState(NONE, NONE, SOURCED, 'today')).toEqual({ kind: 'absent' });
  });

  it('sourced + neither + pending → absent (mega not expected yet)', () => {
    expect(megaState(NONE, NONE, SOURCED, 'pending')).toEqual({ kind: 'absent' });
  });

  it('sourced + bucket only → half: bucket stored, sources missing', () => {
    expect(megaState(BUCKET, NONE, SOURCED, 'past')).toEqual({
      kind: 'half', bucket: 'stored', sources: 'missing',
    });
  });

  it('sourced + sources only → half: bucket missing, sources stored (trade/quote 2014-2017)', () => {
    expect(megaState(NONE, SOURCES, SOURCED, 'past')).toEqual({
      kind: 'half', bucket: 'missing', sources: 'stored',
    });
  });
});

