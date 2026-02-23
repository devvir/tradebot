import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { decodeMessage } from '../src/encoding';
import type { OrderBookL2Data } from '@tradebot/types';

describe('Decoders - Round-trip from real MongoDB data', () => {
  let db: any = null;
  let client: any = null;

  beforeAll(async () => {
    try {
      // Dynamically import mongodb to avoid hard dependency in tests
      // @ts-ignore - mongodb may not be installed
      const { MongoClient } = await import('mongodb');
      const mongoUrl = process.env.MONGODB_URL || '';

      client = new MongoClient(mongoUrl);
      await client.connect();
      db = client.db();
    } catch (error) {
      console.warn('MongoDB not available, tests will be skipped:', error);
    }
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  it('should decode orderBookL2 documents from MongoDB', async () => {
    if (! db) {
      console.log('Skipping test - MongoDB not available');
      return;
    }

    const doc = await db.collection('orderBookL2').findOne({
      _id: { $not: { $bitsAllClear: [0, 1] } }
    });

    expect(doc).toBeDefined();
    if (! doc) return;

    const decoded = decodeMessage('orderBookL2', doc, doc._id);

    expect(decoded.table).toBe('orderBookL2');
    expect(decoded.action).toBeDefined();
    expect(decoded.data).toBeDefined();
    expect(Array.isArray(decoded.data)).toBe(true);

    if (decoded.data && decoded.data.length > 0) {
      const item = decoded.data[0] as OrderBookL2Data;
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('side');
      expect(item).toHaveProperty('price');
      expect(['Buy', 'Sell']).toContain(item.side);
    }
  });

  it('should decode quote documents from MongoDB', async () => {
    if (! db) {
      console.log('Skipping test - MongoDB not available');
      return;
    }

    const doc = await db.collection('quote').findOne({
      _id: { $not: { $bitsAllClear: [0, 1] } }
    });

    expect(doc).toBeDefined();
    if (! doc) return;

    const decoded = decodeMessage('quote', doc, doc._id);

    expect(decoded.table).toBe('quote');
    expect(decoded.action).toBeDefined();
    expect(decoded.data).toBeDefined();
    expect(Array.isArray(decoded.data)).toBe(true);
  });

  it('should decode trade documents from MongoDB', async () => {
    if (! db) {
      console.log('Skipping test - MongoDB not available');
      return;
    }

    const doc = await db.collection('trade').findOne({
      _id: { $not: { $bitsAllClear: [0, 1] } }
    });

    expect(doc).toBeDefined();
    if (! doc) return;

    const decoded = decodeMessage('trade', doc, doc._id);

    expect(decoded.table).toBe('trade');
    expect(decoded.action).toBeDefined();
    expect(decoded.data).toBeDefined();
    expect(Array.isArray(decoded.data)).toBe(true);
  });

  it('should decode instrument documents from MongoDB', async () => {
    if (! db) {
      console.log('Skipping test - MongoDB not available');
      return;
    }

    const doc = await db.collection('instrument').findOne({
      _id: { $not: { $bitsAllClear: [0, 1] } }
    });

    expect(doc).toBeDefined();
    if (! doc) return;

    const decoded = decodeMessage('instrument', doc, doc._id);

    expect(decoded.table).toBe('instrument');
    expect(decoded.action).toBeDefined();
    expect(decoded.data).toBeDefined();
    expect(Array.isArray(decoded.data)).toBe(true);
  });
});
