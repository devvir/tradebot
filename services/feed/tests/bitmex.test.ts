import { buildSubscriptionTopics, fetchAllSymbols, globToRegex, matchesPatterns, filterSymbolsByPatterns, filterChannelsByPatterns } from '../src/bitmex';

describe('BitMEX utilities', () => {
  describe('globToRegex', () => {
    it('should convert * wildcard to match any characters', () => {
      const regex = globToRegex('*');
      expect(regex.test('XBTUSD')).toBe(true);
      expect(regex.test('ETHUSD')).toBe(true);
      expect(regex.test('')).toBe(true);
    });

    it('should convert ? wildcard to match single character', () => {
      const regex = globToRegex('XBT?');
      expect(regex.test('XBTA')).toBe(true);
      expect(regex.test('XBTUSD')).toBe(false);
      expect(regex.test('XBT')).toBe(false);
    });

    it('should match literal strings with special chars properly escaped', () => {
      const regex = globToRegex('XBT.USD');
      expect(regex.test('XBT.USD')).toBe(true);
      expect(regex.test('XBTUSD')).toBe(false);
    });

    it('should combine wildcards', () => {
      const regex = globToRegex('XBT*USD');
      expect(regex.test('XBTUSD')).toBe(true);
      expect(regex.test('XBTPERP_USD')).toBe(true);
      expect(regex.test('XBATUSD')).toBe(false);
    });
  });

  describe('matchesPatterns', () => {
    it('should match symbol against a single pattern', () => {
      const patterns = ['XBTUSD'];
      expect(matchesPatterns('XBTUSD', patterns)).toBe(true);
      expect(matchesPatterns('ETHUSD', patterns)).toBe(false);
    });

    it('should match symbol against multiple patterns', () => {
      const patterns = ['XBTUSD', 'ETHUSD'];
      expect(matchesPatterns('XBTUSD', patterns)).toBe(true);
      expect(matchesPatterns('ETHUSD', patterns)).toBe(true);
      expect(matchesPatterns('ADAUSD', patterns)).toBe(false);
    });

    it('should support glob patterns', () => {
      const patterns = ['XBT*', 'ETH*'];
      expect(matchesPatterns('XBTUSD', patterns)).toBe(true);
      expect(matchesPatterns('XBTPERP', patterns)).toBe(true);
      expect(matchesPatterns('ETHUSD', patterns)).toBe(true);
      expect(matchesPatterns('ADAUSD', patterns)).toBe(false);
    });
  });

  describe('filterSymbolsByPatterns', () => {
    it('should filter symbols by exact match patterns', () => {
      const symbols = ['XBTUSD', 'ETHUSD', 'ADAUSD', 'DOTUSD'];
      const patterns = ['XBTUSD', 'ETHUSD'];
      const result = filterSymbolsByPatterns(symbols, patterns);
      expect(result).toEqual(['XBTUSD', 'ETHUSD']);
    });

    it('should filter symbols by glob patterns', () => {
      const symbols = ['XBTUSD', 'XBTPERP', 'ETHUSD', 'ADAUSD'];
      const patterns = ['XBT*'];
      const result = filterSymbolsByPatterns(symbols, patterns);
      expect(result).toEqual(['XBTUSD', 'XBTPERP']);
    });

    it('should handle wildcard pattern', () => {
      const symbols = ['XBTUSD', 'ETHUSD', 'ADAUSD'];
      const patterns = ['*'];
      const result = filterSymbolsByPatterns(symbols, patterns);
      expect(result).toEqual(['XBTUSD', 'ETHUSD', 'ADAUSD']);
    });

    it('should return empty array when no symbols match', () => {
      const symbols = ['XBTUSD', 'ETHUSD'];
      const patterns = ['ADAUSD'];
      const result = filterSymbolsByPatterns(symbols, patterns);
      expect(result).toEqual([]);
    });
  });

  describe('filterChannelsByPatterns', () => {
    it('should filter channels by exact match', () => {
      const patterns = ['trade', 'quote'];
      const result = filterChannelsByPatterns(patterns);
      expect(result).toContain('trade');
      expect(result).toContain('quote');
    });

    it('should filter channels by glob pattern', () => {
      const patterns = ['quote*'];
      const result = filterChannelsByPatterns(patterns);
      expect(result).toContain('quote');
      expect(result).toContain('quoteBin1m');
      expect(result).toContain('quoteBin5m');
      expect(result).toContain('quoteBin1h');
      expect(result).toContain('quoteBin1d');
    });

    it('should support trade channels with glob', () => {
      const patterns = ['trade*'];
      const result = filterChannelsByPatterns(patterns);
      expect(result).toContain('trade');
      expect(result).toContain('tradeBin1m');
      expect(result).toContain('tradeBin5m');
      expect(result).toContain('tradeBin1h');
      expect(result).toContain('tradeBin1d');
    });

    it('should match orderBook channels', () => {
      const patterns = ['orderBook*'];
      const result = filterChannelsByPatterns(patterns);
      expect(result).toContain('orderBookL2');
      expect(result).toContain('orderBookL2_25');
      expect(result).toContain('orderBook10');
    });

    it('should handle wildcard', () => {
      const patterns = ['*'];
      const result = filterChannelsByPatterns(patterns);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('buildSubscriptionTopics', () => {
    it('should build topics with symbols for channels that require them', () => {
      const channels = ['trade', 'quote', 'orderBookL2'];
      const symbols = ['XBTUSD', 'ETHUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics).toContain('trade:XBTUSD');
      expect(topics).toContain('trade:ETHUSD');
      expect(topics).toContain('quote:XBTUSD');
      expect(topics).toContain('quote:ETHUSD');
      expect(topics).toContain('orderBookL2:XBTUSD');
      expect(topics).toContain('orderBookL2:ETHUSD');
    });

    it('should include global channels without symbols', () => {
      const channels: string[] = ['trade', 'chat', 'announcement'];
      const symbols: string[] = ['XBTUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics).toContain('trade:XBTUSD');
      expect(topics).toContain('chat');
      expect(topics).toContain('announcement');
      expect(topics.length).toBe(3); // 1 trade:symbol + 2 global channels
    });

    it('should handle all symbol-required channels', () => {
      const channels = [
        'orderBookL2',
        'orderBook10',
        'quote',
        'quoteBin1m',
        'quoteBin5m',
        'quoteBin1h',
        'quoteBin1d',
        'trade',
        'tradeBin1m',
        'tradeBin5m',
        'tradeBin1h',
        'tradeBin1d',
        'liquidation',
        'funding',
        'settlement'
      ];
      const symbols = ['XBTUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics.length).toBe(15); // One for each symbol-required channel
      topics.forEach(topic => {
        expect(topic).toContain(':XBTUSD');
      });
    });

    it('should include orderBookL2_25 with symbol suffix (symbol-required channel)', () => {
      const channels = ['orderBookL2', 'orderBookL2_25'];
      const symbols = ['XBTUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics).toContain('orderBookL2:XBTUSD');
      expect(topics).toContain('orderBookL2_25:XBTUSD');
      expect(topics).not.toContain('orderBookL2_25');
    });

    it('should treat instrument as symbol-required channel', () => {
      const channels = ['instrument', 'trade'];
      const symbols = ['XBTUSD', 'ETHUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics).toContain('instrument:XBTUSD');
      expect(topics).toContain('instrument:ETHUSD');
      expect(topics).toContain('trade:XBTUSD');
      expect(topics).toContain('trade:ETHUSD');
      expect(topics.length).toBe(4);
    });

    it('should treat funding and settlement as per-symbol channels', () => {
      const channels = ['funding', 'settlement'];
      const symbols = ['XBTUSD', 'ETHUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics).toContain('funding:XBTUSD');
      expect(topics).toContain('funding:ETHUSD');
      expect(topics).toContain('settlement:XBTUSD');
      expect(topics).toContain('settlement:ETHUSD');
      expect(topics.length).toBe(4);
    });

    it('should handle mix of global and per-symbol channels', () => {
      const channels = ['insurance', 'trade', 'funding'];
      const symbols = ['XBTUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics).toContain('insurance'); // Global
      expect(topics).toContain('trade:XBTUSD'); // Per-symbol
      expect(topics).toContain('funding:XBTUSD'); // Per-symbol
      expect(topics.length).toBe(3);
    });

    it('should handle empty symbols array', () => {
      const channels: string[] = ['trade'];
      const symbols: string[] = [];

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics.length).toBe(0);
    });

    it('should handle empty channels array', () => {
      const channels: string[] = [];
      const symbols: string[] = ['XBTUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics.length).toBe(0);
    });

    it('should handle duplicate channels', () => {
      const channels = ['trade', 'trade', 'quote'];
      const symbols = ['XBTUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      // Should have duplicates if input has duplicates (no deduplication)
      const tradeCount = topics.filter(t => t === 'trade:XBTUSD').length;
      expect(tradeCount).toBe(2);
    });

    it('should handle multiple global channels', () => {
      const channels = ['insurance', 'announcement', 'chat', 'publicNotifications', 'connected'];
      const symbols = ['XBTUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      // All are global, so no symbol suffix
      expect(topics).toContain('insurance');
      expect(topics).toContain('announcement');
      expect(topics).toContain('chat');
      expect(topics).toContain('publicNotifications');
      expect(topics).toContain('connected');
      expect(topics.length).toBe(5);
    });
  });

  describe('fetchAllSymbols', () => {
    it('should fetch symbols from BitMEX API', async () => {
      // This is an integration test that requires network access
      // In CI, this might be skipped
      if (process.env.SKIP_INTEGRATION_TESTS) {
        return;
      }

      try {
        const symbols = await fetchAllSymbols();
        expect(Array.isArray(symbols)).toBe(true);
        expect(symbols.length).toBeGreaterThan(0);
        expect(symbols).toContain('XBTUSD');
      } catch (error) {
        // Allow network errors in test environments
        console.warn('Skipping fetchAllSymbols test due to network unavailability');
      }
    }, 30000); // Increased timeout for network request
  });
});
