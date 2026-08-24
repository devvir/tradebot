import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactManager } from '@tradebot/pipeline';
import { _test_wanted } from '../src/api/routes';
import { _test_identity, _test_keyOf, _test_read, _test_spanOf } from '../src/wanted';
import type { Want } from '../src/types';

/**
 * The shopping list, as the facts database holds it.
 *
 * **One row per dataset of a venue.** A want is a decision somebody made about
 * one thing, so two rows about it would be two answers to one question — which
 * is what the identity has to guarantee, whatever bounds or preferences the row
 * happens to carry.
 */

let dir:   string;
let facts: FactManager;

beforeEach(() => {
  dir   = mkdtempSync(join(tmpdir(), 'wanted-'));
  facts = new FactManager({ owner: 'hauler', root: dir });
});

afterEach(() => {
  facts.close();
  rmSync(dir, { recursive: true, force: true });
});

const want = (over: Partial<Want> = {}): Want =>
  ({ venue: 'gate', market: 'spot', dataset: 'trades', ...over });

/** What `want()` does, minus the module's own config-bound store. */
const add = (of: Want): void => {
  facts.forgetAll(_test_identity(of));

  const held = {
    ...(of.fixed ? { fixed: of.fixed } : {}),
    ...(of.prefer ? { prefer: of.prefer } : {}),
  };

  facts.record({ ..._test_keyOf(of), ...(Object.keys(held).length > 0 ? { meta: held } : {}) });
};

const listed = (): unknown[] => facts.find({ topic: 'archives:scope', fact: 'wanted' });

describe('what identifies a want', () => {
  it('keeps one row however often the same want is stated', () => {
    add(want());
    add(want());

    expect(listed()).toHaveLength(1);
  });

  /**
   * The bounds live in the row rather than in its identity, so restating a want
   * has to clear the old one first — otherwise deciding to go back further would
   * leave the shallower want beside the deeper one.
   */
  it('moves the bounds rather than adding a second want', () => {
    add(want({ from: '202101' }));
    add(want({ from: '202301' }));

    expect(listed()).toHaveLength(1);
    expect(facts.value(_test_keyOf(want({ from: '202301' })))).toBe('');
    expect(facts.value(_test_keyOf(want({ from: '202101' })))).toBeNull();
  });

  /**
   * **Preferences are not part of what a want is.** Changing your mind about
   * which interval you want is the same want, restated — not a second one.
   */
  it('replaces a want when only its requirements change', () => {
    add(want({ dataset: 'klines', prefer: { interval: 'min' } }));
    add(want({ dataset: 'klines', prefer: { interval: 'max' } }));

    expect(listed()).toHaveLength(1);
  });

  it('keeps one venue\'s datasets apart', () => {
    add(want({ dataset: 'klines' }));
    add(want({ dataset: 'trades' }));

    expect(listed()).toHaveLength(2);
  });

  /** Dropping needs to know what the want is, and nothing about how it was stated. */
  it('drops a want whatever bounds or requirements it carried', () => {
    add(want({ from: '202101', prefer: { grain: 'monthly' } }));

    expect(facts.forgetAll(_test_identity(want()))).toBe(1);
    expect(listed()).toHaveLength(0);
  });

  it('says so when there was nothing to drop', () => {
    expect(facts.forgetAll(_test_identity(want()))).toBe(0);
  });
});

/**
 * `period` holds periods here as it does everywhere else — one end, both, or
 * neither — rather than being overloaded into a flag.
 */
describe('the months a want covers', () => {
  it('writes one end, both ends, or nothing', () => {
    expect(_test_spanOf(want())).toBe('');
    expect(_test_spanOf(want({ from: '202101' }))).toBe('202101');
    expect(_test_spanOf(want({ from: '202101', to: '202312' }))).toBe('202101..202312');
    expect(_test_spanOf(want({ to: '202312' }))).toBe('..202312');
  });

  it('reads back what it wrote', () => {
    const row = (of: Want) => _test_read({ ..._test_keyOf(of), meta: undefined } as never);

    expect(row(want({ from: '202101', to: '202312' })))
      .toMatchObject({ from: '202101', to: '202312' });
    expect(row(want({ from: '202101' }))).toMatchObject({ from: '202101' });
    expect(row(want())).not.toHaveProperty('from');
  });
});

