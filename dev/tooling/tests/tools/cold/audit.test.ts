import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _test_choiceOf as choiceOf } from '../../../src/tools/cold/audit';
import { againstDisk } from '../../../src/tools/cold/audit/checks/disk';
import { againstMega } from '../../../src/tools/cold/audit/checks/mega';
import { withinItself } from '../../../src/tools/cold/audit/checks/record';
import { inStaging } from '../../../src/tools/cold/audit/checks/staging';
import { byWeight } from '../../../src/tools/cold/audit/checks/tars';
import { setYes } from '../../../src/tools/cold/options';
import { Archives } from '../../../src/tools/cold/shared/disk';
import * as record from '../../../src/tools/cold/shared/record';
import { backedUpIn } from '../../../src/tools/cold/shared/vault/ledger';
import type { DatabaseSync } from 'node:sqlite';
import type { Finding, Looking } from '../../../src/tools/cold/audit/types';
import type { CatalogPartition, Remote, VaultFile } from '../../../src/tools/cold/shared/types';
import type { ColdConfig, Origin } from '../../../src/tools/cold/types';

/**
 * The record held against Mega, the disk and itself: what each check finds, and
 * what its first answer does about it.
 */

let dir: string;
let db:  DatabaseSync;
let held: Map<string, { bytes: number; handle: string | null }>;
let removed: string[];

const config = (origin: Origin): ColdConfig => ({
  sourceRoot: path.join(dir, 'archives'), vaultRoot: path.join(dir, 'vault'), coldRoot: path.join(dir, 'cold'), megaRoot: `/x/${origin}`,
  backupRoot: '/x/cold', dbPath: path.join(dir, 'cold', 'cold.sqlite'), capBytes: 1e12, queueTargetGb: 10, settledHours: null,
  catalogUrl: 'http://catalog.test', catalogToken: 't',
});

const remote = (): Remote => ({
  queuedPaths: async () => new Set<string>(),
  queue:       async () => ({ remaining: 0, total: 0, uploaded: 0, transfers: 0 }),
  listing:     async () => held,
  queueUpload: async () => {},
  remove:      async (at) => { removed.push(at); },
});

const looking = (origin: Origin, mega: Remote | null = remote()): Looking =>
  ({ db, config: config(origin), origin, remote: mega, archives: new Archives(path.join(dir, 'archives')) });

const partition = (month: string): CatalogPartition => ({
  venue: 'gate', market: 'spot', dataset: 'trades', variant: '', grain: 'daily', bundle: 'instrument', month, files: 1, bytes: 2, version: 'v1',
});

/** A tar of one partition, stored: in the record, and in Mega unless told otherwise. */
const tar = (month: string, inMega = true): number => {
  const id = record.planTar(db, 'archives', 'gate', month, seq => ({ remote: `gate/${month}.${seq}.tar`, local: `gate/${month}.${seq}.tar` }), [partition(month)]);

  record.packed(db, id, 100);
  record.stored(db, id, `H${month}`);

  if (inMega) held.set(`gate/${month}.1.tar`, { bytes: 100, handle: `H${month}` });

  return id;
};

const SLICE = 'venue=gate/market=spot/dataset=trades';

/** A vault file of a month stored whole: in the ledger, in the record as stored, on disk and in Mega unless told otherwise. */
const vaultFile = (month: string, where: { mega?: boolean; disk?: boolean } = {}): VaultFile => {
  const file: VaultFile = { partition: `${SLICE}/${month}`, revision: 'r1', instrument: '@', side: '', path: `${SLICE}/@/${month}.parquet`, bytes: 10 };

  fs.mkdirSync(path.join(dir, 'vault', SLICE, '@'), { recursive: true });

  const ledger = path.join(dir, 'vault', 'ledger.csv');

  if (! fs.existsSync(ledger)) fs.writeFileSync(ledger, 'partition|venue|market|dataset|variant|grain|bundle|month|mode|version|preVersion|postVersion|revision|size|count|stockedAt\n');

  fs.appendFileSync(ledger, `${file.partition}|gate|spot|trades||daily|instrument|${month}|bundle|v1|||r1|10|1|T\n`);

  if (where.disk !== false) fs.writeFileSync(path.join(dir, 'vault', file.path), 'x'.repeat(10));

  record.planVaultFiles(db, [file]);
  record.moveVaultFile(db, file, 'stored', `V${month}`);
  record.storeVaultPartition(db, file.partition, file.revision);

  if (where.mega !== false) held.set(`gate/spot/trades/@/${month}.parquet`, { bytes: 10, handle: `V${month}` });

  return file;
};

