import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactManager } from '../src/facts';
import type { Topic } from '../src/types';

let root  = '';
let stocker: FactManager;
let trucker: FactManager;

beforeEach(() => {
  root    = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-'));
  stocker = new FactManager({ owner: 'stocker', root });
  trucker = new FactManager({ owner: 'trucker', root });
});

afterEach(() => {
  stocker.close();
  trucker.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('who may write what', () => {
  it('lets an owner state facts about its own tree', () => {
    trucker.record({ topic: 'archives', venue: 'gate', period: '202003', fact: 'complete' });

    expect(trucker.find({ topic: 'archives' })).toHaveLength(1);
  });

  it('refuses a service writing somebody else\'s topic', () => {
    expect(() => stocker.record({
      topic: 'archives', venue: 'gate', period: '202003', fact: 'complete',
    })).toThrow(/belongs to 'trucker'/);
  });

  /**
   * The archives have two collectors while one replaces the other, and they
   * fill the same tree. A list of owners is still an enumeration: everyone not
   * on it is refused exactly as before.
   */
  it('lets either collector write the archives, and nobody else', () => {
    const hauler = new FactManager({ owner: 'hauler', root });

    expect(() => hauler.record({
      topic: 'archives', venue: 'gate', period: '202003', fact: 'complete',
    })).not.toThrow();

    expect(() => hauler.record({
      topic: 'vault', venue: 'gate', period: '202003', fact: 'built',
    })).toThrow(/belongs to 'stocker'/);
  });

  /**
   * A topic absent from the map is not an experiment, it is a typo — and
   * something written under a misspelling is invisible to every consumer while
   * looking perfectly fine to whoever wrote it.
   */
  it('refuses a topic nobody owns', () => {
    expect(() => trucker.record({
      topic: 'archivez' as Topic, venue: 'gate', period: '202003', fact: 'complete',
    })).toThrow(/Unknown topic/);
  });

  it('lets anyone read anything', () => {
    trucker.record({ topic: 'archives', venue: 'gate', period: '202003', fact: 'complete' });

    expect(stocker.find({ topic: 'archives', venue: 'gate' })).toHaveLength(1);
  });
});

describe('stating a fact', () => {
  it('carries a value, and existence is the truth', () => {
    trucker.record({ topic: 'archives', venue: 'gate', period: '202003',
      fact: 'complete', value: '2026-08-11T13:25:29.862Z' });

    expect(trucker.value({ topic: 'archives', venue: 'gate', period: '202003', fact: 'complete' }))
      .toBe('2026-08-11T13:25:29.862Z');
  });

  it('answers null for a fact never stated, and empty for one with no value', () => {
    trucker.record({ topic: 'archives', venue: 'gate', period: '202003', fact: 'complete' });

    const key = { topic: 'archives', venue: 'gate', fact: 'complete' } as const;

    expect(trucker.value({ ...key, period: '202003' })).toBe('');
    expect(trucker.value({ ...key, period: '209912' })).toBeNull();
  });

  it('replaces what was said about the same key before', () => {
    const key = { topic: 'archives', venue: 'gate', period: '202003', fact: 'complete' } as const;

    trucker.record({ ...key, value: 'first' });
    trucker.record({ ...key, value: 'second' });

    expect(trucker.find({ topic: 'archives' })).toHaveLength(1);
    expect(trucker.value(key)).toBe('second');
  });

  it('takes a fact back', () => {
    const key = { topic: 'archives', venue: 'gate', period: '202003', fact: 'complete' } as const;

    trucker.record(key);

    expect(trucker.forget(key)).toBe(true);
    expect(trucker.value(key)).toBeNull();
    expect(trucker.forget(key)).toBe(false);
  });
});

/**
 * Some facts are only true together, and a set that replaces another has to
 * remove it without knowing what it held — the members a partition was built
 * from are the whole truth about that partition, and a rebuild's set supersedes
 * the last one rather than joining it.
 */
describe('taking back a whole set', () => {
  const member = (symbol: string, path: string) => ({
    topic: 'vault:details' as const, venue: 'bitget', period: '202008',
    market: 'spot', symbol, dataset: 'klines', fact: path,
  });

  beforeEach(() => {
    stocker.recordAll([member('BTC', 'a.zip'), member('BTC', 'b.zip'), member('ETH', 'c.zip')]);
  });

  it('removes everything the same query would have found', () => {
    const scope = { topic: 'vault:details' as const, venue: 'bitget', period: '202008',
      market: 'spot', symbol: 'BTC', dataset: 'klines' };

    expect(stocker.find(scope)).toHaveLength(2);
    expect(stocker.forgetAll(scope)).toBe(2);
    expect(stocker.find(scope)).toEqual([]);
  });

  it('leaves everything the query did not match', () => {
    stocker.forgetAll({ topic: 'vault:details', venue: 'bitget', symbol: 'BTC' });

    expect(stocker.find({ topic: 'vault:details' }).map(fact => fact.fact)).toEqual(['c.zip']);
  });

  it('reports nothing removed rather than failing on an empty match', () => {
    expect(stocker.forgetAll({ topic: 'vault:details', venue: 'nobody' })).toBe(0);
  });

  it('refuses a topic the caller does not own', () => {
    expect(() => stocker.forgetAll({ topic: 'archives', venue: 'bitget' })).toThrow(/stocker/);
  });
});

/**
 * The trap this schema exists around: SQLite treats NULL as distinct from NULL
 * in a unique index, so nullable discriminants would let the same fact insert
 * twice and the key would protect nothing.
 */
describe('discriminants that a topic does not use', () => {
  it('treats an unset discriminant as one value, not as unknown', () => {
    const key = { topic: 'archives', venue: 'gate', period: '202003', fact: 'complete' } as const;

    trucker.record({ ...key, value: 'a' });
    trucker.record({ ...key, market: '', value: 'b' });

    expect(trucker.find({ topic: 'archives' })).toHaveLength(1);
    expect(trucker.value(key)).toBe('b');
  });

  it('keeps facts apart when a discriminant differs', () => {
    const key = { topic: 'vault', venue: 'bitget', period: '202008',
      dataset: 'klines', symbol: 'ADAUSDT', market: 'perp', fact: 'built' } as const;

    stocker.record({ ...key, subject: 'interval=1m' });
    stocker.record({ ...key, subject: 'interval=1h' });

    expect(stocker.find({ topic: 'vault' })).toHaveLength(2);
  });

  /** A key names one row; an unstated discriminant is empty, not unconstrained. */
  it('does not let a key match a more specific fact', () => {
    stocker.record({ topic: 'vault', venue: 'bitget', period: '202008',
      symbol: 'ADAUSDT', fact: 'built', value: 'specific' });

    expect(stocker.value({ topic: 'vault', venue: 'bitget', period: '202008', fact: 'built' }))
      .toBeNull();
  });
});

describe('asking a partial key', () => {
  beforeEach(() => {
    trucker.recordAll([
      { topic: 'archives', venue: 'gate',   period: '202001', fact: 'complete' },
      { topic: 'archives', venue: 'gate',   period: '202002', fact: 'complete' },
      { topic: 'archives', venue: 'bitget', period: '202001', fact: 'complete' },
    ]);
  });

  it('matches anything for a field left out', () => {
    expect(trucker.find({ topic: 'archives', fact: 'complete' })).toHaveLength(3);
    expect(trucker.find({ topic: 'archives', venue: 'gate' })).toHaveLength(2);
  });

  it('returns them in a stable order', () => {
    expect(trucker.find({ topic: 'archives' }).map(row => `${row.venue}/${row.period}`))
      .toEqual(['bitget/202001', 'gate/202001', 'gate/202002']);
  });

  it('fills every discriminant it did not store', () => {
    const [first] = trucker.find({ topic: 'archives', venue: 'bitget' });

    expect(first).toMatchObject({ market: '', symbol: '', dataset: '', subject: '' });
  });
});

describe('streaming the same question', () => {
  beforeEach(() => {
    trucker.recordAll([
      { topic: 'archives', venue: 'gate',   period: '202001', fact: 'complete', value: 'a' },
      { topic: 'archives', venue: 'gate',   period: '202002', fact: 'complete', value: 'b' },
      { topic: 'archives', venue: 'bitget', period: '202001', fact: 'complete', value: 'c' },
    ]);
  });

  it('answers exactly what find would, in the same order', () => {
    expect([...trucker.stream({ topic: 'archives' })])
      .toEqual(trucker.find({ topic: 'archives' }));
  });

  it('narrows on a partial key the same way', () => {
    expect([...trucker.stream({ topic: 'archives', venue: 'gate' })].map(row => row.period))
      .toEqual(['202001', '202002']);
  });

  it('parses the owner\'s private state only when asked', () => {
    stocker.record({ topic: 'vault', venue: 'gate', period: '202001',
      fact: 'built', meta: { rows: 4 } });

    expect([...stocker.stream({ topic: 'vault' })][0]!.meta).toBeUndefined();
    expect([...stocker.stream({ topic: 'vault' }, { meta: true })][0]!.meta).toEqual({ rows: 4 });
  });

  it('yields before the whole answer has been read', () => {
    const rows = trucker.stream({ topic: 'archives' });

    expect(rows.next().value).toMatchObject({ venue: 'bitget' });
  });
});

describe('the owner\'s private state', () => {
  it('is left out unless asked for', () => {
    stocker.record({ topic: 'vault', venue: 'bitget', period: '202008',
      fact: 'built', meta: { rows: 10, inputs: ['a.zip'] } });

    expect(stocker.find({ topic: 'vault' })[0]!.meta).toBeUndefined();
    expect(stocker.find({ topic: 'vault' }, { meta: true })[0]!.meta)
      .toEqual({ rows: 10, inputs: ['a.zip'] });
  });

  it('is undefined rather than empty when there was none', () => {
    stocker.record({ topic: 'vault', venue: 'bitget', period: '202008', fact: 'built' });

    expect(stocker.find({ topic: 'vault' }, { meta: true })[0]!.meta).toBeUndefined();
  });
});

describe('writing many at once', () => {
  it('refuses a batch spanning two topics, since they are two databases', () => {
    expect(() => trucker.recordAll([
      { topic: 'archives', venue: 'gate', period: '202001', fact: 'complete' },
      { topic: 'vault',    venue: 'gate', period: '202001', fact: 'built' },
    ])).toThrow(/one topic at a time/);
  });

  it('does nothing at all when handed nothing', () => {
    expect(() => stocker.recordAll([])).not.toThrow();
  });
});

/** One writer per topic is what one database per topic buys. */
describe('where the databases live', () => {
  it('creates one file per topic, and only on first use', () => {
    trucker.record({ topic: 'archives', venue: 'gate', period: '202001', fact: 'complete' });

    expect(fs.readdirSync(root).filter(name => name.endsWith('.sqlite'))).toEqual(['archives.sqlite']);

    stocker.record({ topic: 'vault', venue: 'gate', period: '202001', fact: 'built' });

    expect(fs.readdirSync(root).filter(name => name.endsWith('.sqlite')).sort())
      .toEqual(['archives.sqlite', 'vault.sqlite']);
  });

  it('reads back what another manager wrote', () => {
    trucker.record({ topic: 'archives', venue: 'gate', period: '202001', fact: 'complete' });

    const fresh = new FactManager({ owner: 'stocker', root });

    try {
      expect(fresh.find({ topic: 'archives' })).toHaveLength(1);
    } finally {
      fresh.close();
    }
  });
});

/**
 * A second layer: everything the owner wants kept but nobody routinely asks
 * for. The namespace does the filtering, so no marker column is needed and a
 * normal query cannot trip over it.
 */
describe('subtopics', () => {
  it('are owned by whoever owns the tree they name', () => {
    expect(() => trucker.record({
      topic: 'logs:archives', venue: 'gate', period: '202003', fact: 'downloaded',
    })).not.toThrow();

    expect(() => stocker.record({
      topic: 'logs:archives', venue: 'gate', period: '202003', fact: 'downloaded',
    })).toThrow(/belongs to 'trucker'/);
  });

  it('finds the tree wherever it sits in the name', () => {
    trucker.record({ topic: 'archives:bookkeeping', venue: 'gate', period: '202003', fact: 'x' });
    trucker.record({ topic: 'logs:archives', venue: 'gate', period: '202003', fact: 'x' });

    expect(fs.readdirSync(root).filter(name => name.endsWith('.sqlite')).sort())
      .toEqual(['archives.bookkeeping.sqlite', 'logs.archives.sqlite']);
  });

  it('cannot be reached by a query for the tree itself', () => {
    trucker.record({ topic: 'archives', venue: 'gate', period: '202003', fact: 'complete' });
    trucker.record({ topic: 'logs:archives', venue: 'gate', period: '202003', fact: 'downloaded' });

    expect(trucker.find({ topic: 'archives' })).toHaveLength(1);
    expect(trucker.find({ topic: 'archives' })[0]!.fact).toBe('complete');
  });

  it('refuses a topic naming two trees', () => {
    expect(() => trucker.record({
      topic: 'archives:vault' as Topic, venue: 'gate', period: '202003', fact: 'x',
    })).toThrow(/more than one tree/);
  });
});

describe('when a fact was first known and last heard', () => {
  it('keeps the first statement and moves the last', async () => {
    const key = { topic: 'archives', venue: 'gate', period: '202003', fact: 'complete' } as const;

    trucker.record({ ...key, value: 'first' });

    const before = trucker.find({ topic: 'archives' })[0]!;

    await new Promise(resolve => setTimeout(resolve, 5));
    trucker.record({ ...key, value: 'second' });

    const after = trucker.find({ topic: 'archives' })[0]!;

    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt > before.updatedAt).toBe(true);
  });

  /** "We heard this again" and "this changed" are different, and only one shows. */
  it('moves updatedAt even when the value did not change', async () => {
    const key = { topic: 'archives', venue: 'gate', period: '202003',
      fact: 'complete', value: 'same' } as const;

    trucker.record(key);

    const before = trucker.find({ topic: 'archives' })[0]!;

    await new Promise(resolve => setTimeout(resolve, 5));
    trucker.record(key);

    expect(trucker.find({ topic: 'archives' })[0]!.updatedAt > before.updatedAt).toBe(true);
  });
});

/**
 * `LIKE` is not the tool for this. Measured against the real schema it did not
 * use the index even for an all-digit prefix, and fell back to scanning the
 * venue and filtering. A range seeks the index in both cases.
 */
describe('matching by prefix', () => {
  beforeEach(() => {
    trucker.recordAll([
      { topic: 'archives', venue: 'gate', period: '202512', fact: 'complete' },
      { topic: 'archives', venue: 'gate', period: '202601', fact: 'complete' },
      { topic: 'archives', venue: 'gate', period: '20260115', fact: 'complete' },
      { topic: 'archives', venue: 'gate', period: '202701', fact: 'complete' },
    ]);
  });

  it('takes every grain under the prefix', () => {
    expect(trucker.find({ topic: 'archives', prefix: { period: '2026' } })
      .map(row => row.period)).toEqual(['202601', '20260115']);
  });

  it('stops at the boundary rather than spilling into the next', () => {
    expect(trucker.find({ topic: 'archives', prefix: { period: '2027' } })
      .map(row => row.period)).toEqual(['202701']);
  });

  it('combines with an exact match on another field', () => {
    trucker.record({ topic: 'archives', venue: 'okx', period: '202601', fact: 'complete' });

    expect(trucker.find({ topic: 'archives', venue: 'gate', prefix: { period: '2026' } }))
      .toHaveLength(2);
  });

  /** The separator matters: '/' + 1 is '0', so nothing under it is missed. */
  it('works on a composed field whose separator leaves room above it', () => {
    stocker.recordAll([
      { topic: 'vault:details', venue: 'bitget', period: '202008',
        fact: 'kline/ADAUSDT/a.zip' },
      { topic: 'vault:details', venue: 'bitget', period: '202008',
        fact: 'kline/BNBUSDT/b.zip' },
      { topic: 'vault:details', venue: 'bitget', period: '202008',
        fact: 'trades/ADAUSDT/c.zip' },
    ]);

    expect(stocker.find({ topic: 'vault:details', prefix: { fact: 'kline/' } })).toHaveLength(2);
  });

  it('ignores an empty prefix rather than matching everything twice', () => {
    expect(trucker.find({ topic: 'archives', venue: 'gate', prefix: { period: '' } }))
      .toHaveLength(4);
  });
});

/**
 * Not everything is state. A partition drifting from its inputs happens, can
 * happen again, and every time it did is worth keeping — which a key that
 * replaces on conflict cannot express.
 */
describe('facts that are additive', () => {
  const drift = { topic: 'logs:vault', venue: 'bitget', period: '202008',
    symbol: 'ADAUSDT', dataset: 'klines', fact: 'drifted' } as const;

  it('keeps every occurrence instead of replacing the last', () => {
    stocker.append({ ...drift, value: 'first' });
    stocker.append({ ...drift, value: 'second' });
    stocker.append({ ...drift, value: 'third' });

    expect(stocker.find({ topic: 'logs:vault' }).map(row => row.value))
      .toEqual(['first', 'second', 'third']);
  });

  /** The clock alone collides inside one millisecond, and the loss is silent. */
  it('does not lose two occurrences in the same millisecond', () => {
    for (let at = 0; at < 50; at++) stocker.append({ ...drift, value: String(at) });

    expect(stocker.find({ topic: 'logs:vault' })).toHaveLength(50);
  });

  it('orders them by when they happened', () => {
    stocker.append({ ...drift, seq: '2026-08-11T18:19:38.706Z', value: 'later' });
    stocker.append({ ...drift, seq: '2026-08-09T11:39:49.873Z', value: 'earlier' });

    expect(stocker.find({ topic: 'logs:vault' }).map(row => row.value))
      .toEqual(['earlier', 'later']);
  });

  /** Most facts are state, and state must still replace rather than accumulate. */
  it('leaves an ordinary fact replacing itself', () => {
    trucker.record({ topic: 'archives', venue: 'gate', period: '202003',
      fact: 'complete', value: 'a' });
    trucker.record({ topic: 'archives', venue: 'gate', period: '202003',
      fact: 'complete', value: 'b' });

    expect(trucker.find({ topic: 'archives' })).toHaveLength(1);
  });

  it('separates one occurrence from another when forgetting', () => {
    stocker.append({ ...drift, seq: 'one' });
    stocker.append({ ...drift, seq: 'two' });

    expect(stocker.forget({ ...drift, seq: 'one' })).toBe(true);
    expect(stocker.find({ topic: 'logs:vault' })).toHaveLength(1);
  });
});
