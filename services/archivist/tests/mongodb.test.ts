import { getCollectionName } from '../src/mongodb';

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

    it('should handle complex table names (non-segregated)', () => {
      const data = {
        table: 'orderBookL2_25',
        data: [{ symbol: 'ETHUSD' }]
      };

      const name = getCollectionName(data);

      // orderBookL2_25 is not in SYMBOL_SEGREGATED, so no symbol suffix
      expect(name).toBe('orderBookL2_25');
    });

    it('should return single collection name for instrument channel', () => {
      const data = {
        table: 'instrument',
        data: [{ symbol: 'XBTUSD' }]
      };

      const name = getCollectionName(data);

      expect(name).toBe('instrument');
    });

    it('should return single collection for funding (not symbol-segregated)', () => {
      const data = {
        table: 'funding',
        data: [{ symbol: 'XBTUSD' }]
      };

      const name = getCollectionName(data);

      // Only orderBookL2, quote, trade are symbol-segregated
      expect(name).toBe('funding');
    });

    it('should return single collection for settlement (not symbol-segregated)', () => {
      const data = {
        table: 'settlement',
        data: [{ symbol: 'ETHUSD' }]
      };

      const name = getCollectionName(data);

      // Only orderBookL2, quote, trade are symbol-segregated
      expect(name).toBe('settlement');
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
});
