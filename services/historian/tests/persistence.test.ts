// Pending Review
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { saveState, loadAllStates, createPersistenceService } from '../src/persistence/index.js';
import { PAGE_SIZE } from '../src/utils/tables.js';
import type { TableConfig } from '../src/types.js';
import type { HistoryState } from '../src/persistence/index.js';

const mongoUrl = process.env.MONGODB_URL!;

// ── Test fixtures ──────────────────────────────────────────────────────────────

const KEYED_TABLE: TableConfig = {
  name: 'chat',
  path: '/chat',
  auth: false,
  symbolSource: null,
  idFields: ['id'],
  maxStart: null,
};

const KEYLESS_TABLE: TableConfig = {
  name: 'quote',
  path: '/quote',
  auth: false,
  symbolSource: 'instruments',
  idFields: null,
  maxStart: null,
};

const MULTI_KEY_TABLE: TableConfig = {
  name: 'funding',
  path: '/funding',
  auth: false,
  symbolSource: null,
  idFields: ['timestamp', 'symbol'],
  maxStart: null,
};

// maxStart=1000 → threshold zone when start > 0. Used for block transition tests.
const BLOCK_TABLE: TableConfig = {
  name: 'block_test',
  path: '/trade',
  auth: false,
  symbolSource: null,
  idFields: ['id'],
  maxStart: 1000,
};

const T1 = '2020-01-01T00:00:00.000Z';
const T2 = '2020-01-01T00:00:01.000Z';

const makeState = (overrides: Partial<HistoryState> = {}): HistoryState => ({
  _id: 'chat',
  start: 0,
  lastFetchedAt: new Date('2024-01-01T00:00:00.000Z'),
  totalFetched: 0,
  firstTimestamp: '2020-01-01T00:00:00.000Z',
  block: 0,
  blockStartTime: null,
  lastSeenTimestamp: null,
  ...overrides,
});

const makeRows = (count: number, startId = 1) =>
  Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    timestamp: `2020-01-01T00:00:${String(startId + i).padStart(2, '0')}.000Z`,
    text: `row ${startId + i}`,
  }));

// ── Keyed table (upsert by idFields) ─────────────────────────────────────────

describe('persist.write (keyed table — upsert by idFields)', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db('test_persistence_keyed');
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  beforeEach(async () => {
    await db.collection('chat').deleteMany({});
    await db.collection('_state').deleteMany({});
  });

  it('writes documents with _seq starting at state.start', async () => {
    const rows = makeRows(PAGE_SIZE);
    const state = makeState();
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, KEYED_TABLE);

    await persist.write(rows);

    const docs = await db.collection('chat').find({}).sort({ _seq: 1 }).toArray();
    expect(docs).toHaveLength(PAGE_SIZE);
    expect(docs[0]._seq).toBe(0);
    expect(docs[PAGE_SIZE - 1]._seq).toBe(PAGE_SIZE - 1);
  });

  it('assigns _id from the idField value', async () => {
    const rows = makeRows(3);
    const state = makeState();
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, KEYED_TABLE);

    await persist.write(rows);

    const doc = await db.collection('chat').findOne({ _id: 1 as never });
    expect(doc).not.toBeNull();
    expect(doc!.text).toBe('row 1');
  });

  it('advances start and totalFetched after write', async () => {
    const rows = makeRows(PAGE_SIZE);
    const state = makeState();
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, KEYED_TABLE);

    await persist.write(rows);

    expect(state.start).toBe(PAGE_SIZE);
    expect(state.totalFetched).toBe(PAGE_SIZE);
  });

  it('does not duplicate documents when re-writing the same rows', async () => {
    const rows = makeRows(3);

    const state1 = makeState();
    await saveState(db, state1);
    const persist1 = createPersistenceService(db).bind(state1, KEYED_TABLE);
    await persist1.write(rows);

    const state2 = makeState();
    await saveState(db, state2);
    const persist2 = createPersistenceService(db).bind(state2, KEYED_TABLE);
    await persist2.write(rows);

    const docs = await db.collection('chat').find({}).toArray();
    expect(docs).toHaveLength(3);
  });

  it('persists state to DB after write', async () => {
    const rows = makeRows(3);
    const state = makeState();
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, KEYED_TABLE);

    await persist.write(rows);

    const persisted = (await loadAllStates(db)).get('chat')!;
    expect(persisted.start).toBe(3);
    expect(persisted.totalFetched).toBe(3);
  });
});

// ── Multi-field key ───────────────────────────────────────────────────────────

