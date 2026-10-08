import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Archives, matches } from '../../../src/tools/cold/shared/disk';
import type { PartitionKey } from '../../../src/tools/cold/shared/types';

let root: string;

const put = (relative: string, content = 'x'): void => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
};

const daily: PartitionKey = {
  venue: 'gate', market: 'spot', dataset: 'trades', variant: '', grain: 'daily', bundle: 'instrument', month: '202006',
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-disk-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('a partition\'s files on disk', () => {
  it('gathers the month from under every instrument', async () => {
    put('gate/spot/trades/B/BTC_USDT/202006/gate|spot|trades|BTC_USDT|20200601.csv.gz', 'aa');
    put('gate/spot/trades/E/ETH_USDT/202006/gate|spot|trades|ETH_USDT|20200601.csv.gz', 'bbb');

    expect((await new Archives(root).filesOf(daily))).toEqual([
      { path: 'gate/spot/trades/B/BTC_USDT/202006/gate|spot|trades|BTC_USDT|20200601.csv.gz', bytes: 2 },
      { path: 'gate/spot/trades/E/ETH_USDT/202006/gate|spot|trades|ETH_USDT|20200601.csv.gz', bytes: 3 },
    ]);
  });

  /** A dataset's folder holds every grain of it side by side, and other months beside this one. */
  it('leaves out another grain, another month, and anything that is not a canonical file', async () => {
    put('gate/spot/trades/B/BTC_USDT/202006/gate|spot|trades|BTC_USDT|20200601.csv.gz');
    put('gate/spot/trades/B/BTC_USDT/202006/gate|spot|trades|BTC_USDT|202006.csv.gz');
    put('gate/spot/trades/B/BTC_USDT/202007/gate|spot|trades|BTC_USDT|20200701.csv.gz');
    put('gate/spot/trades/B/BTC_USDT/202006/gate|spot|trades|BTC_USDT|20200602.csv.gz.bak');

    expect((await new Archives(root).filesOf(daily)).map(file => path.basename(file.path)))
      .toEqual(['gate|spot|trades|BTC_USDT|20200601.csv.gz']);
  });

  it('finds a venue-wide file under @, and only there', async () => {
    put('okx/spot/trades/@/202006/okx|spot|trades|@|20200601.zip');
    put('okx/spot/trades/B/BTC-USDT/202006/okx|spot|trades|BTC-USDT|20200601.zip');

    const bucket: PartitionKey = { ...daily, venue: 'okx', bundle: 'market' };

    expect((await new Archives(root).filesOf(bucket)).map(file => file.path))
      .toEqual(['okx/spot/trades/@/202006/okx|spot|trades|@|20200601.zip']);
    expect((await new Archives(root).filesOf({ ...bucket, bundle: 'instrument' }))).toHaveLength(1);
  });

  it('is nothing for a dataset that is not on disk', async () => {
    expect((await new Archives(root).filesOf(daily))).toEqual([]);
  });
});

describe('whether the disk holds what the catalog says', () => {
  const files = [{ path: 'a', bytes: 2 }, { path: 'b', bytes: 3 }];

  it('agrees on the count and the total size', () => {
    expect(matches(files, { files: 2, bytes: 5 })).toBe(true);
  });

  it('does not where a file is missing, or one is another size', () => {
    expect(matches(files, { files: 3, bytes: 5 })).toBe(false);
    expect(matches(files, { files: 2, bytes: 6 })).toBe(false);
  });
});
