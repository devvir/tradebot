import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../../src/tools/cold/db';
import type { ColdConfig, SourceFile } from '../../../src/tools/cold/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Replanning a month that is already packed.
 *
 * The rule under test: a tar holding nothing any other tar holds is **new** and
 * appends; a tar holding something already packed is an **update** and must go
 * back over the name it already occupies, so Mega replaces rather than
 * accumulates. Everything the month held has to survive that, and the check is
 * month-wide because bin packing moves a member between parts freely.
 */

const answers: boolean[] = [];

vi.mock('../../../src/shared/ui/prompts', () => ({
  confirm: vi.fn(async () => answers.shift() ?? false),
}));

const { _test_replanMonth: replanMonth } = await import('../../../src/tools/cold/push');

/** A vault tree on disk, so the replan can restate members from it. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-replan-'));

const config = {
  sourceRoot: root,
  coldRoot:   path.join(root, '@cold'),
  megaRoot:   '/Tradebot/vault',
  capBytes:   1_000_000,
} as ColdConfig;

const write = (relative: string, bytes: number): SourceFile => {
  const absolute = path.join(root, relative);

  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, 'x'.repeat(bytes));

  const stat = fs.statSync(absolute);

  return {
    path: relative, bytes: stat.size, mtime: Math.floor(stat.mtimeMs),
    venue: 'bitget', month: '202009', market: 'spot',
    symbol: relative.replace(/.*\/(\w+)\.parquet/, '$1'), dataset: 'klines', variant: null,
  };
};

/** Record a part exactly as a previous run would have left it, already in Mega. */
const packed = (handle: DatabaseSync, seq: number, files: SourceFile[]): void => {
  const name = `202009.p${String(seq).padStart(2, '0')}.tar`;
  const id   = db.plan(handle, {
    origin: 'vault', venue: 'bitget', month: '202009', seq, name,
    bytes: files.reduce((total, file) => total + file.bytes, 0), files: files.length,
    remote: `${config.megaRoot}/bitget/2020/${name}`,
    local:  path.join(config.coldRoot, 'vault', 'bitget', name),
  }, files);

  db.markUploaded(handle, id, `H:${seq}`);
};

const inMega = (handle: DatabaseSync) =>
  new Map(db.allParts(handle, 'vault')
    .filter(part => part.uploadedAt)
    .map(part => [part.remote, { bytes: part.bytes, handle: part.handle }]));

let handle: DatabaseSync;

beforeEach(() => {
  handle = db.open(':memory:');
  answers.length = 0;
});

describe('replanning a month', () => {
  it('writes back over the names it already occupies', async () => {
    const a = write('venue=bitget/AAA.parquet', 100);
    const b = write('venue=bitget/BBB.parquet', 100);

    packed(handle, 1, [a]);
    packed(handle, 2, [b]);

    const grown = write('venue=bitget/AAA.parquet', 400);

    expect(await replanMonth(handle, config,
      'vault', { venue: 'bitget', month: '202009', files: [grown] }, inMega(handle))).toBe(true);

    const parts = db.partsIn(handle, 'vault', 'bitget', '202009');

    // One bin holds both, so p01 is rewritten and p02 becomes an orphan.
    expect(parts.map(part => part.name)).toEqual(['202009.p01.tar']);
    expect(parts[0]!.replan).toBe(1);

    const members = db.membersOf(handle, parts[0]!.id).sort();

    expect(members).toEqual(['venue=bitget/AAA.parquet', 'venue=bitget/BBB.parquet']);
  });

  /** The updated file's new size must reach the plan, not the size last packed. */
  it('restates every member from disk rather than from the record', async () => {
    const a = write('venue=bitget/AAA.parquet', 100);

    packed(handle, 1, [a]);
    write('venue=bitget/AAA.parquet', 750);

    await replanMonth(handle, config, 'vault',
      { venue: 'bitget', month: '202009', files: [write('venue=bitget/AAA.parquet', 750)] },
      inMega(handle));

    expect(db.partsIn(handle, 'vault', 'bitget', '202009')[0]!.bytes).toBe(750);
  });

  it('records an orphan when the month packs into fewer parts', async () => {
    packed(handle, 1, [write('venue=bitget/AAA.parquet', 100)]);
    packed(handle, 2, [write('venue=bitget/BBB.parquet', 100)]);
    packed(handle, 3, [write('venue=bitget/CCC.parquet', 100)]);

    await replanMonth(handle, config, 'vault',
      { venue: 'bitget', month: '202009', files: [write('venue=bitget/AAA.parquet', 120)] },
      inMega(handle));

    expect(db.partsIn(handle, 'vault', 'bitget', '202009').map(p => p.name))
      .toEqual(['202009.p01.tar']);

    // Both orphans are recorded…
    const recorded = (handle.prepare('SELECT remote FROM ghost ORDER BY remote')
      .all() as unknown as { remote: string }[]).map(row => row.remote);

    expect(recorded).toEqual([
      `${config.megaRoot}/bitget/2020/202009.p02.tar`,
      `${config.megaRoot}/bitget/2020/202009.p03.tar`,
    ]);

    // …and none is removable, both because nobody has approved them and because
    // their replacement is not in Mega yet. Deleting now would leave the month
    // with neither copy.
    expect(db.removableGhosts(handle, 'vault')).toEqual([]);
  });
});

