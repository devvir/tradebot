import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../../src/tools/cold/db';
import type { ColdConfig, SourceFile } from '../../../src/tools/cold/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Reclaiming staged tars mid-run.
 *
 * The rule under test: what fills the staging buffer and what drains it must be
 * the same set. The buffer is measured from the directory, so anything left on
 * disk counts against it — including tars belonging to venues this run was not
 * asked about, and tars whose part is already recorded as backed up. `settle`
 * sees neither, which is how a run that had 11.7GB staged against a 10GB target
 * paused for ever with nothing queued and nothing packing.
 */

/** What Mega is holding, keyed by remote path. */
const holding = new Map<string, { bytes: number; handle: string | null }>();

vi.mock('../../../src/tools/cold/mega', () => ({
  remote: vi.fn(async (remotePath: string) => holding.get(remotePath) ?? null),
}));

const { _test_reclaimStaged: reclaimStaged } = await import('../../../src/tools/cold/push');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-reclaim-'));

const config = {
  sourceRoot: root,
  coldRoot:   path.join(root, '@cold'),
  megaRoot:   '/Tradebot/vault',
  capBytes:   1_000_000,
} as ColdConfig;

const member = (venue: string, name: string, bytes: number): SourceFile => ({
  path: `venue=${venue}/${name}.parquet`, bytes, mtime: 0,
  venue, month: '202009', market: 'spot',
  symbol: name, dataset: 'klines', variant: null,
});

/**
 * A part planned, packed, and staged on disk — the state every case here starts
 * from, since a tar only matters once it exists.
 */
const staged = (
  handle:  DatabaseSync,
  venue:   string,
  options: { bytes?: number; uploaded?: boolean } = {},
): { id: number; local: string; remote: string } => {
  const name   = '202009.p01.tar';
  const local  = path.join(venue, name);
  const remote = `${venue}/2020/${name}`;
  const bytes  = options.bytes ?? 512;

  const id = db.plan(handle, {
    origin: 'vault', venue, month: '202009', seq: 1, name,
    bytes, files: 1, remote, local,
  }, [member(venue, 'AAA', bytes)]);

  // What the tar's path resolves to for this deployment.
  const absolute = path.join(config.coldRoot, 'vault', local);

  if (options.uploaded) db.markUploaded(handle, id, 'H:old');

  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, 'x'.repeat(bytes));

  return { id, local: absolute, remote: `${config.megaRoot}/${remote}` };
};

let handle: DatabaseSync;

beforeEach(() => {
  handle = db.open(':memory:');
  holding.clear();
  fs.rmSync(config.coldRoot, { recursive: true, force: true });
});

describe('a staged tar outside the run’s plans', () => {
  /** The deadlock: `push vault kucoin` cannot clear a finished binance tar. */
  it('is reclaimed even though no part of this run describes it', async () => {
    const foreign = staged(handle, 'binance');
    const mine    = staged(handle, 'kucoin');

    holding.set(foreign.remote, { bytes: 512, handle: 'H:new' });

    // The run's own parts — filtered to the venue it was asked about.
    const parts = db.outstanding(handle, 'vault').filter(part => part.venue === 'kucoin');

    expect(await reclaimStaged(handle, config, 'vault', parts)).toBe(1);

    expect(fs.existsSync(foreign.local)).toBe(false);
    expect(fs.existsSync(mine.local)).toBe(true);

    const part = db.allParts(handle, 'vault').find(row => row.id === foreign.id)!;

    expect(part.uploadedAt).not.toBeNull();
    expect(part.handle).toBe('H:new');
  });

  /** `settle` skips a part already marked uploaded, so nothing else can free it. */
  it('is reclaimed when its part was recorded as backed up but never deleted', async () => {
    const left = staged(handle, 'binance', { uploaded: true });

    holding.set(left.remote, { bytes: 512, handle: 'H:old' });

    expect(await reclaimStaged(handle, config, 'vault', [])).toBe(1);
    expect(fs.existsSync(left.local)).toBe(false);
  });
});

describe('a staged tar that is not safely in Mega', () => {
  it('is left alone while Mega does not hold it', async () => {
    const flying = staged(handle, 'binance');

    expect(await reclaimStaged(handle, config, 'vault', [])).toBe(0);
    expect(fs.existsSync(flying.local)).toBe(true);

    const part = db.allParts(handle, 'vault').find(row => row.id === flying.id)!;

    expect(part.uploadedAt).toBeNull();
  });

  /** A part-way upload is published at the wrong size; it is not a confirmation. */
  it('is left alone while Mega holds a different size', async () => {
    const half = staged(handle, 'binance', { bytes: 1024 });

    holding.set(half.remote, { bytes: 512, handle: 'H:partial' });

    expect(await reclaimStaged(handle, config, 'vault', [])).toBe(0);
    expect(fs.existsSync(half.local)).toBe(true);
  });

  /**
   * Nothing describes it, so nothing can say what is inside. Recovery discards
   * orphans at startup; deleting one here would take a tar being written.
   */
  it('leaves a tar no plan describes where it is', async () => {
    const orphan = path.join(config.coldRoot, 'vault', 'binance', 'nobody.tar');

    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, 'x');

    expect(await reclaimStaged(handle, config, 'vault', [])).toBe(0);
    expect(fs.existsSync(orphan)).toBe(true);
  });
});

/**
 * The run counts what it has sent from the rows it holds in memory, not from the
 * database, so a part reclaimed here has to be marked in both or the final
 * tally reports less than actually landed.
 */
describe('a part the run does own', () => {
  it('is marked uploaded on the in-memory row as well as the record', async () => {
    const mine  = staged(handle, 'kucoin');
    const parts = db.outstanding(handle, 'vault');

    holding.set(mine.remote, { bytes: 512, handle: 'H:new' });

    expect(parts[0]!.uploadedAt).toBeNull();
    expect(await reclaimStaged(handle, config, 'vault', parts)).toBe(1);
    expect(parts[0]!.uploadedAt).not.toBeNull();
  });
});
