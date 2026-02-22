import { describe, it, expect, vi } from 'vitest';
import { encodeVersion, decodeVersion, encodeTimestamp, decodeTimestamp, encodePayload } from '../src/encoding';
import type { BitmexDataMessage } from '@tradebot/types';

describe('Encoding utilities', () => {
  describe('encodeVersion / decodeVersion', () => {
    it('should roundtrip common semver strings', () => {
      for (const v of ['1.0.0', '2.3.4', '0.1.0', '3.7.15']) {
        const { encoded, bits } = encodeVersion(v);
        expect(bits).toBe(9);
        expect(decodeVersion(encoded as number)).toBe(v);
      }
    });

    it('should clamp values to bit widths (major: 2 bits, minor: 3 bits, patch: 4 bits)', () => {
      // Values exceeding bit width wrap around due to masking
      const { encoded } = encodeVersion('4.0.0'); // major 4 = 0b100, masked to 0b00
      expect(decodeVersion(encoded as number)).toBe('0.0.0');
    });
  });

  describe('encodeTimestamp / decodeTimestamp', () => {
    it('should roundtrip timestamps within the valid range (2000-2100)', () => {
      const ts = '2024-01-15T10:30:45.123Z';
      const { encoded, bits } = encodeTimestamp(ts);
      expect(bits).toBe(42);
      expect(decodeTimestamp(encoded as number)).toBe(ts);
    });

    it('should roundtrip timestamps at common boundary values', () => {
      for (const ts of ['2000-01-01T00:00:00.000Z', '2050-06-15T12:00:00.000Z']) {
        expect(decodeTimestamp(encodeTimestamp(ts).encoded as number)).toBe(ts);
      }
    });

    it('should throw for timestamps before year 2000', () => {
      expect(() => encodeTimestamp('1999-12-31T23:59:59.999Z')).toThrow();
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

    it('should encode quote items as [bidSize, bidPrice, askPrice, askSize]', () => {
      const quoteItem = { bidSize: 50000, bidPrice: 42500, askPrice: 42501, askSize: 60000, symbol: 'XBTUSD', timestamp: '2024-01-15T10:30:00.000Z' };
      const result = encodePayload([quoteItem], 'quote', 'insert');
      expect(result['XBTUSD'][0]).toEqual([50000, 42500, 42501, 60000]);
    });
  });
});
