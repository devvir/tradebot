import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactManager } from '@tradebot/pipeline';
import { idOf, idsByMonth, inputsByRaw } from '../../../src/tools/cold/ledger';
import type { FactInput } from '@tradebot/pipeline';

let root  = '';
let facts: FactManager;

/** Stocker stating what it built, which is what these readers read. */
const stocker = (rows: FactInput[]): void => {
  new FactManager({ owner: 'stocker', root }).recordAll(rows);
};

beforeEach(() => {
  root  = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-'));
  facts = new FactManager({ owner: 'tooling', root });
});

afterEach(() => {
  facts.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('rebuilding a partition id from what a tree or a record carries', () => {
  it('joins the attributes in stocker\'s order, with the month hyphenated', () => {
    expect(idOf({ dataset: 'trades', venue: 'bybit', market: 'perp', symbol: 'BTCUSDT',
      variant: null, month: '202106' })).toBe('trades|bybit|perp|BTCUSDT|2021-06');
  });

  it('takes the extras out of the variant, in the order the path wrote them', () => {
    expect(idOf({ dataset: 'klines', venue: 'bitget', market: 'spot', symbol: 'BTCUSDT',
      variant: 'interval=1m', month: '202008' })).toBe('klines|bitget|spot|BTCUSDT|1m|2020-08');
  });

  it('leaves out an attribute the tree does not carry', () => {
    expect(idOf({ dataset: 'funding', venue: 'okx', market: null, symbol: 'ETH',
      variant: null, month: '202301' })).toBe('funding|okx|ETH|2023-01');
  });
});

describe('which partitions a month should hold', () => {
  const built = (symbol: string, period: string): FactInput => ({
    topic: 'vault', venue: 'bybit', period, market: 'perp', symbol,
    dataset: 'trades', fact: 'built',
  });

  it('groups the ids by their month', () => {
    stocker([built('BTCUSDT', '202106'), built('ETHUSDT', '202106'), built('BTCUSDT', '202107')]);

    const found = idsByMonth(facts, 'bybit');

    expect([...found.keys()].sort()).toEqual(['202106', '202107']);
    expect(found.get('202106')!.size).toBe(2);
    expect([...found.get('202107')!]).toEqual(['trades|bybit|perp|BTCUSDT|2021-07']);
  });

  /**
   * A rebuild re-states the same fact rather than appending beside it, so the
   * key it collides on is what keeps the count right — the flat file needed the
   * reader to collapse duplicate lines to reach the same answer.
   */
  it('counts a partition once however often it was rebuilt', () => {
    stocker([built('BTCUSDT', '202106')]);
    stocker([built('BTCUSDT', '202106')]);
    stocker([built('BTCUSDT', '202106')]);

    expect(idsByMonth(facts, 'bybit').get('202106')!.size).toBe(1);
  });

  /**
   * `subject` holds the extras bare — `1m`, not `interval=1m` — and the id is
   * the same either way, since `idOf` takes whatever follows an absent `=`.
   */
  it('reads a partition that carries extras', () => {
    stocker([{ topic: 'vault', venue: 'bitget', period: '202008', market: 'spot',
      symbol: 'BTCUSDT', dataset: 'klines', subject: '1m', fact: 'built' }]);

    const found = idsByMonth(facts, 'bitget');

    expect([...found.keys()]).toEqual(['202008']);
    expect([...found.get('202008')!]).toEqual(['klines|bitget|spot|BTCUSDT|1m|2020-08']);
  });

  it('is empty for a venue nothing has been said about', () => {
    expect(idsByMonth(facts, 'nobody').size).toBe(0);
  });
});

describe('which partitions a raw file fed', () => {
  const member = (symbol: string, input: string): FactInput => ({
    topic: 'vault:details', venue: 'gate', period: '201801', market: 'spot', symbol,
    dataset: 'trades', fact: input,
  });

  it('keys by venue-prefixed raw path and collects every partition', () => {
    stocker([member('A', 'spot/a.csv.gz'), member('B', 'spot/a.csv.gz')]);

    expect(inputsByRaw(facts, 'gate').get('gate/spot/a.csv.gz'))
      .toEqual(['trades|gate|spot|A|2018-01', 'trades|gate|spot|B|2018-01']);
  });

  it('names a partition once however many of its inputs a query returns', () => {
    stocker([member('A', 'spot/a.csv.gz'), member('A', 'spot/b.csv.gz')]);

    const found = inputsByRaw(facts, 'gate');

    expect(found.get('gate/spot/a.csv.gz')).toEqual(['trades|gate|spot|A|2018-01']);
    expect(found.get('gate/spot/b.csv.gz')).toEqual(['trades|gate|spot|A|2018-01']);
  });

  it('says nothing about a venue with no members recorded', () => {
    stocker([member('A', 'spot/a.csv.gz')]);

    expect(inputsByRaw(facts, 'bybit').size).toBe(0);
  });
});
