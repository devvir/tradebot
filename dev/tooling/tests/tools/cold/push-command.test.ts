import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from '../../../src/commands/cold';
import { runPush } from '../../../src/tools/cold/push/archives';
import { runPushCatalog } from '../../../src/tools/cold/push/catalog';
import { runPullCatalog } from '../../../src/tools/cold/pull/catalog';
import { setWatch, setYes } from '../../../src/tools/cold/options';
import * as backup from '../../../src/tools/cold/shared/backup';
import { error, warn } from '../../../src/shared/ui/logger';
import { coldConfigFor } from './fixtures';

/** `cold push` and `cold pull` on the command line: what each origin is told, and what is refused before any of it runs. */

const where = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/tools/cold/config', async actual => ({
  ...await actual<object>(),
  loadConfig: () => coldConfigFor(where.dir),
}));

vi.mock('../../../src/tools/cold/push/archives', () => ({ runPush: vi.fn(async () => {}) }));
vi.mock('../../../src/tools/cold/push/catalog', () => ({ runPushCatalog: vi.fn(async () => {}) }));
vi.mock('../../../src/tools/cold/pull/catalog', () => ({ runPullCatalog: vi.fn(async () => {}) }));

vi.mock('../../../src/tools/cold/shared/backup', () => ({
  check:     vi.fn(async () => {}),
  save:      vi.fn(async () => {}),
  recordOf:  vi.fn(() => ({ name: 'cold.sqlite' })),
  ledgersOf: vi.fn(() => [{ name: 'ledger.csv' }]),
}));

vi.mock('../../../src/shared/ui/logger', async actual => ({
  ...await actual<object>(),
  info: vi.fn(), error: vi.fn(), warn: vi.fn(), spacer: vi.fn(), setPrefix: vi.fn(),
}));

const parse = async (...args: string[]): Promise<void> => {
  const program = new Command().exitOverride();

  register(program);

  await program.parseAsync(['node', 'tb', ...args]);
};

/** A line that is refused: it ends the process with 1, and says why. */
const refused = async (...args: string[]): Promise<string> => {
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });

  try {
    await expect(parse(...args)).rejects.toThrow('exit 1');
  } finally {
    exit.mockRestore();
  }

  return vi.mocked(error).mock.calls.flat().join('\n');
};

beforeEach(() => {
  where.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-push-command-'));
});

afterEach(() => {
  setWatch(false);
  setYes(false);
  vi.clearAllMocks();
  fs.rmSync(where.dir, { recursive: true, force: true });
});

describe('cold push, with what only the catalog\'s copy takes', () => {
  it.each([
    ['--dry-run', 'archives'], ['-n', 'archives'], ['--rebase', 'archives'], ['--keep-snapshot', 'vault'], ['--drop-snapshot', 'vault'],
    ['--dry-run', 'all'],
  ])('refuses %s for %s, and pushes nothing', async (flag, origin) => {
    const said = await refused('cold', 'push', origin, flag);

    expect(said).toMatch(/only for `cold push catalog`/);
    expect(said).toMatch(new RegExp(flag === '-n' ? '--dry-run' : flag));
    expect(runPush).not.toHaveBeenCalled();
  });

  it('refuses it over every tree', async () => {
    await refused('cold', 'push', '--all-sources', '--rebase');

    expect(runPush).not.toHaveBeenCalled();
  });

  it('passes it on to the catalog\'s copy', async () => {
    await parse('cold', 'push', 'catalog', '--dry-run', '--rebase', '--keep-snapshot');

    expect(runPushCatalog).toHaveBeenCalledWith({ dryRun: true, rebase: true, snapshot: 'keep' });
  });
});

describe('cold push --lens', () => {
  it('narrows the archives', async () => {
    await parse('cold', 'push', 'archives', '--lens', 'spot');

    expect(runPush).toHaveBeenCalledWith('archives', { venues: [], lens: 'spot' });
  });

  it('is refused for the vault alone, which is pushed whole', async () => {
    expect(await refused('cold', 'push', 'vault', '--lens', 'spot')).toMatch(/vault is always pushed whole/);
    expect(runPush).not.toHaveBeenCalled();
  });

  it('over every tree, narrows the archives and says the vault is pushed whole', async () => {
    await parse('cold', 'push', '--all-sources', '--lens', 'spot');

    expect(vi.mocked(warn).mock.calls.flat().join('\n')).toMatch(/vault is pushed whole/);
    expect(vi.mocked(runPush).mock.calls.map(call => call[0])).toEqual(['archives', 'vault']);
  });

  it('is refused for the catalog\'s copy, which is of the whole catalog', async () => {
    expect(await refused('cold', 'push', 'catalog', '--lens', 'spot')).toMatch(/whole catalog/);
    expect(runPushCatalog).not.toHaveBeenCalled();
  });
});

describe('the catalog\'s copy, sent or brought back', () => {
  /** It writes into the record what it sent: the record's copy in Mega is checked first, and sent after. */
  it.each([
    ['push', runPushCatalog],
    ['pull', runPullCatalog],
  ])('%s: has the record checked before it and backed up after it', async (verb, run) => {
    const order: string[] = [];

    vi.mocked(backup.check).mockImplementationOnce(async () => { order.push('check'); });
    vi.mocked(run).mockImplementationOnce(async () => { order.push(verb); });
    vi.mocked(backup.save).mockImplementationOnce(async () => { order.push('save'); });

    await parse('cold', verb, 'catalog');

    expect(order).toEqual(['check', verb, 'save']);
    expect(vi.mocked(backup.save).mock.calls[0]![1].map(one => one.name)).toEqual(['cold.sqlite']);
  });
});
