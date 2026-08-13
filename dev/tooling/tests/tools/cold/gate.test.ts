import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactManager } from '@tradebot/pipeline';
import { _test_whole as whole } from '../../../src/tools/cold/planners/vault';
import { surveyVault } from '../../../src/tools/cold/presence';
import * as db from '../../../src/tools/cold/db';
import type { ColdConfig, PendingGroup, SourceFile } from '../../../src/tools/cold/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The gate that stops a fragment being recorded as a finished month.
 *
 * Most of bybit's vault was parked on another disk while the real one was full,
 * and 45 months went into cold storage from the remains — one holding a single
 * partition of the 133 stocker had built. These are the tests for what must not
 * be packed.
 */

let root   = '';
let handle: DatabaseSync;

const partition = (symbol: string, month = '202106'): SourceFile => ({
  path:    `venue=bybit/market=perp/${symbol[0]}/symbol=${symbol}/dataset=trades/trades.bybit.perp.${symbol}.${month}.parquet`,
  bytes:   100,
  mtime:   1,
  venue:   'bybit',
  month,
  market:  'perp',
  symbol,
  dataset: 'trades',
  variant: null,
});

const group = (files: SourceFile[], month = '202106'): PendingGroup =>
  ({ venue: 'bybit', month, closedAt: null, files });

/** What stocker says it built. */
const built = (symbols: string[], month = '202106'): void => {
  new FactManager({ owner: 'stocker', root: path.join(root, 'facts') }).recordAll(
    symbols.map(symbol => ({
      topic: 'vault' as const, venue: 'bybit', period: month, market: 'perp',
      symbol, dataset: 'trades', fact: 'built',
    })));
};

/** A partition already uploaded, which is present even when disk is not. */
const uploaded = (symbol: string, month = '202106'): void => {
  const file = partition(symbol, month);
  const id   = db.plan(handle, {
    origin: 'vault', venue: 'bybit', month, seq: 1, name: `${month}.p01.tar`,
    bytes: file.bytes, files: 1,
    remote: `bybit/${month.slice(0, 4)}/${month}.p01.tar`,
    local:  `bybit/${month}.p01.tar`,
  }, [file]);

  db.markUploaded(handle, id, 'H:1');
};

let config: ColdConfig;

/**
 * Put partitions in the vault tree, so the survey finds them by walking rather
 * than being handed a list. Contents are irrelevant here — the gate compares
 * identities, and the identity is the path.
 */
const onDisk = (files: SourceFile[]): void => {
  for (const file of files) {
    const full = path.join(root, file.path);

    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
};

/**
 * What stocker claims, against what exists — read the way the planner reads it,
 * facts before the walk. That ordering is what keeps a partition written
 * mid-walk from withholding its whole month.
 */
const survey = () => surveyVault(handle, config);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-gate-'));

  handle = db.open(path.join(root, 'cold.sqlite'));
  config = { vaultRoot: root, sourceRoot: root, sharedRoot: root } as ColdConfig;
});

afterEach(() => {
  db.close(handle);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('packing a vault month only when the vault holds all of it', () => {
  it('passes a month whose every built partition is on disk', async () => {
    built(['BTCUSDT', 'ETHUSDT']);

    const files = [partition('BTCUSDT'), partition('ETHUSDT')];

    onDisk(files);

    const { claimed, present } = await survey();

    expect(whole(claimed, present, [group(files)]).groups).toHaveLength(1);
  });

  it('refuses a month stocker says is bigger than the tree', async () => {
    built(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);

    const files = [partition('BTCUSDT')];

    onDisk(files);

    const { claimed, present } = await survey();

    expect(whole(claimed, present, [group(files)]).groups).toEqual([]);
  });

  /**
   * The half that keeps `cold evict vault` workable: an evicted partition is
   * gone from disk on purpose and is not a hole, because cold storage has it.
   */
  it('counts a partition already in cold storage as present', async () => {
    built(['BTCUSDT', 'ETHUSDT']);
    uploaded('ETHUSDT');

    const files = [partition('BTCUSDT')];

    onDisk(files);

    const { claimed, present } = await survey();

    expect(whole(claimed, present, [group(files)]).groups).toHaveLength(1);
  });

  it('refuses only the months that are short, not the venue', async () => {
    built(['BTCUSDT'], '202106');
    built(['BTCUSDT', 'ETHUSDT'], '202107');

    const june = [partition('BTCUSDT', '202106')];
    const july = [partition('BTCUSDT', '202107')];

    onDisk([...june, ...july]);

    const { claimed, present } = await survey();

    const kept = whole(claimed, present, [group(june, '202106'), group(july, '202107')]);

    expect(kept.groups.map(entry => entry.month)).toEqual(['202106']);
    expect(kept.withheld).toBe(1);
  });

  /**
   * An absent record is not evidence of a missing partition. Blocking on it
   * would stop a venue nobody has a record for from ever being backed up.
   */
  it('leaves a month nothing has been said about alone', async () => {
    const files = [partition('BTCUSDT')];

    onDisk(files);

    const { claimed, present } = await survey();

    expect(whole(claimed, present, [group(files)]).groups).toHaveLength(1);
  });

  it('does nothing when there is nothing pending', async () => {
    built(['BTCUSDT']);

    const { claimed, present } = await survey();

    expect(whole(claimed, present, []).groups).toEqual([]);
  });

  /**
   * The partition is there and has simply been rebuilt — that is the ordinary
   * reason a month is pending, and it must not read as a hole.
   */
  it('passes a month whose partition changed rather than vanished', async () => {
    built(['BTCUSDT']);

    const changed = { ...partition('BTCUSDT'), bytes: 999, mtime: 42 };

    onDisk([changed]);

    const { claimed, present } = await survey();

    expect(whole(claimed, present, [group([changed])]).groups).toHaveLength(1);
  });

  /**
   * The ordering the survey exists to enforce. A partition written after the
   * facts were read is in neither set, so its month is neither withheld nor
   * claimed complete — it simply waits for the next run.
   */
  it('ignores a partition that appears after the facts were read', async () => {
    built(['BTCUSDT']);

    const files = [partition('BTCUSDT')];

    onDisk(files);

    const { claimed, present } = await survey();

    // Stocker builds another one while the walk is still going.
    built(['ETHUSDT']);
    onDisk([partition('ETHUSDT')]);

    expect(whole(claimed, present, [group(files)]).groups).toHaveLength(1);
  });
});
