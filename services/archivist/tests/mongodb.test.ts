import { getCollectionName, extractMinimalAttributes } from '../src/mongodb';

describe('MongoDB utilities', () => {
  describe('getCollectionName', () => {
    it('should return table_symbol format when symbol is present', () => {
      const data = {
        table: 'trade',
        data: [{ symbol: 'XBTUSD' }]
      };

      const name = getCollectionName(data);

      expect(name).toBe('trade_XBTUSD');
    });

    it('should return just table name when no symbol in data', () => {
      const data = {
        table: 'instrument',
        data: []
      };

      const name = getCollectionName(data);

      expect(name).toBe('instrument');
    });

    it('should use first symbol if multiple items in data', () => {
      const data = {
        table: 'quote',
        data: [
          { symbol: 'XBTUSD', bid: 50000 },
          { symbol: 'ETHUSD', bid: 3000 }
        ]
      };

      const name = getCollectionName(data);

      expect(name).toBe('quote_XBTUSD');
    });

    it('should handle missing data array', () => {
      const data = {
        table: 'chat'
      };

      const name = getCollectionName(data);

      expect(name).toBe('chat');
    });

    it('should handle data with no symbol field', () => {
      const data = {
        table: 'orderBookL2',
        data: [{ price: 50000, size: 100 }]
      };

      const name = getCollectionName(data);

      expect(name).toBe('orderBookL2');
    });

    it('should handle complex table names', () => {
      const data = {
        table: 'orderBookL2_25',
        data: [{ symbol: 'ETHUSD' }]
      };

      const name = getCollectionName(data);

      expect(name).toBe('orderBookL2_25_ETHUSD');
    });

    it('should return single collection name for instrument channel', () => {
      const data = {
        table: 'instrument',
        data: [{ symbol: 'XBTUSD' }]
      };

      const name = getCollectionName(data);

      expect(name).toBe('instrument');
    });

    it('should return per-symbol collection name for funding channel', () => {
      const data = {
        table: 'funding',
        data: [{ symbol: 'XBTUSD' }]
      };

      const name = getCollectionName(data);

      expect(name).toBe('funding_XBTUSD');
    });

    it('should return per-symbol collection name for settlement channel', () => {
      const data = {
        table: 'settlement',
        data: [{ symbol: 'ETHUSD' }]
      };

      const name = getCollectionName(data);

      expect(name).toBe('settlement_ETHUSD');
    });

    it('should handle instrument with multiple symbols in data array', () => {
      const data = {
        table: 'instrument',
        data: [
          { symbol: 'XBTUSD' },
          { symbol: 'ETHUSD' }
        ]
      };

      const name = getCollectionName(data);

      // instrument is always a single collection regardless of symbols
      expect(name).toBe('instrument');
    });
  });

  describe('extractMinimalAttributes', () => {
    it('should add timestamp if not present', () => {
      const document = { symbol: 'XBTUSD', price: 50000 };

      const result = extractMinimalAttributes(document);

      expect(result.timestamp).toBeDefined();
      expect(typeof result.timestamp).toBe('string');
      expect(result.symbol).toBe('XBTUSD');
      expect(result.price).toBe(50000);
    });

    it('should preserve existing timestamp', () => {
      const timestamp = '2026-02-01T12:00:00Z';
      const document = { timestamp, symbol: 'XBTUSD' };

      const result = extractMinimalAttributes(document);

      expect(result.timestamp).toBe(timestamp);
    });

    it('should include API version when provided', () => {
      const document = { symbol: 'XBTUSD', price: 50000 };

      const result = extractMinimalAttributes(document, '2.0.0');

      expect(result._apiVersion).toBe('2.0.0');
    });

    it('should not include API version when not provided', () => {
      const document = { symbol: 'XBTUSD' };

      const result = extractMinimalAttributes(document);

      expect(result._apiVersion).toBeUndefined();
    });

    it('should handle null API version', () => {
      const document = { symbol: 'XBTUSD' };

      const result = extractMinimalAttributes(document, null);

      expect(result._apiVersion).toBeUndefined();
    });

    it('should preserve all document fields', () => {
      const document = {
        symbol: 'XBTUSD',
        price: 50000,
        size: 100,
        side: 'Buy',
        timestamp: '2026-02-01T12:00:00Z'
      };

      const result = extractMinimalAttributes(document, '2.0.0');

      expect(result).toEqual({
        ...document,
        _apiVersion: '2.0.0'
      });
    });

    it('should handle complex nested objects', () => {
      const document = {
        symbol: 'XBTUSD',
        data: {
          nested: {
            value: 123
          }
        }
      };

      const result = extractMinimalAttributes(document);

      expect((result.data as any).nested.value).toBe(123);
    });

    it('should handle empty document', () => {
      const document = {};

      const result = extractMinimalAttributes(document, '2.0.0');

      expect(result.timestamp).toBeDefined();
      expect(result._apiVersion).toBe('2.0.0');
    });
  });
});