/**
 * The requirements are hauler's own language — `{ prefer: { interval: 'min' } }`
 * means nothing to any other service — so they live in `meta`, which is what
 * `meta` is for.
 */
describe('the requirements', () => {
  it('round-trips through meta', () => {
    const of = want({ fixed: { grain: 'monthly' }, prefer: { interval: 'min' } });

    add(of);

    const [held] = facts.find({ topic: 'archives:scope', fact: 'wanted' }, { meta: true });

    expect(_test_read(held as never)).toMatchObject({
      fixed:  { grain: 'monthly' },
      prefer: { interval: 'min' },
    });
  });

  it('leaves a want with no requirements carrying none', () => {
    add(want());

    const [held] = facts.find({ topic: 'archives:scope', fact: 'wanted' }, { meta: true });
    const read   = _test_read(held as never);

    expect(read).not.toHaveProperty('fixed');
    expect(read).not.toHaveProperty('prefer');
  });
});

/**
 * **What we intend to fetch and what we have fetched are one topic tree.**
 * `archives` carries the partitions on disk and `archives:scope` what was asked
 * for, so reading them together is one query and neither filters the other out.
 */
describe('living beside the completions', () => {
  it('does not collide with a completion for the same dataset', () => {
    add(want({ dataset: 'klines' }));

    facts.record({
      topic: 'archives', venue: 'gate', period: '202101', market: 'spot',
      dataset: 'klines', subject: '1m', fact: 'complete', value: 'T1',
    });

    expect(facts.find({ topic: 'archives:scope', fact: 'wanted' })).toHaveLength(1);
    expect(facts.find({ topic: 'archives', fact: 'complete' })).toHaveLength(1);
  });
});

/**
 * Fetching everything a venue publishes, without having to know what that is.
 *
 * **`*` is the absence of a name**, not a name of its own: it becomes the
 * absence of a filter when the catalog is asked, so a venue that starts
 * publishing something new is covered with the list untouched.
 */
describe('a wildcard want', () => {
  const asked = (body: Record<string, unknown>) =>
    _test_wanted({ body, query: {} } as unknown as Parameters<typeof _test_wanted>[0]);

  it('accepts a wildcard market and dataset', () => {
    expect(asked({ venue: 'gate', market: '*', dataset: '*' }))
      .toMatchObject({ venue: 'gate', market: '*', dataset: '*' });
  });

  it('accepts a wildcard on one field and a name on the other', () => {
    expect(asked({ venue: 'gate', market: '*', dataset: 'klines' }))
      .toMatchObject({ market: '*', dataset: 'klines' });
  });

  /**
   * **The one combination refused.** `fixed` and `prefer` are resolved across
   * everything a want selects, so against one dataset they narrow within it and
   * against `*` they narrow *between* datasets — `{ interval: 'min' }` keeps
   * whatever carries the finest bars and drops trades, books and funding
   * entirely, having never mentioned them.
   */
  it('refuses a requirement alongside a wildcard dataset', () => {
    expect(asked({ venue: 'gate', market: '*', dataset: '*', prefer: { interval: 'min' } }))
      .toContain('takes no fixed or prefer');

    expect(asked({ venue: 'gate', market: 'perp', dataset: '*', fixed: { grain: 'monthly' } }))
      .toContain('takes no fixed or prefer');
  });

  /** A named dataset takes requirements as it always did, wildcard market or not. */
  it('keeps requirements where the dataset is named', () => {
    expect(asked({ venue: 'gate', market: '*', dataset: 'klines', prefer: { interval: 'min' } }))
      .toMatchObject({ market: '*', dataset: 'klines', prefer: { interval: 'min' } });
  });

  it('still refuses a market or dataset that is neither canonical nor a wildcard', () => {
    expect(asked({ venue: 'gate', market: 'futures_usdt', dataset: 'klines' }))
      .toContain('market must be canonical');

    expect(asked({ venue: 'gate', market: 'perp', dataset: 'candlesticks_1m' }))
      .toContain('dataset must be canonical');
  });
});
