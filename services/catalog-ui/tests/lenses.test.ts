import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addressIsSound, byPeriod, choiceOf, chosenOf, filed, forget, isUnsaved, keep, keptFor, namedLens, onlyOf, publishedOptions, unsavedLens, withOne, withoutVenue,
} from '../web/views/Lenses';
import type { LensProblem, LensRule, RuleEntry } from '../web/types';

/** The lens page's own reads: what the venues publish, and the unsaved lens a browser kept. */

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('publishedOptions', () => {
  /** Each test starts well clear of any reading an earlier one left behind. */
  let clock = Date.now();

  beforeEach(() => {
    vi.useFakeTimers();
    clock += 10 * 60_000;
    vi.setSystemTime(clock);
  });

  it('forgets a failed reading, so the next caller asks again; a good one is shared', async () => {
    const calls: string[] = [];
    let answer: () => Response = () => new Response('{"error":"down"}', { status: 502 });

    vi.stubGlobal('fetch', async (url: string) => { calls.push(url); return answer(); });

    await expect(publishedOptions()).rejects.toThrow('502 — down');

    const option = { venue: 'binance', market: 'spot', dataset: 'klines', variant: '1m' };

    answer = () => new Response(JSON.stringify({ items: [option] }), { status: 200 });

    expect(await publishedOptions()).toEqual([option]);
    expect(await publishedOptions()).toEqual([option]);
    expect(calls).toEqual(['/api/catalog/lenses/options', '/api/catalog/lenses/options']);
  });

  it('asks again once a reading is a minute old', async () => {
    let calls = 0;

    vi.stubGlobal('fetch', async () => { calls += 1; return new Response('{"items":[]}', { status: 200 }); });

    await publishedOptions();
    vi.setSystemTime(Date.now() + 30_000);
    await publishedOptions();
    expect(calls).toBe(1);

    vi.setSystemTime(Date.now() + 31_000);
    await publishedOptions();
    expect(calls).toBe(2);
  });
});

describe('unsavedLens', () => {
  const holding = (value: string | null): void => {
    vi.stubGlobal('localStorage', { getItem: () => value });
  };

  it('is none for something kept that is not shaped like a lens', () => {
    holding('{"foo":1}');
    expect(unsavedLens()).toBeNull();

    holding('{"slug":"x","definition":{"format":1}}');
    expect(unsavedLens()).toBeNull();

    holding('{"slug":"x","definition":{"venues":null}}');
    expect(unsavedLens()).toBeNull();

    holding('{"slug":3,"definition":{"venues":{}}}');
    expect(unsavedLens()).toBeNull();

    holding('not json');
    expect(unsavedLens()).toBeNull();
  });

  it('is none where nothing is kept', () => {
    holding(null);
    expect(unsavedLens()).toBeNull();
  });

  it('is the kept lens where it has an address and rules by venue', () => {
    const lens = { slug: 'cold', name: '', note: '', definition: { format: 1, venues: {} } };

    holding(JSON.stringify(lens));
    expect(unsavedLens()).toEqual(lens);
  });
});

describe('addressIsSound', () => {
  it('refuses what the catalog would not store a lens under', () => {
    for (const bad of ['cold_store', 'cold store', '-x', 'a', 'Cold', '', 'a'.repeat(65)])
      expect(addressIsSound(bad), bad).toBe(false);
  });

  it('takes lower case, digits and hyphens, 2 to 64 characters', () => {
    for (const good of ['cold-store', 'ab', '1m-klines', 'a-', 'a'.repeat(64)])
      expect(addressIsSound(good), good).toBe(true);
  });
});

describe('filing what the catalog refused', () => {
  const include: LensRule = { effect: 'include' };
  const bad:     LensRule = { effect: 'include', grain: { only: 'weekly' as never } };

  const saved = (key: string, rule: LensRule = include): RuleEntry => ({ key, saved: rule, now: rule });

  /** Venue a has one stored rule; venue b two, the second of them one the catalog now refuses. */
  const rules = {
    a: [saved('a0')],
    b: [saved('b0'), saved('b1', bad)],
  };

  const atB1: LensProblem = { venue: 'b', rule: 1, field: 'grain', message: 'Not a grain.' };

  it('files a problem on the rule it names, not on the one being confirmed', () => {
    const draft: RuleEntry = { key: 'a1', now: { effect: 'exclude' } };
    const sending = withOne({ ...rules, a: [...rules.a, draft] }, 'a', draft);

    expect(sending.definition.venues).toEqual({ a: [include, { effect: 'exclude' }], b: [include, bad] });

    const { byKey, general } = filed([atB1], sending.sent);

    expect(byKey).toEqual({ b1: [atB1] });
    expect(general).toEqual([]);
  });

  it('counts only the rules sent: a draft left out moves no one along', () => {
    const draft: RuleEntry = { key: 'b-new', now: include };
    const other: RuleEntry = { key: 'b-other', now: include };
    const sending = withOne({ ...rules, b: [saved('b0'), other, saved('b1', bad), draft] }, 'b', draft);

    expect(sending.sent.b).toEqual(['b0', 'b1', 'b-new']);
    expect(filed([atB1], sending.sent).byKey).toEqual({ b1: [atB1] });
  });

  it('surfaces a refused Clear: rule problems on their rules, the rest as the lens\'s', () => {
    const sending = withoutVenue(rules, 'a');
    const lensWide: LensProblem = { venue: 'c', rule: -1, message: "No venue called 'c'." };
    const unsent:   LensProblem = { venue: 'a', rule: 0, message: 'Not sent.' };

    expect(sending.definition.venues).toEqual({ b: [include, bad] });

    const { byKey, general } = filed([atB1, lensWide, unsent], sending.sent);

    expect(byKey).toEqual({ b1: [atB1] });
    expect(general).toEqual([lensWide, unsent]);
  });

  it('leaves a dropped rule out, and the rest at their places', () => {
    const sending = withOne(rules, 'b', rules.b[0]!, true);

    expect(sending.definition.venues).toEqual({ a: [include], b: [bad] });
    expect(filed([{ ...atB1, rule: 0 }], sending.sent).byKey).toEqual({ b1: [{ ...atB1, rule: 0 }] });
  });
});

