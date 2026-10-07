import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _test_byVenue as byVenue, _test_evictable as evictable, _test_remove as remove } from '../../../src/tools/cold/evict-vault';
import { _test_fetch as fetch, _test_pullable as pullable } from '../../../src/tools/cold/pull-vault';
import { _test_plan as plan, _test_round as round } from '../../../src/tools/cold/push-vault';
import * as record from '../../../src/tools/cold/record';
import { meansPartition, meansToEvict, meansToPull } from '../../../src/tools/cold/select';
import { backedUpIn, filesOf, remoteOf, stockedIn } from '../../../src/tools/cold/vault';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Fetching, Remote, Selection } from '../../../src/tools/cold/types';

/**
 * The vault in cold storage: stored a partition at a time, as the files it is,
 * and moved out and brought back a file at a time.
 */

let dir:  string;
let db:   DatabaseSync;
let sent: Map<string, number>;
let gone: string[];
let line: string[];

const GB = 1024 ** 3;

const SMALL = 'venue=gate/market=spot/dataset=klines/interval=1h';
const LARGE = 'venue=gate/market=perp/dataset=trades/aggregated=false';

const config = (): ColdConfig => ({
  sourceRoot: path.join(dir, 'vault'), vaultRoot: path.join(dir, 'vault'), coldRoot: dir, megaRoot: '/Mega/vault',
  dbPath: path.join(dir, 'cold.sqlite'), capBytes: 5 * GB, queueTargetGb: 10, settledHours: null,
  catalogUrl: 'http://catalog.test', catalogToken: 't',
});

