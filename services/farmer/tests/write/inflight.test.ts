import { describe, it, expect, beforeEach } from 'vitest';
import {
  admit,
  release,
  initInflight,
  inflightSize,
  _test_reset as reset,
} from '../../src/write/inflight';

const flush = () => new Promise<void>(r => setImmediate(r));

beforeEach(() => reset());

// ── Admit increases the counter ───────────────────────────────────────────────

describe('inflight — admit', () => {
  it('increments the in-flight count', async () => {
    initInflight(10);

    await admit(1);
    expect(inflightSize()).toBe(1);

    await admit(3);
    expect(inflightSize()).toBe(4);
  });

  it('defaults count to 1', async () => {
    initInflight(10);

    await admit();
    expect(inflightSize()).toBe(1);
  });

  it('returns immediately when below cap', async () => {
    initInflight(10);

    const start = Date.now();
    await admit(5);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

// ── Admit blocks at the cap ───────────────────────────────────────────────────

describe('inflight — admit blocks when cap is reached', () => {
  it('a push that would exceed cap waits until release', async () => {
    initInflight(2);

    await admit(2);
    expect(inflightSize()).toBe(2);

    let settled = false;

    void admit(1).then(() => { settled = true; });

    await flush();
    expect(settled).toBe(false);
    expect(inflightSize()).toBe(2);

    release(1);
    await flush();

    expect(settled).toBe(true);
    expect(inflightSize()).toBe(2);
  });

  it('multi-item admit blocks if it would exceed cap', async () => {
    initInflight(4);

    await admit(3);

    let settled = false;

    void admit(3).then(() => { settled = true; });

    await flush();
    expect(settled).toBe(false);

    release(1);
    await flush();

    /** current is now 2; 2 + 3 = 5 still > cap (4) — stays blocked. */
    expect(settled).toBe(false);

    release(1);
    await flush();

    /** current is now 1; 1 + 3 = 4 NOT > cap — admit succeeds. */
    expect(settled).toBe(true);
  });

  it('all queued waiters get a chance when a release arrives', async () => {
    initInflight(3);

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

    /** Two should fit (current went 1 → 2 → 3 after two admits); the third
     *  has to wait again because 3 + 1 > 3. */
    expect(results.length).toBe(2);

    release(2);
    await flush();
    await flush();

    expect(results.length).toBe(3);
  });
});

// ── Release ───────────────────────────────────────────────────────────────────

describe('inflight — release', () => {
  it('decrements the in-flight count', async () => {
    initInflight(10);

    await admit(5);
    release(2);
    expect(inflightSize()).toBe(3);
  });

  it('clamps to zero rather than going negative', async () => {
    initInflight(10);

    await admit(1);
    release(5);

    expect(inflightSize()).toBe(0);
  });
});

// ── Reinitialization ──────────────────────────────────────────────────────────

describe('inflight — initInflight resets the cap', () => {
  it('changes the active cap', async () => {
    initInflight(2);
    await admit(2);

    initInflight(10);
    /** Existing in-flight stays as is; new cap applies to future admits. */
    expect(inflightSize()).toBe(2);

    await admit(5);
    expect(inflightSize()).toBe(7);
  });
});
