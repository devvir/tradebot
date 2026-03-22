// Pending Review
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoClient, Db } from 'mongodb';
import { buildSubTableId, loadAllStates, saveState } from '../src/persistence/index.js';
import type { HistoryState } from '../src/persistence/index.js';

const mongoUrl = process.env.MONGODB_URL!;

const makeState = (id: string, overrides: Partial<HistoryState> = {}): HistoryState => ({
  _id: id,
  start: 0,
  lastFetchedAt: new Date('2024-01-01T00:00:00.000Z'),
  totalFetched: 0,
  firstTimestamp: null,
  ...overrides,
});

describe('buildSubTableId', () => {
  it('returns table name when no symbol given', () => {
    expect(buildSubTableId('trade')).toBe('trade');
  });

  it('returns colon-joined id when symbol is given', () => {
    expect(buildSubTableId('quote', 'XBTUSD')).toBe('quote:XBTUSD');
  });

  it('handles symbols that contain colons', () => {
    expect(buildSubTableId('quote', 'XBT:USD')).toBe('quote:XBT:USD');
  });
});

describe('state persistence (MongoDB)', () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db('test_history_state');
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  beforeEach(async () => {
    await db.collection('_state').deleteMany({});
  });

  it('loadAllStates returns empty map when collection is empty', async () => {
    const states = await loadAllStates(db);
    expect(states.size).toBe(0);
  });

  it('saveState persists a state document', async () => {
    const state = makeState('trade');
    await saveState(db, state);

    const stored = await db.collection('_state').findOne({ _id: 'trade' as never });
    expect(stored).not.toBeNull();
    expect(stored!.start).toBe(0);
    expect(stored!.totalFetched).toBe(0);
    expect(stored!.firstTimestamp).toBeNull();
  });

  it('loadAllStates returns all saved states', async () => {
    await saveState(db, makeState('trade'));
    await saveState(db, makeState('quote:XBTUSD'));
    await saveState(db, makeState('funding'));

    const states = await loadAllStates(db);

    expect(states.size).toBe(3);
    expect(states.has('trade')).toBe(true);
    expect(states.has('quote:XBTUSD')).toBe(true);
    expect(states.has('funding')).toBe(true);
  });

  it('loadAllStates returns the correct values for a state', async () => {
    const state = makeState('settlement', {
      start: 1000,
      totalFetched: 1000,
      firstTimestamp: '2020-01-01T00:00:00.000Z',
    });
    await saveState(db, state);

    const states = await loadAllStates(db);
    const loaded = states.get('settlement')!;

    expect(loaded.start).toBe(1000);
    expect(loaded.totalFetched).toBe(1000);
    expect(loaded.firstTimestamp).toBe('2020-01-01T00:00:00.000Z');
  });

  it('saveState upserts — re-saving same id does not create a duplicate', async () => {
    const state = makeState('trade', { start: 0 });
    await saveState(db, state);

    state.start = 500;
    state.totalFetched = 500;
    await saveState(db, state);

    const all = await db.collection('_state').find({}).toArray();
    expect(all).toHaveLength(1);
    expect(all[0].start).toBe(500);
    expect(all[0].totalFetched).toBe(500);
  });

  it('round-trips a state with all fields set', async () => {
    const state = makeState('chat', {
      start: 250,
      totalFetched: 250,
      firstTimestamp: '2019-06-15T12:00:00.000Z',
    });
    await saveState(db, state);

    const states = await loadAllStates(db);
    const loaded = states.get('chat')!;

    expect(loaded._id).toBe('chat');
    expect(loaded.start).toBe(250);
    expect(loaded.totalFetched).toBe(250);
    expect(loaded.firstTimestamp).toBe('2019-06-15T12:00:00.000Z');
  });
});