/** A file of the vault, of this many bytes. */
const onDisk = (relative: string, bytes: number): void => {
  fs.mkdirSync(path.dirname(path.join(dir, 'vault', relative)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vault', relative), 'x'.repeat(bytes));
};

/** A line of the ledger, and the files it says the vault holds. */
const stock = (slice: string, month: string, revision: string, instruments: string[] | null, sides: string[] = []): void => {
  const files = (instruments ?? ['@']).flatMap(instrument => ['', ...sides].map(side => [instrument, side] as const));

  for (const [instrument, side] of files) onDisk(`${slice}/${instrument}/${month}${side ? `.${side}` : ''}.parquet`, 10);

  const file = path.join(dir, 'vault', 'ledger.csv');
  const head = 'partition|venue|market|dataset|variant|grain|bundle|month|mode|version|preVersion|postVersion|revision|size|count|stockedAt';

  if (! fs.existsSync(file)) fs.writeFileSync(file, `${head}\n`);

  fs.appendFileSync(file, [
    `${slice}/${month}`, 'gate', 'spot', 'x', '', 'daily', 'instrument', month, instruments ? 'split' : 'bundle',
    'v1', '', '', revision, files.length * 10, files.length, 'T',
  ].join('|') + '\n');
};

/** Mega, as far as storing asks of it: what it holds is what was handed over, once `arrive` says so. */
const mega = (waiting = 0): Remote & { queued: Set<string>; arrive: () => void } => {
  const queued = new Set<string>();
  const local  = new Map<string, string>();

  return {
    queued,
    arrive: () => {
      for (const one of queued) sent.set(local.get(one)!, fs.statSync(one).size);

      queued.clear();
    },
    queuedPaths: async () => new Set(queued),
    queue:       async () => ({ remaining: waiting, total: waiting, uploaded: 0, transfers: 0 }),
    listing:     async (root: string) => new Map([...sent]
      .filter(([key]) => key.startsWith(`${root}/`))
      .map(([key, bytes]) => [key.slice(root.length + 1), { bytes, handle: `H:${key.length}` }])),
    queueUpload: async (file: string, remoteDir: string) => {
      queued.add(file);
      local.set(file, `${remoteDir}/${path.basename(file)}`);
    },
    remove: async (remotePath: string) => {
      gone.push(remotePath);
      sent.delete(remotePath);
    },
  };
};

/** Plan, hand over, let Mega take it, and confirm: everything the ledger holds is stored. */
const storeAll = async (): Promise<void> => {
  const remote = mega();

  plan(db, config(), []);

  await round(db, config(), record.vaultFilesPending(db), remote, said => line.push(said));

  remote.arrive();

  await round(db, config(), record.vaultFilesPending(db), remote, said => line.push(said));
};

const all: Selection = { venues: [], instruments: [] };

beforeEach(() => {
  dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-vault-'));
  db   = record.open(path.join(dir, 'cold.sqlite'));
  sent = new Map();
  gone = [];
  line = [];

  stock(SMALL, '202001', 'aaaaaaaaaaaa', null);
  stock(LARGE, '202001', 'bbbbbbbbbbbb', ['BTC_USDT', 'ETH_USDT']);
});

afterEach(() => {
  record.close(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the vault\'s files', () => {
  it('are one for a partition stored whole, and one an instrument for one stored per instrument', () => {
    const [small, large] = stockedIn(config().vaultRoot)!;

    expect(filesOf(config().vaultRoot, small!)).toEqual([{
      partition: `${SMALL}/202001`, revision: 'aaaaaaaaaaaa', instrument: '@', side: '',
      path: `${SMALL}/@/202001.parquet`, bytes: 10,
    }]);
    expect(filesOf(config().vaultRoot, large!)!.map(file => file.instrument)).toEqual(['BTC_USDT', 'ETH_USDT']);
  });

  it('are nothing where the vault does not hold what the ledger says', () => {
    fs.rmSync(path.join(dir, 'vault', LARGE, 'ETH_USDT'), { recursive: true });

    expect(filesOf(config().vaultRoot, stockedIn(config().vaultRoot)![1]!)).toBeNull();
  });

  /** The values without the names, and the variants joined to the dataset: one depth for every file. */
  it('sit in cold storage at a path of values, the same depth whatever the dataset has', () => {
    const [small, large] = stockedIn(config().vaultRoot)!.map(one => filesOf(config().vaultRoot, one)![0]!);

    expect(remoteOf(small!)).toBe('gate/spot/klines,1h/@/202001.parquet');
    expect(remoteOf(large!)).toBe('gate/perp/trades/BTC_USDT/202001.parquet');

    // Trades with no variant are every trade, and say nothing more; a venue's aggregation of them is named.
    expect(remoteOf({ partition: 'venue=binance/market=spot/dataset=trades/aggregated=true/202001', instrument: '@', path: 'x/@/202001.parquet' }))
      .toBe('binance/spot/trades,aggregated/@/202001.parquet');
  });
});

describe('storing the vault', () => {
  it('plans every partition the record does not have stored, with its files', () => {
    const planned = plan(db, config(), []);

    expect([...planned.venues]).toEqual([['gate', { partitions: 2, files: 3, bytes: 30 }]]);
    expect(record.vaultFilesPending(db).map(file => `${file.instrument} ${file.state}`))
      .toEqual(['@ planned', 'BTC_USDT planned', 'ETH_USDT planned']);
  });

  it('plans nothing twice, and nothing for a venue that was not asked for', () => {
    plan(db, config(), []);
    plan(db, config(), []);

    expect(record.vaultFilesPending(db)).toHaveLength(3);
    expect([...plan(db, config(), ['htx']).venues]).toEqual([['htx', { partitions: 0, files: 0, bytes: 0 }]]);
  });

  it('leaves out a partition the vault does not hold as its ledger says', () => {
    fs.rmSync(path.join(dir, 'vault', LARGE, 'ETH_USDT'), { recursive: true });

    expect(plan(db, config(), [])).toMatchObject({ skipped: 1 });
    expect(record.vaultFilesPending(db)).toHaveLength(1);
  });

  it('hands each file to Mega at the path that says what it is', async () => {
    const remote = mega();

    plan(db, config(), []);

    expect(await round(db, config(), record.vaultFilesPending(db), remote, () => {})).toBe(true);

    remote.arrive();

    expect([...sent.keys()].sort()).toEqual([
      '/Mega/vault/gate/perp/trades/BTC_USDT/202001.parquet',
      '/Mega/vault/gate/perp/trades/ETH_USDT/202001.parquet',
      '/Mega/vault/gate/spot/klines,1h/@/202001.parquet',
    ]);
  });

  /** Confirmed from Mega's own listing, at the size the file has on disk. */
  it('takes a partition as stored only once every file of it is in Mega at its size', async () => {
    const remote = mega();

    plan(db, config(), []);

    await round(db, config(), record.vaultFilesPending(db), remote, () => {});

    expect(record.vaultStored(db).size).toBe(0);

    // One of the large partition's two files arrives; the small partition's one does. The other is dropped.
    remote.queued.clear();
    sent.set('/Mega/vault/gate/perp/trades/BTC_USDT/202001.parquet', 10);
    sent.set('/Mega/vault/gate/spot/klines,1h/@/202001.parquet', 10);

    await round(db, config(), record.vaultFilesPending(db), remote, said => line.push(said));

    expect([...record.vaultStored(db).keys()]).toEqual([`${SMALL}/202001`]);
    // Named as a person reads it, without the names the vault's path carries for a query engine.
    expect(line).toEqual([expect.stringContaining('Stored gate/spot/klines,1h/202001 · 1 file')]);
  });

  it('does not take a file of another size for the file', async () => {
    const remote = mega();

    plan(db, config(), []);

    await round(db, config(), record.vaultFilesPending(db), remote, () => {});

    remote.queued.clear();
    sent.set('/Mega/vault/gate/spot/klines,1h/@/202001.parquet', 9);

    await round(db, config(), record.vaultFilesPending(db), remote, () => {});

    expect(record.vaultStored(db).size).toBe(0);
  });

  /** What says a safe copy exists, to whoever stocks the vault. */
  it('writes each partition stored into the vault\'s backedup.csv', async () => {
    await storeAll();

    expect([...backedUpIn(config().vaultRoot)].map(([partition, revisions]) => [partition, [...revisions]])).toEqual([
      [`${SMALL}/202001`, ['aaaaaaaaaaaa']],
      [`${LARGE}/202001`, ['bbbbbbbbbbbb']],
    ]);
  });

  it('writes it again where the record has a partition stored and the vault was never told', async () => {
    await storeAll();

    fs.rmSync(path.join(dir, 'vault', 'backedup.csv'));

    plan(db, config(), []);

    expect(backedUpIn(config().vaultRoot).size).toBe(2);
  });

  it('hands over no more than the queue has room for', async () => {
    const remote = mega(10 * GB);

    plan(db, config(), []);

    expect(await round(db, config(), record.vaultFilesPending(db), remote, () => {})).toBe(false);
    expect(remote.queued.size).toBe(0);
  });

  /** Mega's queue outlives the command: what it dropped without storing is handed over again. */
  it('hands over again a file that left the queue without arriving', async () => {
    const remote = mega();

    plan(db, config(), []);

    await round(db, config(), record.vaultFilesPending(db), remote, () => {});

    remote.queued.clear();

    await round(db, config(), record.vaultFilesPending(db), remote, () => {});

    expect(remote.queued.size).toBe(3);
  });

  /**
   * Every revision of a file is stored at one path, so what Mega holds there
   * beforehand may be the month this one replaces. It is Mega's to find it is
   * the same file, and it does so without sending it again.
   */
  it('hands over a file Mega already holds at that path, and takes it as stored only after', async () => {
    const remote = mega();

    plan(db, config(), []);
    sent.set('/Mega/vault/gate/spot/klines,1h/@/202001.parquet', 10);

    await round(db, config(), record.vaultFilesPending(db), remote, () => {});

    expect([...remote.queued].some(one => one.includes('klines'))).toBe(true);
    expect(record.vaultStored(db).size).toBe(0);

    remote.arrive();

    await round(db, config(), record.vaultFilesPending(db), remote, () => {});

    expect(record.vaultStored(db).has(`${SMALL}/202001`)).toBe(true);
  });

  /** The same paths with other contents: every file is sent again, and nothing of it is removed. */
  it('stores a partition stocked again over the revision it replaces', async () => {
    await storeAll();

    stock(SMALL, '202001', 'cccccccccccc', null);

    const remote = mega();

    plan(db, config(), []);

    await round(db, config(), record.vaultFilesPending(db), remote, () => {});

    expect([...remote.queued].some(one => one.includes('klines'))).toBe(true);
    expect([...record.vaultStored(db).get(`${SMALL}/202001`)!]).toEqual(['aaaaaaaaaaaa']);

    remote.arrive();

    await round(db, config(), record.vaultFilesPending(db), remote, () => {});

    expect(gone).toEqual([]);
    expect([...record.vaultStored(db).get(`${SMALL}/202001`)!]).toEqual(['cccccccccccc']);
    expect(record.vaultFiles(db).filter(file => file.partition.startsWith(SMALL)).map(file => file.revision)).toEqual(['cccccccccccc']);
  });

  /** An instrument the month no longer holds is the one thing the new revision does not write over. */
  it('removes from cold storage what the replaced revision had and the new one has not', async () => {
    await storeAll();

    fs.rmSync(path.join(dir, 'vault', LARGE, 'ETH_USDT'), { recursive: true });
    stock(LARGE, '202001', 'dddddddddddd', ['BTC_USDT']);

    const remote = mega();

    plan(db, config(), []);

    await round(db, config(), record.vaultFilesPending(db), remote, () => {});

    expect(gone).toEqual([]);

    remote.arrive();

    await round(db, config(), record.vaultFilesPending(db), remote, () => {});

    expect(gone).toEqual(['/Mega/vault/gate/perp/trades/ETH_USDT/202001.parquet']);
    expect([...record.vaultStored(db).get(`${LARGE}/202001`)!]).toEqual(['dddddddddddd']);
  });

  /** What a neighbouring month held of it is a file of the partition like any other. */
  it('stores the files of a neighbouring month\'s hours with the month\'s own', async () => {
    stock(SMALL, '202002', 'eeeeeeeeeeee', null, ['post']);

    await storeAll();

    expect(sent.has('/Mega/vault/gate/spot/klines,1h/@/202002.post.parquet')).toBe(true);
    expect(record.vaultFilesOf(db, `${SMALL}/202002`, 'eeeeeeeeeeee').map(file => file.side)).toEqual(['', 'post']);
  });

  /** Its files are some of one build and some of another: not a partition to store. */
  it('plans nothing of a partition whose files are being changed', () => {
    stock(SMALL, '202001', 'updating', null);

    plan(db, config(), []);

    expect(record.vaultFilesPending(db).filter(file => file.partition.startsWith(SMALL))).toEqual([]);
  });

  it('forgets what it planned for a revision the ledger moved on from before it was sent', () => {
    plan(db, config(), []);

    stock(SMALL, '202001', 'cccccccccccc', null);

    plan(db, config(), []);

    expect(record.vaultFilesPending(db).filter(file => file.partition.startsWith(SMALL)).map(file => file.revision))
      .toEqual(['cccccccccccc']);
  });
});

describe('which of the vault a selection means', () => {
  const klines = `${SMALL}/202001`;
  const trades = `${LARGE}/202001`;

  it('narrows by venue, market, dataset, variant and months', () => {
    expect(meansPartition({ ...all, venues: ['gate'] }, klines)).toBe(true);
    expect(meansPartition({ ...all, venues: ['htx'] }, klines)).toBe(false);
    expect(meansPartition({ ...all, market: 'perp' }, klines)).toBe(false);
    expect(meansPartition({ ...all, dataset: 'KLINES' }, klines)).toBe(true);
    expect(meansPartition({ ...all, variant: '1h' }, klines)).toBe(true);
    expect(meansPartition({ ...all, variant: '1m' }, klines)).toBe(false);
    expect(meansPartition({ ...all, variant: '1h' }, trades)).toBe(false);
    expect(meansPartition({ ...all, from: '202001', to: '202001' }, klines)).toBe(true);
    expect(meansPartition({ ...all, from: '202002' }, klines)).toBe(false);
    expect(meansPartition({ ...all, to: '201912' }, klines)).toBe(false);
  });

  /** Taking a whole month away for the sake of one instrument would take the rest with it. */
  it('takes away only an instrument\'s own file where instruments are named', () => {
    const one = { ...all, instruments: ['btc_usdt'] };

    expect(meansToEvict(one, trades, 'BTC_USDT')).toBe(true);
    expect(meansToEvict(one, trades, 'ETH_USDT')).toBe(false);
    expect(meansToEvict(one, klines, '@')).toBe(false);
    expect(meansToEvict(all, klines, '@')).toBe(true);
  });

  /** A small month is one file: an instrument's rows are nowhere else. */
  it('brings back the file of a month stored whole where one of its instruments is asked for', () => {
    const one = { ...all, instruments: ['BTC_USDT'] };

    expect(meansToPull(one, trades, 'BTC_USDT')).toBe(true);
    expect(meansToPull(one, trades, 'ETH_USDT')).toBe(false);
    expect(meansToPull(one, klines, '@')).toBe(true);
  });
});

describe('moving vault files out', () => {
  const going = (selection: Selection = all): string[] =>
    evictable(db, config(), selection).map(file => `${file.partition.split('/').slice(2).join('/')} ${file.instrument}`);

  it('takes nothing that is not in cold storage', () => {
    plan(db, config(), []);

    expect(going()).toEqual([]);
  });

  it('takes any file of a partition that is stored', async () => {
    await storeAll();

    expect(going()).toEqual([
      'dataset=trades/aggregated=false/202001 BTC_USDT', 'dataset=trades/aggregated=false/202001 ETH_USDT', 'dataset=klines/interval=1h/202001 @',
    ]);
    expect(going({ ...all, instruments: ['ETH_USDT'] })).toEqual(['dataset=trades/aggregated=false/202001 ETH_USDT']);
    expect(going({ ...all, dataset: 'klines' })).toEqual(['dataset=klines/interval=1h/202001 @']);
  });

  /** Stocked again since: what is stored is not what the vault holds now. */
  it('takes nothing of a partition stocked again since it was stored', async () => {
    await storeAll();

    stock(SMALL, '202001', 'cccccccccccc', null);

    expect(going({ ...all, dataset: 'klines' })).toEqual([]);
  });

  /** Listed while it was what cold storage holds, and stocked again before its turn came. */
  it('leaves on disk a partition stocked again between being listed and its turn', async () => {
    await storeAll();

    const files = evictable(db, config(), { ...all, dataset: 'klines' });

    stock(SMALL, '202001', 'updating', null);

    await remove(db, config(), 'gate', files, true);

    expect(fs.existsSync(path.join(dir, 'vault', SMALL, '@', '202001.parquet'))).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM vault_move').get()).toEqual({ n: 0 });
  });

  /** Rows as the record gives them, of more than one venue: what a run over the real vault is. */
  it('groups what can go by venue, in venue order', async () => {
    stock('venue=bybit/market=perp/dataset=trades/aggregated=false', '202001', 'ffffffffffff', null);

    await storeAll();

    expect([...byVenue(evictable(db, config(), all)).keys()]).toEqual(['bybit', 'gate']);
  });

  it('removes the files, writes down that they are away, and offers them no more', async () => {
    await storeAll();

    const files = evictable(db, config(), { ...all, instruments: ['BTC_USDT'] });

    await remove(db, config(), 'gate', files, true);

    expect(fs.existsSync(path.join(dir, 'vault', LARGE, 'BTC_USDT'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'vault', LARGE, 'ETH_USDT', '202001.parquet'))).toBe(true);
    expect(going()).toEqual(['dataset=trades/aggregated=false/202001 ETH_USDT', 'dataset=klines/interval=1h/202001 @']);
    expect(db.prepare('SELECT instrument, action FROM vault_move').all()).toEqual([{ instrument: 'BTC_USDT', action: 'evicted' }]);
  });

  /** Nothing is written into the vault when a file leaves: that it has a safe copy was said when it was stored. */
  it('writes nothing into the vault', async () => {
    await storeAll();

    const before = fs.readdirSync(path.join(dir, 'vault')).sort();

    await remove(db, config(), 'gate', evictable(db, config(), { ...all, dataset: 'klines' }), true);

    expect(fs.readdirSync(path.join(dir, 'vault')).sort()).toEqual(before);
  });
});

describe('bringing vault files back', () => {
  /** Mega, as far as fetching asks of it: a file asked for is there by the next look. */
  const fetching = (deliver = true): Fetching & { asked: string[] } => {
    const asked: string[] = [];

    return {
      asked,
      downloadingPaths: async () => new Set<string>(),
      queueDownload: async (remotePath: string, localDir: string) => {
        asked.push(remotePath);

        if (deliver) fs.writeFileSync(path.join(localDir, path.basename(remotePath)), 'x'.repeat(10));
      },
    };
  };

  const away = (selection: Selection = all): string[] => pullable(db, config(), selection).map(file => file.instrument);

  beforeEach(async () => {
    await storeAll();
    await remove(db, config(), 'gate', evictable(db, config(), all), true);
  });

  it('means what is away, and nothing that is here', async () => {
    expect(away()).toEqual(['BTC_USDT', 'ETH_USDT', '@']);
    expect(away({ ...all, dataset: 'trades', instruments: ['ETH_USDT'] })).toEqual(['ETH_USDT']);
    expect(away({ ...all, instruments: ['ETH_USDT'] })).toEqual(['ETH_USDT', '@']);
  });

  it('asks Mega for each file where it is stored, and puts it where it was', async () => {
    const remote = fetching();

    expect(await fetch(db, config(), pullable(db, config(), { ...all, dataset: 'trades' }), remote, 1)).toBe(0);

    expect(remote.asked.sort()).toEqual([
      '/Mega/vault/gate/perp/trades/BTC_USDT/202001.parquet',
      '/Mega/vault/gate/perp/trades/ETH_USDT/202001.parquet',
    ]);
    expect(fs.existsSync(path.join(dir, 'vault', LARGE, 'BTC_USDT', '202001.parquet'))).toBe(true);
    expect(away()).toEqual(['@']);
    expect(db.prepare(`SELECT count(*) AS n FROM vault_move WHERE action = 'restored'`).get()).toEqual({ n: 2 });
  });

  /** Put back by an earlier run that was stopped before it wrote so. */
  it('writes down as back a file that is already there, without asking for it', async () => {
    onDisk(`${SMALL}/@/202001.parquet`, 10);

    const remote = fetching();

    await fetch(db, config(), pullable(db, config(), { ...all, dataset: 'klines' }), remote, 1);

    expect(remote.asked).toEqual([]);
    expect(away({ ...all, dataset: 'klines' })).toEqual([]);
  });

  it('gives up on a file that never comes, and says how many', async () => {
    const remote = fetching(false);

    expect(await fetch(db, config(), pullable(db, config(), { ...all, dataset: 'klines' }), remote, 1)).toBe(1);
    expect(remote.asked).toHaveLength(3);
    expect(away({ ...all, dataset: 'klines' })).toEqual(['@']);
  });

  it('does not bring back a file of a revision the vault has since restocked', async () => {
    stock(SMALL, '202001', 'cccccccccccc', null);

    expect(away({ ...all, dataset: 'klines' })).toEqual([]);
  });
});
