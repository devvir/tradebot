import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLL_MS, WATCH_MS } from '../../../src/tools/cold/config';
import { setWatch } from '../../../src/tools/cold/options';
import { work } from '../../../src/tools/cold/push/vault/work';
import * as record from '../../../src/tools/cold/shared/record';
import { error } from '../../../src/shared/ui/logger';
import type { DatabaseSync } from 'node:sqlite';
import type { Remote } from '../../../src/tools/cold/shared/types';
import { coldConfigFor } from './fixtures';

/** Storing the vault while watching it: what the next look at its ledger finds wrong is waited out, and fails nothing. */

vi.mock('../../../src/tools/cold/push/confirm', () => ({ confirmVault: vi.fn(async () => {}) }));

vi.mock('../../../src/tools/cold/shared/backup', () => ({
  save:      vi.fn(async () => {}),
  recordOf:  vi.fn(() => ({ name: 'cold.sqlite' })),
  ledgersOf: vi.fn(() => []),
}));

vi.mock('../../../src/shared/ui/logger', async actual => ({
  ...await actual<object>(),
  info: vi.fn(), error: vi.fn(), warn: vi.fn(), spacer: vi.fn(), success: vi.fn(),
}));

/** What ends the run under test: it would otherwise keep watching. */
const ENOUGH = 'enough';

let dir: string;
let db:  DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-push-vault-watch-'));
  fs.mkdirSync(path.join(dir, 'vault'));
  fs.writeFileSync(path.join(dir, 'vault', 'ledger.csv'),
    'partition|venue|market|dataset|variant|grain|bundle|month|mode|version|preVersion|postVersion|revision|size|count|stockedAt\n');

  db = record.open(path.join(dir, 'cold.sqlite'));

  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  record.close(db);
  setWatch(false);
  process.exitCode = undefined;
  vi.clearAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a push of the vault left watching', () => {
  it('says the vault reports a problem at its next look, and leaves the exit code alone', async () => {
    setWatch(true);

    const began  = Date.now();
    let rounds   = 0;
    let looked   = false;

    const remote = {
      // Called as every round begins: the next look at the ledger is due in the round that begins after WATCH_MS.
      dropDuplicateUploads: async () => {
        rounds += 1;

        // A problem reported once the run is under way, and the run stopped once it has looked again.
        if (rounds === 2) fs.writeFileSync(path.join(dir, 'vault', 'ERROR.log'), 'T|p|r|its files are not in the vault\n');
        if (looked) throw new Error(ENOUGH);

        looked = Date.now() >= began + WATCH_MS;
      },
    } as unknown as Remote;

    const ran = work(db, coldConfigFor(dir, { coldRoot: dir }), [], remote);
    const end = expect(ran).rejects.toThrow(ENOUGH);

    await vi.advanceTimersByTimeAsync(WATCH_MS + 2 * POLL_MS);
    await end;

    expect(vi.mocked(error).mock.calls.flat().join('\n')).toMatch(/The vault reports 1 problem/);
    expect(process.exitCode).toBeUndefined();
  });
});