describe('what a browser keeps of a lens', () => {
  let held: Map<string, string>;

  beforeEach(() => {
    held = new Map();
    vi.stubGlobal('localStorage', {
      getItem:    (key: string) => held.get(key) ?? null,
      setItem:    (key: string, value: string) => { held.set(key, value); },
      removeItem: (key: string) => { held.delete(key); },
    });
  });

  const draftOf = (lens: { updatedAt: string }) => ({
    name: 'Old', note: 'old note', rules: { binance: [{ key: 'r', now: { effect: 'include' as const } }] }, from: lens.updatedAt,
  });

  it('marks a new lens as not saved, apart from one the catalog stored', () => {
    expect(isUnsaved(namedLens('cold', 'Cold', ''))).toBe(true);
    expect(isUnsaved({ ...namedLens('cold', 'Cold', ''), id: 3, updatedAt: '2026-11-25T10:00:00Z' })).toBe(false);
  });

  it('does not revive a deleted lens\'s draft on a new lens at the same address', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const first = namedLens('cold', 'Cold', '');

    keep(first, draftOf(first));
    expect(keptFor(first)?.name).toBe('Old');

    forget(first);
    vi.setSystemTime(2_000);

    const again = namedLens('cold', 'Cold again', '');

    expect(keptFor(again)).toBeNull();
  });

  it('takes no draft of an earlier lens at the address as a new one\'s, even where it was never forgotten', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const first = namedLens('cold', 'Cold', '');

    keep(first, draftOf(first));
    vi.setSystemTime(2_000);

    expect(keptFor(namedLens('cold', 'Cold again', ''))).toBeNull();
  });

  it('forgets a deleted lens\'s draft and its last known size', () => {
    const lens = { ...namedLens('cold', 'Cold', ''), id: 1, updatedAt: '2026-11-25T10:00:00Z' };

    keep(lens, draftOf(lens));
    held.set('catalog-ui:lens-size:cold', '{}');
    held.set('catalog-ui:lens-size:warm', '{}');

    forget(lens);

    expect([...held.keys()]).toEqual(['catalog-ui:lens-size:warm']);
  });

  it('carries on where the browser refuses storage', () => {
    vi.stubGlobal('localStorage', { removeItem: () => { throw new Error('refused'); } });

    expect(() => forget(namedLens('cold', 'Cold', ''))).not.toThrow();
  });
});

describe('a grain or bundle choice, as a select holds it', () => {
  it.each([
    [undefined,                  'any'],
    [{ only: 'daily' },          'only:daily'],
    [{ prefer: 'instrument' },   'prefer:instrument'],
  ] as const)('writes %j as %j and reads it back', (choice, value) => {
    expect(chosenOf(choice)).toBe(value);
    expect(choiceOf(value)).toEqual(choice);
  });

  it('reads a cleared select as any', () => {
    expect(choiceOf(null)).toBeUndefined();
    expect(choiceOf('')).toBeUndefined();
  });

  it('keeps a choice of one form alone, and drops one that only prefers', () => {
    expect(onlyOf({ only: 'daily' })).toEqual({ only: 'daily' });
    expect(onlyOf({ prefer: 'daily' })).toBeUndefined();
    expect(onlyOf(undefined)).toBeUndefined();
  });
});

describe('byPeriod', () => {
  it('orders periods by how long they are, not as text', () => {
    expect(['1d', '10s', '1mo', '12h', '1m', '15m', '1w', '1h', '1y'].sort(byPeriod))
      .toEqual(['10s', '1m', '15m', '1h', '12h', '1d', '1w', '1mo', '1y']);
  });

  it('puts periods ahead of anything else, and orders the rest by the alphabet', () => {
    expect(['full', '400', '1h', 'incremental,500', '1m'].sort(byPeriod))
      .toEqual(['1m', '1h', '400', 'full', 'incremental,500']);
  });
});