/** Do the first thing a finding offers. */
const fix = async (finding: Finding | undefined): Promise<void> => { await finding!.solutions[0]!.apply(); };

beforeEach(() => {
  dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-audit-'));
  held    = new Map();
  removed = [];

  fs.mkdirSync(path.join(dir, 'cold'), { recursive: true });

  db = record.open(path.join(dir, 'cold', 'cold.sqlite'));
});

afterEach(() => {
  setYes(false);
  record.close(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the tars of the archives, against Mega', () => {
  it('finds nothing where every stored tar is there as it was sent', async () => {
    tar('202001');
    tar('202002');

    expect(await againstMega(looking('archives'))).toEqual([]);
  });

  it('finds a stored tar that is not there, and writes it down as one to send again', async () => {
    tar('202001');

    const id = tar('202002', false);
    const [finding, ...rest] = await againstMega(looking('archives'));

    expect(rest).toEqual([]);
    expect(finding!.problem).toMatch(/1 tar written down as stored is not in Mega/);
    expect(finding!.examples).toEqual(['gate/202002.1.tar']);

    await fix(finding);

    expect(record.tarById(db, id).state).toBe('planned');
    expect(await againstMega(looking('archives'))).toEqual([]);
  });

  /** Cold storage was the only copy: that has to be said before anything is chosen. */
  it('says so where what a missing tar held is no longer on disk', async () => {
    tar('202001', false);
    record.noteEviction(db, 'archives', partition('202001'), { files: 1, bytes: 2 });

    const [finding] = await againstMega(looking('archives'));

    expect(finding!.note).toMatch(/1 of their partitions have been taken off the disk/);
  });

  it('finds a tar that is not the size sent', async () => {
    tar('202001');
    held.set('gate/202001.1.tar', { bytes: 99, handle: 'H202001' });

    const [finding] = await againstMega(looking('archives'));

    expect(finding!.problem).toMatch(/not the size that was sent/);
  });

  it('finds a tar under another identifier, and writes the new one down', async () => {
    const id = tar('202001');

    held.set('gate/202001.1.tar', { bytes: 100, handle: 'OTHER' });

    const [finding] = await againstMega(looking('archives'));

    expect(finding!.problem).toMatch(/another identifier/);

    await fix(finding);

    expect(record.tarById(db, id)).toMatchObject({ state: 'stored', handle: 'OTHER' });
  });

  /** The one thing offered that touches Mega, and never the answer nobody gave. */
  it('finds a tar the record has never heard of, and removes it only when told to', async () => {
    tar('202001');
    held.set('gate/stray.tar', { bytes: 5, handle: 'S' });

    const [finding] = await againstMega(looking('archives'));

    expect(finding!.examples).toEqual(['gate/stray.tar']);
    expect(finding!.solutions[0]!.destructive).toBe(true);

    setYes(true);

    expect(await choiceOf(finding!.solutions)).toBeNull();
    expect(removed).toEqual([]);

    await fix(finding);

    expect(removed).toEqual(['/x/archives/gate/stray.tar']);
  });

  it('looks at nothing where Mega is not answering', async () => {
    tar('202001', false);

    expect(await againstMega(looking('archives', null))).toEqual([]);
  });
});

describe('the files of the vault, against Mega', () => {
  it('finds nothing where every stored file is there as it was sent', async () => {
    vaultFile('202001');

    expect(await againstMega(looking('vault'))).toEqual([]);
  });

  it('finds a stored file that is not there, and writes it and its partition down as not stored', async () => {
    const file = vaultFile('202001', { mega: false });
    const [finding] = await againstMega(looking('vault'));

    expect(finding!.examples).toEqual(['gate: spot/trades/202001']);

    await fix(finding);

    expect(record.vaultFilesOf(db, file.partition, 'r1')[0]!.state).toBe('planned');
    expect(record.vaultStored(db).size).toBe(0);
  });

  it('finds a file of the vault the record has never heard of', async () => {
    vaultFile('202001');
    held.set('gate/spot/trades/OLD/202001.parquet', { bytes: 3, handle: 'O' });

    const [finding] = await againstMega(looking('vault'));

    expect(finding!.examples).toEqual(['gate/spot/trades/OLD/202001.parquet']);
    expect(finding!.solutions[0]!.destructive).toBe(true);
  });
});

describe('the vault, against the disk', () => {
  it('finds a file written down as away that is there, and writes it down as back', async () => {
    const file = vaultFile('202001');

    record.noteVaultMoves(db, [file], 'evicted');

    const [finding] = await againstDisk(looking('vault'));

    expect(finding!.problem).toMatch(/written down as taken off the disk is on it/);
    expect(finding!.solutions.map(one => !! one.destructive)).toEqual([false, true]);

    await fix(finding);

    expect(record.vaultFilesOf(db, file.partition, 'r1')[0]!.evictedAt).toBeNull();
    expect(await againstDisk(looking('vault'))).toEqual([]);
  });

  it('finds a file written down as there that is away, and writes it down as taken off', async () => {
    const file = vaultFile('202001', { disk: false });
    const [finding] = await againstDisk(looking('vault'));

    expect(finding!.problem).toMatch(/written down as on the disk is not there/);

    await fix(finding);

    expect(record.vaultFilesOf(db, file.partition, 'r1')[0]!.evictedAt).not.toBeNull();
  });
});

describe('the archives, against the disk', () => {
  it('finds an evicted partition with files on disk, and writes it down as back', async () => {
    const one  = partition('202001');
    const file = path.join(dir, 'archives', 'gate/spot/trades/B/BTC_USDT/202001', 'gate|spot|trades|BTC_USDT|20200101.csv.gz');

    record.noteEviction(db, 'archives', one, { files: 1, bytes: 2 });

    expect(await againstDisk(looking('archives'))).toEqual([]);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'aa');

    const [finding] = await againstDisk(looking('archives'));

    expect(finding!.examples).toEqual(['gate|spot|trades|*|daily|202001']);

    await fix(finding);

    expect(record.evictedOf(db, 'archives', 'gate').size).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('the record, against itself', () => {
  it('finds a partition written down as whole that is not, and writes it down as not whole', async () => {
    const file = vaultFile('202001');

    record.moveVaultFile(db, file, 'planned');

    const findings = await withinItself(looking('vault'));
    const finding  = findings.find(one => /not have every file stored/.test(one.problem));

    await fix(finding);

    expect(record.vaultStored(db).size).toBe(0);
  });

  it('finds a stored partition the vault was not told has a copy, and tells it', async () => {
    const file = vaultFile('202001');
    const [finding] = await withinItself(looking('vault'));

    expect(finding!.problem).toMatch(/not in the vault's list of what has a copy/);

    await fix(finding);

    expect(backedUpIn(path.join(dir, 'vault')).get(file.partition)?.has('r1')).toBe(true);
    expect(await withinItself(looking('vault'))).toEqual([]);
  });

  it('finds a lock whose holder is gone, and removes it', async () => {
    const lock = path.join(dir, 'cold', 'cold.archives.push.lock');

    fs.writeFileSync(lock, 'pid 2147483646 since T\n');

    const [finding] = await withinItself(looking('archives'));

    await fix(finding);

    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('a vault partition a push left a step short', () => {
  it('is found, written down as whole, and the vault told', async () => {
    const file = vaultFile('202001');

    db.prepare('DELETE FROM vault_partition').run();

    const finding = (await withinItself(looking('vault'))).find(one => /every file stored and is not written down as whole/.test(one.problem));

    expect(finding!.examples).toEqual(['gate: spot/trades/202001']);

    await fix(finding);

    expect(record.vaultStored(db).get(file.partition)?.has('r1')).toBe(true);
    expect(backedUpIn(path.join(dir, 'vault')).get(file.partition)?.has('r1')).toBe(true);
    expect(await withinItself(looking('vault'))).toEqual([]);
  });
});

describe('what is left in staging', () => {
  const staged = (name: string, members: Record<string, string> = {}): string => {
    const file = path.join(dir, 'cold', 'archives', 'gate', name);
    const from = path.join(dir, 'src');

    fs.mkdirSync(path.dirname(file), { recursive: true });

    for (const [member, text] of Object.entries(members)) {
      fs.mkdirSync(path.dirname(path.join(from, member)), { recursive: true });
      fs.writeFileSync(path.join(from, member), text);
    }

    fs.mkdirSync(from, { recursive: true });
    execFileSync('tar', ['-cf', file, '-C', from, ...Object.keys(members)].concat(Object.keys(members).length ? [] : ['-T', '/dev/null']));

    return file;
  };

  const member = (month: string): string => `gate/spot/trades/B/BTC_USDT/${month}/gate|spot|trades|BTC_USDT|${month}01.csv.gz`;

  /** A packed tar, in the record and in staging under the path the record gives it. */
  const packed = (month: string, members: Record<string, string>): { id: number; file: string } => {
    const id = record.planTar(db, 'archives', 'gate', month, seq => ({ remote: `gate/${month}.${seq}.tar`, local: `gate/${month}.${seq}.tar` }), [partition(month)]);

    record.packed(db, id, 100);

    return { id, file: staged(`${month}.1.tar`, members) };
  };

  it('finds nothing where a tar on its way holds what the record says', async () => {
    packed('202001', { [member('202001')]: 'aa' });

    expect(await inStaging(looking('archives'))).toEqual([]);
  });

  /** The one place a tar can be opened without bringing it back. */
  it('finds a tar that does not hold what the record says, and has it packed again', async () => {
    const { id, file } = packed('202001', { [member('202001')]: 'aaaa' });

    const [finding] = await inStaging(looking('archives'));

    expect(finding!.problem).toMatch(/does not hold what the record says/);

    await fix(finding);

    expect(fs.existsSync(file)).toBe(false);
    expect(record.tarById(db, id).state).toBe('planned');
  });

  it('finds a tar still in staging after it was stored, and one the record has never heard of', async () => {
    const { id, file } = packed('202001', { [member('202001')]: 'aa' });

    record.stored(db, id, 'H');

    const stray = staged('stray.tar');
    const [stored, unknown] = await inStaging(looking('archives'));

    expect(stored!.problem).toMatch(/already stored in Mega/);
    expect(stored!.solutions[0]!.destructive).toBeFalsy();
    expect(unknown!.problem).toMatch(/not in the record/);
    expect(unknown!.solutions[0]!.destructive).toBe(true);

    await fix(stored);

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('finds what a pull that stopped left behind', async () => {
    const left = path.join(dir, 'cold', 'pulling', 'archives', 'gate', 'half.tar');

    fs.mkdirSync(path.dirname(left), { recursive: true });
    fs.writeFileSync(left, 'x');

    const [finding] = await inStaging(looking('archives'));

    await fix(finding);

    expect(fs.existsSync(left)).toBe(false);
  });

  /** What is there then is that command's, half way through. */
  it('looks at nothing while another command is running', async () => {
    staged('stray.tar');
    fs.writeFileSync(path.join(dir, 'cold', 'cold.archives.push.lock'), `pid ${process.ppid} since T\n`);

    expect(await inStaging(looking('archives'))).toEqual([]);
  });
});

describe('what each stored tar weighs', () => {
  const file = (month: string): string => path.join(dir, 'archives', `gate/spot/trades/B/BTC_USDT/${month}`, `gate|spot|trades|BTC_USDT|${month}01.csv.gz`);

  /** A stored tar of one partition whose file is on disk, written down at the size given. */
  const weighed = (month: string, bytes: number): number => {
    const id = record.planTar(db, 'archives', 'gate', month, seq => ({ remote: `gate/${month}.${seq}.tar`, local: `gate/${month}.${seq}.tar` }), [partition(month)]);

    fs.mkdirSync(path.dirname(file(month)), { recursive: true });
    fs.writeFileSync(file(month), 'aa');

    record.packed(db, id, bytes);
    record.stored(db, id, 'H');

    return id;
  };

  /** One member of two bytes: a header, a block of content, the end, and all of it rounded up to a tar's blocking. */
  it('finds nothing where a tar is the size its files make', async () => {
    weighed('202001', 10_240);

    expect(await byWeight(looking('archives'))).toEqual([]);
  });

  it('finds a tar that is not, to the byte, where its partitions are on disk — and has it sent again', async () => {
    const id = weighed('202001', 20_480);
    const [finding] = await byWeight(looking('archives'));

    expect(finding!.problem).toMatch(/not the size the files of its partitions make/);

    await fix(finding);

    expect(record.tarById(db, id).state).toBe('planned');
  });

  /** Its files are gone, so only how many there were and what they weighed is known: a range, and nothing to pack again from. */
  it('holds a tar whose partitions have left the disk to what they allow, and offers nothing', async () => {
    weighed('202001', 10_240);
    weighed('202002', 5_000_000);

    fs.rmSync(path.join(dir, 'archives'), { recursive: true });

    const [finding, ...rest] = await byWeight(looking('archives'));

    expect(rest).toEqual([]);
    expect(finding!.examples).toHaveLength(1);
    expect(finding!.examples[0]).toMatch(/^gate\/202002\.1\.tar/);
    expect(finding!.solutions).toEqual([]);
  });
});

describe('what is done where nobody is asked', () => {
  const solution = (label: string, destructive = false) => ({ label, destructive, apply: () => {} });

  it('is the first thing offered, unless that removes something', async () => {
    setYes(true);

    expect((await choiceOf([solution('write it down')]))?.label).toBe('write it down');
    expect((await choiceOf([solution('write it down'), solution('remove it', true)]))?.label).toBe('write it down');
    expect(await choiceOf([solution('remove it', true)])).toBeNull();
    expect(await choiceOf([])).toBeNull();
  });
});