/**
 * The case that must never pass quietly: cold storage holds a file, disk no
 * longer does, and replanning would write tars without it over the tars that
 * have it. Updating is how it would be lost.
 */
describe('a member that can no longer be repacked', () => {
  it('is refused, leaving the month exactly as it was', async () => {
    const a = write('venue=bitget/AAA.parquet', 100);
    const b = write('venue=bitget/BBB.parquet', 100);

    packed(handle, 1, [a, b]);
    fs.rmSync(path.join(root, 'venue=bitget/BBB.parquet'));

    expect(await replanMonth(handle, config, 'vault',
      { venue: 'bitget', month: '202009', files: [write('venue=bitget/AAA.parquet', 120)] },
      inMega(handle))).toBe(false);

    const parts = db.partsIn(handle, 'vault', 'bitget', '202009');

    expect(parts).toHaveLength(1);
    expect(parts[0]!.uploadedAt).not.toBeNull();
    expect(db.membersOf(handle, parts[0]!.id).sort())
      .toEqual(['venue=bitget/AAA.parquet', 'venue=bitget/BBB.parquet']);
  });

  /**
   * There is no answer worth offering. Agreeing costs the only copy of those
   * files, and the run cannot make the alternative true — what the month needs
   * is its evicted members pulled back from Mega first. So the refusal is not a
   * default that a prompt could turn over.
   */
  it('cannot be overridden, and asks nothing', async () => {
    const a = write('venue=bitget/AAA.parquet', 100);
    const b = write('venue=bitget/BBB.parquet', 100);

    packed(handle, 1, [a, b]);
    fs.rmSync(path.join(root, 'venue=bitget/BBB.parquet'));

    // Queued in case anything asks; nothing should, so it is still here after.
    answers.push(true);

    expect(await replanMonth(handle, config, 'vault',
      { venue: 'bitget', month: '202009', files: [write('venue=bitget/AAA.parquet', 120)] },
      inMega(handle))).toBe(false);

    expect(answers).toEqual([true]);

    const parts = db.partsIn(handle, 'vault', 'bitget', '202009');

    expect(parts).toHaveLength(1);
    expect(db.membersOf(handle, parts[0]!.id).sort())
      .toEqual(['venue=bitget/AAA.parquet', 'venue=bitget/BBB.parquet']);
  });
});

/**
 * An orphan is only removable once every part that replaced it has landed, so a
 * run interrupted between the two leaves both copies standing rather than
 * neither.
 */
describe('when an orphan becomes removable', () => {
  it('stays hidden while any part of its month is still unsent', async () => {
    packed(handle, 1, [write('venue=bitget/AAA.parquet', 100)]);
    packed(handle, 2, [write('venue=bitget/BBB.parquet', 100)]);

    await replanMonth(handle, config, 'vault',
      { venue: 'bitget', month: '202009', files: [write('venue=bitget/AAA.parquet', 120)] },
      inMega(handle));

    // The replacement is planned but not uploaded.
    // …and none is removable, both because nobody has approved them and because
    // their replacement is not in Mega yet.
    expect(db.removableGhosts(handle, 'vault')).toEqual([]);

    const part = db.partsIn(handle, 'vault', 'bitget', '202009')[0]!;

    db.markUploaded(handle, part.id, 'H:new');

    // Still nothing: the upload landed, but nobody has said these may go.
    expect(db.removableGhosts(handle, 'vault')).toEqual([]);

    db.approveGhosts(handle, 'vault');

    expect(db.removableGhosts(handle, 'vault').map(g => g.remote))
      .toEqual([`${config.megaRoot}/bitget/2020/202009.p02.tar`]);
  });
});
