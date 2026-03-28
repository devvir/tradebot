import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { bootstrap, register, list } from '../src/store.js';

const dataPath = join(tmpdir(), `registry-store-test-${process.pid}`);

mkdirSync(dataPath, { recursive: true });
process.env['REGISTRY_DATA_PATH'] = dataPath;

describe('register', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(process.env['DB_URL']!);
    await client.connect();
    db = client.db('test_registry_store');
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  beforeEach(async () => {
    await db.collection('symbols').deleteMany({});
    await db.collection('currencies').deleteMany({});
    await db.collection('_counters').deleteMany({});
  });

  it('assigns id 0 to the first symbol', async () => {
    const entry = await register(db, 'symbols', 'XBTUSD');

    expect(entry._id).toBe(0);
    expect(entry.value).toBe('XBTUSD');
  });

  it('assigns incrementing ids to subsequent symbols', async () => {
    const a = await register(db, 'symbols', 'XBTUSD');
    const b = await register(db, 'symbols', 'ETHUSD');
    const c = await register(db, 'symbols', '.BXBT');

    expect(a._id).toBe(0);
    expect(b._id).toBe(1);
    expect(c._id).toBe(2);
  });

  it('is idempotent — returns the same id for an existing symbol', async () => {
    const first  = await register(db, 'symbols', 'XBTUSD');
    const second = await register(db, 'symbols', 'XBTUSD');

    expect(first._id).toBe(second._id);
  });

  it('symbols and currencies have independent id sequences', async () => {
    await register(db, 'symbols', 'XBTUSD');
    await register(db, 'symbols', 'ETHUSD');
    const currency = await register(db, 'currencies', 'XBT');

    expect(currency._id).toBe(0);
  });

  it('writes symbols.json snapshot after new registration', async () => {
    await register(db, 'symbols', 'XBTUSD');

    const file = join(dataPath, 'symbols.json');

    expect(existsSync(file)).toBe(true);

    const data = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ id: number; symbol: string }>;

    expect(data).toHaveLength(1);
    expect(data[0]!.id).toBe(0);
    expect(data[0]!.symbol).toBe('XBTUSD');
  });

  it('snapshot grows with each new entry', async () => {
    await register(db, 'symbols', 'XBTUSD');
    await register(db, 'symbols', 'ETHUSD');

    const data = JSON.parse(readFileSync(join(dataPath, 'symbols.json'), 'utf-8')) as unknown[];

    expect(data).toHaveLength(2);
  });

  it('does not rewrite snapshot when registering an existing symbol', async () => {
    await register(db, 'symbols', 'XBTUSD');

    const file     = join(dataPath, 'symbols.json');
    const mtBefore = (await import('node:fs')).statSync(file).mtimeMs;

    await new Promise((r) => setTimeout(r, 10));
    await register(db, 'symbols', 'XBTUSD');

    const mtAfter = (await import('node:fs')).statSync(file).mtimeMs;

    expect(mtAfter).toBe(mtBefore);
  });
});

describe('list', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(process.env['DB_URL']!);
    await client.connect();
    db = client.db('test_registry_list');
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('returns entries sorted by id ascending', async () => {
    await register(db, 'symbols', 'XBTUSD');
    await register(db, 'symbols', 'ETHUSD');
    await register(db, 'symbols', '.BXBT');

    const entries = await list(db, 'symbols');

    expect(entries.map((e) => e._id)).toEqual([0, 1, 2]);
  });
});

describe('bootstrap', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(process.env['DB_URL']!);
    await client.connect();
    db = client.db('test_registry_bootstrap');

    writeFileSync(
      join(dataPath, 'symbols.json'),
      JSON.stringify([{ id: 0, symbol: 'XBTUSD' }, { id: 1, symbol: 'ETHUSD' }], null, 2),
    );
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('seeds DB from snapshot file when collection is empty', async () => {
    await bootstrap(db);

    const entries = await list(db, 'symbols');

    expect(entries).toHaveLength(2);
    expect(entries[0]!.value).toBe('XBTUSD');
    expect(entries[1]!.value).toBe('ETHUSD');
  });

  it('next id after bootstrap continues from max+1', async () => {
    const entry = await register(db, 'symbols', 'LTCUSD');

    expect(entry._id).toBe(2);
  });

  it('skips bootstrap when collection already has data', async () => {
    const countBefore = await db.collection('symbols').countDocuments();

    await bootstrap(db);

    const countAfter = await db.collection('symbols').countDocuments();

    expect(countAfter).toBe(countBefore);
  });

  it('handles missing snapshot file gracefully', async () => {
    await db.collection('currencies').deleteMany({});

    await expect(bootstrap(db)).resolves.toBeUndefined();

    const entries = await list(db, 'currencies');

    expect(entries).toHaveLength(0);
  });
});
