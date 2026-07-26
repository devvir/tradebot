import { describe, it, expect, beforeEach } from 'vitest';
import {
  admit,
  release,
  initStaging,
  stagedBytes,
  _test_reset as reset,
} from '../../src/write/staging';

const flush = () => new Promise<void>(r => setImmediate(r));

beforeEach(() => reset());

// ── Admit increases the staged byte total ─────────────────────────────────────

describe('staging — admit', () => {
  it('adds the admitted bytes to the staged total', async () => {
    initStaging(10);

    await admit(1);
    expect(stagedBytes()).toBe(1);

    await admit(3);
    expect(stagedBytes()).toBe(4);
  });

  it('returns immediately when below cap', async () => {
    initStaging(10);

    const start = Date.now();
    await admit(5);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

// ── Admit blocks at the cap ───────────────────────────────────────────────────

describe('staging — admit blocks when cap is reached', () => {
  it('an admit that would exceed cap waits until release', async () => {
    initStaging(2);

    await admit(2);
    expect(stagedBytes()).toBe(2);

    let settled = false;

    void admit(1).then(() => { settled = true; });

    await flush();
    expect(settled).toBe(false);
    expect(stagedBytes()).toBe(2);

    release(1);
    await flush();

    expect(settled).toBe(true);
    expect(stagedBytes()).toBe(2);
  });

  it('a multi-byte admit blocks if it would exceed cap', async () => {
    initStaging(4);

    await admit(3);

    let settled = false;

    void admit(3).then(() => { settled = true; });

    await flush();
    expect(settled).toBe(false);

    release(1);
    await flush();

    /** staged is now 2; 2 + 3 = 5 still > cap (4) — stays blocked. */
    expect(settled).toBe(false);

    release(1);
    await flush();

    /** staged is now 1; 1 + 3 = 4 NOT > cap — admit succeeds. */
    expect(settled).toBe(true);
  });

  it('all queued waiters get a chance when a release arrives', async () => {
    initStaging(3);

    await admit(3);

    const results: string[] = [];

    void admit(1).then(() => results.push('a'));
    void admit(1).then(() => results.push('b'));
    void admit(1).then(() => results.push('c'));

    await flush();
    expect(results).toEqual([]);

    release(2);
    /** Two flush ticks: first wakes all waiters, second lets them retry. */
    await flush();
    await flush();

    /** Two should fit (staged went 1 → 2 → 3 after two admits); the third
     *  has to wait again because 3 + 1 > 3. */
    expect(results.length).toBe(2);

    release(2);
    await flush();
    await flush();

    expect(results.length).toBe(3);
  });
});

// ── Release ───────────────────────────────────────────────────────────────────

describe('staging — release', () => {
  it('subtracts the released bytes from the staged total', async () => {
    initStaging(10);

    await admit(5);
    release(2);
    expect(stagedBytes()).toBe(3);
  });

  it('clamps to zero rather than going negative', async () => {
    initStaging(10);

    await admit(1);
    release(5);

    expect(stagedBytes()).toBe(0);
  });
});

// ── Reinitialization ──────────────────────────────────────────────────────────

describe('staging — initStaging resets the cap', () => {
  it('changes the active cap', async () => {
    initStaging(2);
    await admit(2);

    initStaging(10);
    /** Existing staged stays as is; new cap applies to future admits. */
    expect(stagedBytes()).toBe(2);

    await admit(5);
    expect(stagedBytes()).toBe(7);
  });
});
