import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { idOf, idsByMonth, inputsByRaw, _test_filesFor as filesFor } from '../../../src/tools/cold/ledger';

let root = '';

const write = (name: string, lines: object[]): void => {
  fs.writeFileSync(path.join(root, '@meta', 'built', name),
    lines.map(line => JSON.stringify(line)).join('\n') + '\n');
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  fs.mkdirSync(path.join(root, '@meta', 'built'), { recursive: true });
});

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

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

/**
 * A repair once left `klines.bitget.jsonl.bak` in this directory. It described
 * 4,480 partitions under a layout that no longer exists, and reading it as a
 * ledger would block twenty months against records nothing can satisfy.
 */
describe('which files count as a venue\'s ledger', () => {
  it('takes only <dataset>.<venue>.jsonl', () => {
    for (const name of ['klines.bitget.jsonl', 'trades.bitget.jsonl',
      'klines.bitget.jsonl.bak', 'klines.bybit.jsonl', 'notes.txt'])
      fs.writeFileSync(path.join(root, '@meta', 'built', name), '');

    expect(filesFor(root, 'bitget').map(file => path.basename(file)).sort())
      .toEqual(['klines.bitget.jsonl', 'trades.bitget.jsonl']);
  });

  it('reads no ledger at all rather than failing when there is no directory', () => {
    expect(filesFor(path.join(root, 'nowhere'), 'bitget')).toEqual([]);
  });
});

describe('which partitions a month should hold', () => {
  it('groups the ids by their month', async () => {
    write('trades.bybit.jsonl', [
      { id: 'trades|bybit|perp|BTCUSDT|2021-06', inputs: [] },
      { id: 'trades|bybit|perp|ETHUSDT|2021-06', inputs: [] },
      { id: 'trades|bybit|perp|BTCUSDT|2021-07', inputs: [] },
    ]);

    const found = await idsByMonth(root, 'bybit');

    expect([...found.keys()].sort()).toEqual(['202106', '202107']);
    expect(found.get('202106')!.size).toBe(2);
  });

  /** Append-only: a rebuild appends, and is still one partition. */
  it('counts a partition once however often it was rebuilt', async () => {
    write('trades.bybit.jsonl', [
      { id: 'trades|bybit|perp|BTCUSDT|2021-06', inputs: [] },
      { id: 'trades|bybit|perp|BTCUSDT|2021-06', inputs: [] },
      { id: 'trades|bybit|perp|BTCUSDT|2021-06', inputs: [] },
    ]);

    expect((await idsByMonth(root, 'bybit')).get('202106')!.size).toBe(1);
  });

  it('reads the month off an id that carries extras', async () => {
    write('klines.bitget.jsonl', [{ id: 'klines|bitget|spot|BTCUSDT|1m|2020-08', inputs: [] }]);

    expect([...(await idsByMonth(root, 'bitget')).keys()]).toEqual(['202008']);
  });

  it('is empty for a venue with no ledger', async () => {
    expect((await idsByMonth(root, 'nobody')).size).toBe(0);
  });
});

describe('which partitions a raw file fed', () => {
  it('keys by venue-prefixed raw path and collects every partition', async () => {
    write('trades.gate.jsonl', [
      { id: 'trades|gate|spot|A|2018-01', inputs: [{ path: 'spot/a.csv.gz' }] },
      { id: 'trades|gate|spot|B|2018-01', inputs: [{ path: 'spot/a.csv.gz' }] },
    ]);

    const found = await inputsByRaw(root, 'gate');

    expect(found.get('gate/spot/a.csv.gz'))
      .toEqual(['trades|gate|spot|A|2018-01', 'trades|gate|spot|B|2018-01']);
  });

  /**
   * The later line replaces the earlier one, exactly as stocker reads it back.
   * Accumulating both would let a raw file dropped by a rebuild go on vouching
   * for itself out of a superseded entry.
   */
  it('takes only a partition\'s latest build', async () => {
    write('trades.gate.jsonl', [
      { id: 'trades|gate|spot|A|2018-01', inputs: [{ path: 'spot/old.csv.gz' }] },
      { id: 'trades|gate|spot|A|2018-01', inputs: [{ path: 'spot/new.csv.gz' }] },
    ]);

    const found = await inputsByRaw(root, 'gate');

    expect(found.has('gate/spot/old.csv.gz')).toBe(false);
    expect(found.get('gate/spot/new.csv.gz')).toEqual(['trades|gate|spot|A|2018-01']);
  });

  it('survives a torn final line', async () => {
    fs.writeFileSync(path.join(root, '@meta', 'built', 'trades.gate.jsonl'),
      `${JSON.stringify({ id: 'trades|gate|spot|A|2018-01', inputs: [{ path: 'spot/a.csv.gz' }] })}\n`
      + '{"id":"trades|gate|spot|B|2018-01","inpu');

    expect((await inputsByRaw(root, 'gate')).size).toBe(1);
  });
});