describe('persist.write (multi-field key)', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db('test_persistence_multikey');
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  beforeEach(async () => {
    await db.collection('funding').deleteMany({});
    await db.collection('_state').deleteMany({});
  });

  it('builds _id as colon-joined values for multi-field idFields', async () => {
    const rows = [
      { timestamp: '2020-01-01T00:00:00.000Z', symbol: 'XBTUSD', fundingRate: 0.0001 },
    ];
    const state = makeState({ _id: 'funding' });
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, MULTI_KEY_TABLE);

    await persist.write(rows);

    const doc = await db.collection('funding').findOne({ _id: '2020-01-01T00:00:00.000Z:XBTUSD' as never });
    expect(doc).not.toBeNull();
    expect(doc!.symbol).toBe('XBTUSD');
  });
});

// ── Keyless table (insert only) ───────────────────────────────────────────────

describe('persist.write (keyless table — insert only)', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db('test_persistence_keyless');
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  beforeEach(async () => {
    await db.collection('quote').deleteMany({});
    await db.collection('_state').deleteMany({});
  });

  it('inserts documents without constructing _id', async () => {
    const rows = [
      { timestamp: '2020-01-01T00:00:00.000Z', symbol: 'XBTUSD', askPrice: 7000 },
      { timestamp: '2020-01-01T00:00:01.000Z', symbol: 'XBTUSD', askPrice: 7001 },
    ];
    const state = makeState({ _id: 'quote:XBTUSD' });
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, KEYLESS_TABLE);

    await persist.write(rows);

    const docs = await db.collection('quote').find({}).toArray();
    expect(docs).toHaveLength(2);
    expect(docs[0]._seq).toBe(0);
    expect(docs[1]._seq).toBe(1);
    expect(docs[0]._id).not.toBe('2020-01-01T00:00:00.000Z:XBTUSD');
  });

  it('assigns _seq relative to state.start', async () => {
    const rows = [
      { timestamp: '2020-02-01T00:00:00.000Z', symbol: 'XBTUSD', askPrice: 8000 },
    ];
    const state = makeState({ _id: 'quote:XBTUSD', start: 1500, totalFetched: 1500 });
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, KEYLESS_TABLE);

    await persist.write(rows);

    const docs = await db.collection('quote').find({}).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]._seq).toBe(1500);
  });
});

// ── Block transitions ─────────────────────────────────────────────────────────
//
// BLOCK_TABLE has maxStart=1000 → threshold zone when start > 0.
// All tests pre-seed state in the threshold zone (start=500, lastSeenTimestamp=T1)
// to avoid needing multiple non-threshold pages before the transition.

