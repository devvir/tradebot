import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCH_MS } from '../../../src/tools/cold/config';
import { runEvictVault } from '../../../src/tools/cold/evict/vault';
import { setWatch } from '../../../src/tools/cold/options';
import { _test_plan as plan } from '../../../src/tools/cold/push/vault/plan';
import * as record from '../../../src/tools/cold/shared/record';
import { confirm } from '../../../src/shared/ui/prompts';
import { info } from '../../../src/shared/ui/logger';
import type { ColdConfig, Selection } from '../../../src/tools/cold/types';
import { coldConfigFor } from './fixtures';

/** Taking the vault off the disk, once or left watching: what is stored by the time of each look goes. */

const where = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/tools/cold/config', async actual => ({
  ...await actual<object>(),
  loadConfig: () => coldConfigFor(where.dir, { sourceRoot: path.join(where.dir, 'vault'), coldRoot: where.dir, capBytes: 5 * 1024 ** 3 }),
}));

// What cold storage holds, as the record says it: set by each test, look by look.
vi.mock('../../../src/tools/cold/shared/record', async (actual) => {
  const real = await actual<typeof import('../../../src/tools/cold/shared/record')>();

  return { ...real, vaultStored: vi.fn(real.vaultStored) };
});

vi.mock('../../../src/tools/cold/shared/backup', () => ({
  save:     vi.fn(async () => {}),
  recordOf: vi.fn(() => ({ name: 'cold.sqlite' })),
}));

vi.mock('../../../src/tools/cold/shared/vault/spill', () => ({ completable: vi.fn(async () => []) }));

vi.mock('../../../src/tools/cold/shared/vault/needed', () => ({ notice: vi.fn(async () => {}) }));

vi.mock('../../../src/shared/ui/prompts', () => ({ confirm: vi.fn(async () => true) }));

vi.mock('../../../src/shared/ui/logger', async actual => ({
  ...await actual<object>(),
  info: vi.fn(), error: vi.fn(), warn: vi.fn(), spacer: vi.fn(), success: vi.fn(),
}));

/** What ends a run left watching: it would otherwise keep looking. */
const ENOUGH = 'enough';

const A = 'venue=gate/market=spot/dataset=klines/interval=1h/202001';
const B = 'venue=gate/market=spot/dataset=klines/interval=1h/202002';

const all: Selection = { venues: [], instruments: [] };

const config = (): ColdConfig => coldConfigFor(where.dir, { sourceRoot: path.join(where.dir, 'vault'), coldRoot: where.dir, capBytes: 5 * 1024 ** 3 });

/** The file a partition of one file is, on disk. */
const fileOf = (partition: string): string => {
  const at = partition.lastIndexOf('/');

  return path.join(where.dir, 'vault', partition.slice(0, at), '@', `${partition.slice(at + 1)}.parquet`);
};

/** A line of the ledger, and the one file it says the vault holds. */
const stock = (partition: string, revision: string): void => {
  fs.mkdirSync(path.dirname(fileOf(partition)), { recursive: true });
  fs.writeFileSync(fileOf(partition), 'x'.repeat(10));

  const ledger = path.join(where.dir, 'vault', 'ledger.csv');

  if (! fs.existsSync(ledger))
    fs.writeFileSync(ledger, 'partition|venue|market|dataset|variant|grain|bundle|month|mode|version|preVersion|postVersion|revision|size|count|stockedAt\n');

  fs.appendFileSync(ledger, [partition, 'gate', 'spot', 'x', '', 'daily', 'instrument', partition.slice(-6), 'bundle', 'v1', '', '', revision, 10, 1, 'T'].join('|') + '\n');
};

/** The record says cold storage holds these partitions, at the revisions they were stocked at. */
const storedNow = (...partitions: string[]): Map<string, Set<string>> =>
  new Map(partitions.map(one => [one, new Set([one === A ? 'aaaaaaaaaaaa' : 'bbbbbbbbbbbb'])]));

/** What cold storage holds at each look, in turn; the look after the last ends the run. */
const looks = (...each: Map<string, Set<string>>[]): void => {
  let n = 0;

  vi.mocked(record.vaultStored).mockClear().mockImplementation(() => {
    if (n === each.length) throw new Error(ENOUGH);

    return each[n++]!;
  });
};

beforeEach(() => {
  where.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-evict-vault-watch-'));

  stock(A, 'aaaaaaaaaaaa');
  stock(B, 'bbbbbbbbbbbb');

  // Planned as push plans it, against the record as it really is.
  vi.mocked(record.vaultStored).mockReset();

  const db = record.open(config().dbPath);

  plan(db, config(), []);
  record.close(db);

  // Only the waits between looks: removing a file yields to the event loop as it goes, and that is left to happen.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  setWatch(false);
  process.exitCode = undefined;
  vi.clearAllMocks();
  fs.rmSync(where.dir, { recursive: true, force: true });
});

describe('evicting the vault', () => {
  it('looks once and ends, where it is not watching', async () => {
    looks(storedNow(A));

    await runEvictVault(all, { purge: true });

    expect(fs.existsSync(fileOf(A))).toBe(false);
    expect(fs.existsSync(fileOf(B))).toBe(true);
    expect(record.vaultStored).toHaveBeenCalledTimes(1);
  });

  it('left watching, removes each partition as it is stored, and asks only before the first removal', async () => {
    setWatch(true);
    looks(new Map(), storedNow(A), storedNow(A, B));

    const ran = runEvictVault(all, { purge: true });
    const end = expect(ran).rejects.toThrow(ENOUGH);

    await vi.advanceTimersByTimeAsync(0);

    expect(fs.existsSync(fileOf(A))).toBe(true);

    await vi.advanceTimersByTimeAsync(WATCH_MS);

    expect(fs.existsSync(fileOf(A))).toBe(false);
    expect(fs.existsSync(fileOf(B))).toBe(true);

    await vi.advanceTimersByTimeAsync(WATCH_MS);

    expect(fs.existsSync(fileOf(B))).toBe(false);

    await vi.advanceTimersByTimeAsync(WATCH_MS);
    await end;

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(info).mock.calls.flat().filter(line => /Watch mode - Waiting/.test(String(line)))).toHaveLength(3);
  });

  /** The vault reports a loss: nothing goes by its account while it does, and the run waits it out. */
  it('left watching, waits out a loss the vault reports, and leaves the exit code alone', async () => {
    setWatch(true);
    looks(storedNow(A));

    fs.writeFileSync(path.join(where.dir, 'vault', 'ERROR.log'), 'T|p|r|its files are not in the vault\n');

    const ran = runEvictVault(all, { purge: true });
    const end = expect(ran).rejects.toThrow(ENOUGH);

    await vi.advanceTimersByTimeAsync(0);

    expect(fs.existsSync(fileOf(A))).toBe(true);
    expect(process.exitCode).toBeUndefined();

    fs.rmSync(path.join(where.dir, 'vault', 'ERROR.log'));

    await vi.advanceTimersByTimeAsync(WATCH_MS);

    expect(fs.existsSync(fileOf(A))).toBe(false);

    await vi.advanceTimersByTimeAsync(WATCH_MS);
    await end;
  });
});
