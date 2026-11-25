import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { LastSurvey, SAID_MS, teller, tookEffect } from '../web/views/Surveys';
import { Table, Waiting } from '../web/views/Table';
import type { Said } from '../web/views/Surveys';
import type { LastRun, Order, Status } from '../web/types';

/** The surveys page's own reads: when an order is done, what it says, and what a reader is told. */

const markup = (node: ReactNode): string => renderToStaticMarkup(createElement(MantineProvider, null, node));

const run = (over: Partial<LastRun> = {}): LastRun => ({
  kind: 'update', at: '2026-11-24T00:10:00.000Z', startedAt: '2026-11-24T00:00:00.000Z',
  ongoing: false, first: false, previous: null, ...over,
});

const status = (over: Partial<Status> = {}): Status => ({
  venue: 'binance', firstMonth: null, lastMonth: null, files: 0, series: { withFiles: 0, total: 0 },
  bytes: 0, pending: 0, pendingBytes: 0, withdrawn: 0,
  state: 'waiting', established: null, lastRun: run(), enrolledAt: null, since: null, during: null,
  nextRun: null, surveying: true, stopping: false, completedEver: true, probing: false, listable: true, wip: 0,
  ...over,
});

const order = (over: Partial<Order> = {}): Order => ({
  kind: 'go', at: Date.now(), from: 'waiting', fromStartedAt: '2026-11-24T00:00:00.000Z', ...over,
});

describe('tookEffect', () => {
  it('counts a pass begun since the order, even one already finished: waiting to waiting with a new start', () => {
    expect(tookEffect(order(), status({ lastRun: run({ startedAt: '2026-11-25T09:00:00.000Z' }) }))).toBe(true);
  });

  it('does not count the pass that was already the latest when the order was given', () => {
    expect(tookEffect(order(), status())).toBe(false);
  });

  it('does not count a venue that has still never run', () => {
    expect(tookEffect(order({ fromStartedAt: null }), status({ lastRun: run({ startedAt: null }) }))).toBe(false);
  });

  it('answers the same whatever the browser clock reads', () => {
    const begun = status({ lastRun: run({ startedAt: '2026-11-25T09:00:00.000Z' }) });
    const at = Date.parse('2026-11-25T09:00:00.000Z');

    for (const offset of [-60_000, 0, 60_000]) {
      expect(tookEffect(order({ at: at + offset }), begun)).toBe(true);
      expect(tookEffect(order({ at: at + offset }), status())).toBe(false);
    }
  });

  it('counts a venue already going', () => {
    expect(tookEffect(order(), status({ state: 'starting' }))).toBe(true);
    expect(tookEffect(order(), status({ state: 'updating' }))).toBe(true);
  });

  it('counts a pause once the venue is paused, and nothing else', () => {
    expect(tookEffect(order({ kind: 'pause' }), status({ state: 'paused' }))).toBe(true);
    expect(tookEffect(order({ kind: 'pause' }), status({ state: 'updating' }))).toBe(false);
  });

  it('counts a pause lifted once the venue has left paused, though nothing starts', () => {
    expect(tookEffect(order({ from: 'paused' }), status({ state: 'waiting' }))).toBe(true);
    expect(tookEffect(order({ from: 'paused' }), status({ state: 'paused' }))).toBe(false);
  });
});

describe('teller', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const listening = () => {
    let now: Said | null = null;
    const tell = teller(said => { now = said; });

    return { tell, now: () => now };
  };

  it('lets an acknowledgement fade', () => {
    const { tell, now } = listening();

    tell.say('Every venue — asked');
    expect(now()).toEqual({ text: 'Every venue — asked', sticks: false });

    vi.advanceTimersByTime(SAID_MS);
    expect(now()).toBeNull();
  });

  it('keeps a failure past the time an acknowledgement fades, until it is dismissed', () => {
    const { tell, now } = listening();

    tell.fail('502 — catalog unreachable');
    vi.advanceTimersByTime(SAID_MS * 10);
    expect(now()).toEqual({ text: '502 — catalog unreachable', sticks: true });

    tell.clear();
    expect(now()).toBeNull();
  });

  it('does not let an earlier acknowledgement fade a failure said after it', () => {
    const { tell, now } = listening();

    tell.say('Pause — asked');
    vi.advanceTimersByTime(SAID_MS / 2);
    tell.fail('No sign of binance acting on it');
    vi.advanceTimersByTime(SAID_MS);

    expect(now()?.text).toBe('No sign of binance acting on it');
  });
});

describe('Waiting', () => {
  it('says it is loading, to a screen reader as well', () => {
    const html = markup(createElement(Waiting<number>, { asked: { loading: true }, children: () => null }));

    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-label="Loading"/);
  });
});

describe('Table', () => {
  it('names a column whose heading is hidden, for whoever cannot see the cells', () => {
    const html = markup(createElement(Table<{ n: number }>, {
      caption: 'Rows', rows: [{ n: 1 }],
      columns: [{ head: 'N', cell: r => r.n }, { head: 'Actions', hideHead: true, cell: () => 'x' }],
    }));

    expect(html).toMatch(/<th[^>]*>N<\/th>/);
    expect(html).toMatch(/<th[^>]*><span[^>]*VisuallyHidden[^>]*>Actions<\/span><\/th>/);
  });
});

describe('LastSurvey', () => {
  it('names a first pass a backfill and every later one an update', () => {
    expect(markup(createElement(LastSurvey, { of: run({ first: true }) }))).toContain('Backfilled 2026-11-24');
    expect(markup(createElement(LastSurvey, { of: run({ first: false }) }))).toContain('Updated 2026-11-24');
    expect(markup(createElement(LastSurvey, { of: run({ first: true, ongoing: true, at: null }) })))
      .toContain('Backfill in progress');
  });
});