describe('persist.write (time-block transitions)', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db('test_persistence_blocks');
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  beforeEach(async () => {
    await db.collection('block_test').deleteMany({});
    await db.collection('_state').deleteMany({});
  });

  const makeBlockState = (overrides: Partial<HistoryState> = {}): HistoryState => ({
    _id: 'block_test',
    start: 500,
    lastFetchedAt: new Date('2024-01-01T00:00:00.000Z'),
    totalFetched: 500,
    firstTimestamp: T1,
    block: 0,
    blockStartTime: null,
    lastSeenTimestamp: T1,
    ...overrides,
  });

  // 500 rows: first `t1Count` with T1, rest with T2
  const makeTransitionPage = (t1Count: number): Record<string, unknown>[] => [
    ...Array.from({ length: t1Count },       (_, i) => ({ id: 500 + i + 1, timestamp: T1 })),
    ...Array.from({ length: 500 - t1Count }, (_, i) => ({ id: 500 + t1Count + i + 1, timestamp: T2 })),
  ];

  it('normal transition: saves rows up to the timestamp change, starts new block', async () => {
    const page = makeTransitionPage(300);

    const state = makeBlockState();
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, BLOCK_TABLE);

    const { transitioned } = await persist.write(page);

    expect(transitioned).toBe(true);

    // 300 T1 rows saved in block 0 at _seq 500-799
    const block0Docs = await db.collection('block_test').find({ timestamp: T1 }).sort({ _seq: 1 }).toArray();
    expect(block0Docs).toHaveLength(300);
    expect(block0Docs[0]._seq).toBe(500);
    expect(block0Docs[299]._seq).toBe(799);

    // State transitioned to block 1
    expect(state.block).toBe(1);
    expect(state.blockStartTime).toBe(T2);
    expect(state.start).toBe(0);
  });

  it('normal transition: no T1 docs lost, T2 docs dropped for re-fetch', async () => {
    const page = makeTransitionPage(300); // 300 T1, 200 T2

    const state = makeBlockState();
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, BLOCK_TABLE);

    await persist.write(page);

    // All 300 T1 rows in block 0
    const t1Docs = await db.collection('block_test').find({ timestamp: T1 }).toArray();
    expect(t1Docs).toHaveLength(300);

    // T2 rows were NOT saved (dropped at boundary)
    const t2Docs = await db.collection('block_test').find({ timestamp: T2 }).toArray();
    expect(t2Docs).toHaveLength(0);

    // totalFetched only counts the saved rows
    expect(state.totalFetched).toBe(800); // 500 pre-existing + 300 new
  });

  it('re-fetched T2 rows land in new block with correct _seq', async () => {
    const page = makeTransitionPage(300);

    const state = makeBlockState();
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, BLOCK_TABLE);

    // First write triggers transition
    await persist.write(page);

    // Simulate re-fetch: the 200 T2 rows come back in block 1
    const t2Rows = page.slice(300);
    const { transitioned } = await persist.write(t2Rows);

    expect(transitioned).toBe(false);

    const t2Docs = await db.collection('block_test').find({ timestamp: T2 }).sort({ _seq: 1 }).toArray();
    expect(t2Docs).toHaveLength(200);
    expect(t2Docs[0]._seq).toBe(1000);  // block 1 * maxStart 1000 + start 0
    expect(t2Docs[199]._seq).toBe(1199);
  });

  it('transition on first row: 0 rows saved in current block', async () => {
    // All 500 rows are T2 — split at index 0
    const page = makeTransitionPage(0);

    const state = makeBlockState();
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, BLOCK_TABLE);

    const { transitioned } = await persist.write(page);

    expect(transitioned).toBe(true);

    // No docs saved (all dropped)
    const docs = await db.collection('block_test').find({}).toArray();
    expect(docs).toHaveLength(0);

    expect(state.block).toBe(1);
    expect(state.blockStartTime).toBe(T2);
    expect(state.start).toBe(0);
  });

  it('transition on last row: 499 rows saved in current block', async () => {
    // 499 T1 rows, 1 T2 row — split at index 499
    const page = makeTransitionPage(499);

    const state = makeBlockState();
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, BLOCK_TABLE);

    const { transitioned } = await persist.write(page);

    expect(transitioned).toBe(true);

    const t1Docs = await db.collection('block_test').find({ timestamp: T1 }).toArray();
    expect(t1Docs).toHaveLength(499);
    expect(state.block).toBe(1);
    expect(state.blockStartTime).toBe(T2);
  });

  it('no false transition in new block when rows match blockStartTime', async () => {
    // After a transition to T2, re-fetched rows at T2 should NOT trigger another transition.
    const transitionPage = makeTransitionPage(300);

    const state = makeBlockState();
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, BLOCK_TABLE);

    // Trigger transition to block 1
    await persist.write(transitionPage);

    expect(state.block).toBe(1);
    expect(state.blockStartTime).toBe(T2);

    // Write T2 rows in block 1 — should NOT transition again
    const newBlockRows = Array.from({ length: 3 }, (_, i) => ({ id: 900 + i, timestamp: T2 }));
    const { transitioned } = await persist.write(newBlockRows);

    expect(transitioned).toBe(false);
    expect(state.block).toBe(1);

    const t2Docs = await db.collection('block_test').find({ timestamp: T2 }).sort({ _seq: 1 }).toArray();
    expect(t2Docs).toHaveLength(3);
    expect(t2Docs[0]._seq).toBe(1000); // block 1, start 0
  });

  it('fallback: saves all rows and starts new block at lastTimestamp+1ms', async () => {
    // All 500 rows have T1, and start+500=1000 >= maxStart=1000 → fallback
    const page = Array.from({ length: 500 }, (_, i) => ({ id: 500 + i + 1, timestamp: T1 }));
    const t1PlusOne = new Date(new Date(T1).getTime() + 1).toISOString();

    const state = makeBlockState();
    await saveState(db, state);
    const persist = createPersistenceService(db).bind(state, BLOCK_TABLE);

    const { transitioned } = await persist.write(page);

    expect(transitioned).toBe(true);

    // All 500 rows saved
    const docs = await db.collection('block_test').find({}).toArray();
    expect(docs).toHaveLength(500);

    // Block transition with +1ms anchor
    expect(state.block).toBe(1);
    expect(state.blockStartTime).toBe(t1PlusOne);
  });
});
