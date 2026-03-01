import { describe, it, expect, vi } from 'vitest';
import { buildDocumentId, unpackDocumentId } from '../src/encoding';
import { bigIntToBuffer } from '../src/encoding/utils';
import { encodePayload } from '../src/encoding/encoders';

describe('Encoding utilities', () => {
  describe('document _id: build → unpack', () => {
    it('should roundtrip action, version, and timestamp', () => {
      for (const action of ['partial', 'insert', 'update', 'delete'] as const) {
        const ts = '2024-01-15T10:30:45.123Z';
        const id = buildDocumentId(ts, action, '2.3.4', '1.0.0');
        const unpacked = unpackDocumentId(bigIntToBuffer(id));

        expect(unpacked.action).toBe(action);
        expect(unpacked.encoderVersion).toBe('1.0.0');
        expect(unpacked.timestamp).toBe(ts);
      }
    });

    it('should roundtrip timestamps at boundary values', () => {
      for (const ts of ['2000-01-01T00:00:00.000Z', '2050-06-15T12:00:00.000Z']) {
        const id = buildDocumentId(ts, 'insert');
        const unpacked = unpackDocumentId(bigIntToBuffer(id));
        expect(unpacked.timestamp).toBe(ts);
      }
    });

    it('should reject timestamps before year 2000', () => {
      expect(() => buildDocumentId('1999-12-31T23:59:59.999Z', 'insert')).toThrow();
    });
  });

  describe('encodePayload', () => {
    const tradeItem = {
      symbol: 'XBTUSD',
      trdMatchID: 'id-1',
      side: 'Buy' as const,
      size: 100,
      price: 42500,
      tickDirection: 'PlusTick' as const,
      grossValue: 235000,
      homeNotional: 0.00235,
      foreignNotional: 100,
      trdType: 'Regular',
    };

    it('should group items by symbol for symboled tables', () => {
      const items = [
        { ...tradeItem, symbol: 'XBTUSD' },
        { ...tradeItem, symbol: 'ETHUSD' },
        { ...tradeItem, symbol: 'XBTUSD' },
      ];

      const result = encodePayload(items, 'trade', 'insert');

      expect(Object.keys(result)).toContain('XBTUSD');
      expect(Object.keys(result)).toContain('ETHUSD');
      expect(result['XBTUSD']).toHaveLength(2);
      expect(result['ETHUSD']).toHaveLength(1);
    });

    it('should use _ key for non-symboled tables', () => {
      const items = [
        { bidSize: 100, bidPrice: 42500, askPrice: 42501, askSize: 100, symbol: 'XBTUSD', timestamp: '2024-01-15T10:30:00.000Z' },
      ];

      // insurance table has no symbol field
      const noSymbolItems = [{ premium: 100, currency: 'XBt', timestamp: '2024-01-15T10:30:00.000Z' }];
      const result = encodePayload(noSymbolItems as any, 'insurance', 'insert');

      expect(result).toHaveProperty('_');
    });

    it('should encode quote items with compression', () => {
      const quoteItem = { bidSize: 50000, bidPrice: 42500, askPrice: 42501, askSize: 60000, symbol: 'XBTUSD', timestamp: '2024-01-15T10:30:00.000Z' };
      const result = encodePayload([quoteItem], 'quote', 'insert');
      const encoded = result['XBTUSD'][0];

      // Quote returns 2 items when encoded: [packed_bid, packed_ask]
      // or 4 items [bidPrice, bidSize, askPrice, askSize] if not encodable (fallback)
      // With these values, encoding should succeed, so expect 2 items
      expect(Array.isArray(encoded) ? encoded.length : 0).toBe(2);
    });
  });
});
