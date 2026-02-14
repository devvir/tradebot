import {
  filterChannelsByRole,
  filterSymbolsByRole,
} from '../src/config';
import { buildSubscriptionTopics } from '../src/bitmex';

describe('Role-based filtering', () => {
  describe('filterChannelsByRole', () => {
    it('should allow GLOBAL role to access only global channels', () => {
      const allChannels = [
        'insurance',
        'announcement',
        'chat',
        'publicNotifications',
        'connected',
        'instrument',
      ];
      const result = filterChannelsByRole(allChannels, 'GLOBAL');
      expect(result).toEqual([
        'insurance',
        'announcement',
        'chat',
        'publicNotifications',
        'connected',
        'instrument',
      ]);
    });

    it('should reject trade/quote channels for GLOBAL role', () => {
      const mixedChannels = [
        'insurance',
        'announcement',
        'trade',
        'quote',
        'orderBookL2',
      ];
      const result = filterChannelsByRole(mixedChannels, 'GLOBAL');
      expect(result).toEqual(['insurance', 'announcement']);
      expect(result).not.toContain('trade');
      expect(result).not.toContain('quote');
      expect(result).not.toContain('orderBookL2');
    });

    it('should allow LOW_VOLUME_1 to access binned quotes', () => {
      const channels = [
        'quoteBin1m',
        'quoteBin5m',
        'quoteBin1h',
        'quoteBin1d',
      ];
      const result = filterChannelsByRole(channels, 'LOW_VOLUME_1');
      expect(result).toEqual(channels);
    });

    it('should reject streaming quote channel for LOW_VOLUME_1', () => {
      const channels = ['quote', 'quoteBin1m', 'quoteBin5m'];
      const result = filterChannelsByRole(channels, 'LOW_VOLUME_1');
      expect(result).toEqual(['quoteBin1m', 'quoteBin5m']);
      expect(result).not.toContain('quote');
    });

    it('should allow LOW_VOLUME_2 to access binned trades', () => {
      const channels = [
        'tradeBin1m',
        'tradeBin5m',
        'tradeBin1h',
        'tradeBin1d',
      ];
      const result = filterChannelsByRole(channels, 'LOW_VOLUME_2');
      expect(result).toEqual(channels);
    });

    it('should allow LOW_VOLUME_3 to access liquidation/funding/settlement', () => {
      const channels = ['liquidation', 'funding', 'settlement'];
      const result = filterChannelsByRole(channels, 'LOW_VOLUME_3');
      expect(result).toEqual(channels);
    });

    it('should allow HIGH_VOLUME to access orderBookL2, quote, trade', () => {
      const channels = ['orderBookL2', 'quote', 'trade'];
      const result = filterChannelsByRole(channels, 'HIGH_VOLUME');
      expect(result).toEqual(channels);
    });

    it('should reject low-volume channels for HIGH_VOLUME role', () => {
      const channels = [
        'orderBookL2',
        'quote',
        'trade',
        'quoteBin1m',
        'liquidation',
      ];
      const result = filterChannelsByRole(channels, 'HIGH_VOLUME');
      expect(result).toEqual(['orderBookL2', 'quote', 'trade']);
      expect(result).not.toContain('quoteBin1m');
      expect(result).not.toContain('liquidation');
    });

    it('should allow BITCOIN role (same as HIGH_VOLUME) to access streaming channels', () => {
      const channels = ['orderBookL2', 'quote', 'trade'];
      const result = filterChannelsByRole(channels, 'BITCOIN');
      expect(result).toEqual(channels);
    });

    it('should allow NONE role to access all channels', () => {
      const allChannels = [
        'trade',
        'quote',
        'orderBookL2',
        'quoteBin1m',
        'insurance',
        'liquidation',
        'funding',
      ];
      const result = filterChannelsByRole(allChannels, 'NONE');
      expect(result).toEqual(allChannels);
    });

    it('should return empty array when no channels match role', () => {
      const channels = ['quoteBin1m', 'liquidation'];
      const result = filterChannelsByRole(channels, 'HIGH_VOLUME');
      expect(result).toEqual([]);
    });
  });

  describe('filterSymbolsByRole', () => {
    it('should allow HIGH_VOLUME to access non-Bitcoin symbols', () => {
      const symbols = ['XBTUSD', 'ETHUSD', 'ADAUSD', 'XBTPERP'];
      const result = filterSymbolsByRole(symbols, 'HIGH_VOLUME');
      expect(result).toEqual(['ETHUSD', 'ADAUSD']);
      expect(result).not.toContain('XBTUSD');
      expect(result).not.toContain('XBTPERP');
    });

    it('should allow BITCOIN role to access only Bitcoin symbols', () => {
      const symbols = ['XBTUSD', 'ETHUSD', 'XBTPERP', 'ADAUSD'];
      const result = filterSymbolsByRole(symbols, 'BITCOIN');
      expect(result).toEqual(['XBTUSD', 'XBTPERP']);
    });

    it('should return all symbols for GLOBAL role', () => {
      const symbols = ['XBTUSD', 'ETHUSD', 'ADAUSD'];
      const result = filterSymbolsByRole(symbols, 'GLOBAL');
      expect(result).toEqual(symbols);
    });

    it('should return all symbols for LOW_VOLUME roles', () => {
      const symbols = ['XBTUSD', 'ETHUSD'];
      expect(filterSymbolsByRole(symbols, 'LOW_VOLUME_1')).toEqual(symbols);
      expect(filterSymbolsByRole(symbols, 'LOW_VOLUME_2')).toEqual(symbols);
      expect(filterSymbolsByRole(symbols, 'LOW_VOLUME_3')).toEqual(symbols);
    });

    it('should return all symbols for NONE role', () => {
      const symbols = ['XBTUSD', 'ETHUSD', 'ADAUSD'];
      const result = filterSymbolsByRole(symbols, 'NONE');
      expect(result).toEqual(symbols);
    });

    it('should handle empty symbols array', () => {
      const result = filterSymbolsByRole([], 'HIGH_VOLUME');
      expect(result).toEqual([]);
    });

    it('should handle all-Bitcoin symbols for HIGH_VOLUME (returns empty)', () => {
      const symbols = ['XBTUSD', 'XBTPERP', 'XBTZ25'];
      const result = filterSymbolsByRole(symbols, 'HIGH_VOLUME');
      expect(result).toEqual([]);
    });

    it('should handle all-altcoin symbols for BITCOIN (returns empty)', () => {
      const symbols = ['ETHUSD', 'ADAUSD', 'DOTUSD'];
      const result = filterSymbolsByRole(symbols, 'BITCOIN');
      expect(result).toEqual([]);
    });
  });

  describe('Role-based subscription topic generation', () => {
    it('GLOBAL role should only subscribe to global channels', () => {
      // GLOBAL role can access these
      const channels = ['insurance', 'announcement', 'chat', 'publicNotifications', 'connected', 'instrument'];
      const symbols = ['XBTUSD', 'ETHUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      // Should include global channels (no symbols)
      expect(topics).toContain('insurance');
      expect(topics).toContain('announcement');
      expect(topics).toContain('chat');
      expect(topics).toContain('publicNotifications');
      expect(topics).toContain('connected');
      expect(topics).toContain('instrument');

      // Should NOT have symbol-suffixed versions of global channels
      expect(topics).not.toContain('insurance:XBTUSD');
      expect(topics).not.toContain('announcement:XBTUSD');
    });

    it('HIGH_VOLUME role should subscribe to high-volume channels for non-Bitcoin', () => {
      // HIGH_VOLUME can access: orderBookL2, quote, trade
      // But only for non-Bitcoin symbols
      const channels = ['orderBookL2', 'quote', 'trade'];
      const symbols = ['ETHUSD', 'ADAUSD']; // Non-Bitcoin only

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics).toContain('orderBookL2:ETHUSD');
      expect(topics).toContain('orderBookL2:ADAUSD');
      expect(topics).toContain('quote:ETHUSD');
      expect(topics).toContain('quote:ADAUSD');
      expect(topics).toContain('trade:ETHUSD');
      expect(topics).toContain('trade:ADAUSD');
      expect(topics.length).toBe(6); // 3 channels × 2 symbols
    });

    it('BITCOIN role should subscribe to high-volume channels for Bitcoin only', () => {
      // BITCOIN can access: orderBookL2, quote, trade
      // But only for Bitcoin symbols
      const channels = ['orderBookL2', 'quote', 'trade'];
      const symbols = ['XBTUSD', 'XBTPERP'];

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics).toContain('orderBookL2:XBTUSD');
      expect(topics).toContain('orderBookL2:XBTPERP');
      expect(topics).toContain('quote:XBTUSD');
      expect(topics).toContain('quote:XBTPERP');
      expect(topics).toContain('trade:XBTUSD');
      expect(topics).toContain('trade:XBTPERP');
      expect(topics.length).toBe(6); // 3 channels × 2 symbols
    });

    it('LOW_VOLUME_1 should subscribe to binned quotes for all symbols', () => {
      const channels = ['quoteBin1m', 'quoteBin5m', 'quoteBin1h', 'quoteBin1d'];
      const symbols = ['XBTUSD', 'ETHUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics).toContain('quoteBin1m:XBTUSD');
      expect(topics).toContain('quoteBin1m:ETHUSD');
      expect(topics).toContain('quoteBin5m:XBTUSD');
      expect(topics).toContain('quoteBin5m:ETHUSD');
      expect(topics.length).toBe(8); // 4 channels × 2 symbols
    });

    it('LOW_VOLUME_3 should subscribe to liquidation/funding/settlement for all symbols', () => {
      const channels = ['liquidation', 'funding', 'settlement'];
      const symbols = ['XBTUSD', 'ETHUSD', 'ADAUSD'];

      const topics = buildSubscriptionTopics(channels, symbols);

      expect(topics).toContain('liquidation:XBTUSD');
      expect(topics).toContain('funding:ETHUSD');
      expect(topics).toContain('settlement:ADAUSD');
      expect(topics.length).toBe(9); // 3 channels × 3 symbols
    });
  });

  describe('Complete role resolution workflow', () => {
    it('should resolve to correct channels and symbols for GLOBAL role', () => {
      const allChannels = [
        'trade',
        'quote',
        'orderBookL2',
        'insurance',
        'announcement',
        'instrument',
      ];
      const allSymbols = ['XBTUSD', 'ETHUSD', 'ADAUSD'];

      // GLOBAL filters to global channels only
      const channels = filterChannelsByRole(allChannels, 'GLOBAL');
      const symbols = filterSymbolsByRole(allSymbols, 'GLOBAL');

      expect(channels).toEqual(['insurance', 'announcement', 'instrument']);
      expect(symbols).toEqual(['XBTUSD', 'ETHUSD', 'ADAUSD']);

      const topics = buildSubscriptionTopics(channels, symbols);
      expect(topics).toContain('insurance');
      expect(topics).toContain('announcement');
      expect(topics).not.toContain('trade:XBTUSD');
    });

    it('should resolve to correct channels and symbols for HIGH_VOLUME role', () => {
      const allChannels = [
        'trade',
        'quote',
        'orderBookL2',
        'quoteBin1m',
        'liquidation',
      ];
      const allSymbols = ['XBTUSD', 'ETHUSD', 'XBTPERP', 'ADAUSD'];

      // HIGH_VOLUME filters to high-volume channels and non-Bitcoin symbols
      const channels = filterChannelsByRole(allChannels, 'HIGH_VOLUME');
      const symbols = filterSymbolsByRole(allSymbols, 'HIGH_VOLUME');

      expect(channels).toEqual(['trade', 'quote', 'orderBookL2']);
      expect(symbols).toEqual(['ETHUSD', 'ADAUSD']);

      const topics = buildSubscriptionTopics(channels, symbols);
      expect(topics).toContain('trade:ETHUSD');
      expect(topics).toContain('quote:ADAUSD');
      expect(topics).not.toContain('trade:XBTUSD');
      expect(topics).not.toContain('quoteBin1m:ETHUSD');
      expect(topics.length).toBe(6); // 3 channels × 2 symbols
    });

    it('should resolve to correct channels and symbols for BITCOIN role', () => {
      const allChannels = [
        'trade',
        'quote',
        'orderBookL2',
        'quoteBin1m',
        'liquidation',
      ];
      const allSymbols = ['XBTUSD', 'ETHUSD', 'XBTPERP', 'ADAUSD'];

      // BITCOIN filters to high-volume channels and Bitcoin symbols only
      const channels = filterChannelsByRole(allChannels, 'BITCOIN');
      const symbols = filterSymbolsByRole(allSymbols, 'BITCOIN');

      expect(channels).toEqual(['trade', 'quote', 'orderBookL2']);
      expect(symbols).toEqual(['XBTUSD', 'XBTPERP']);

      const topics = buildSubscriptionTopics(channels, symbols);
      expect(topics).toContain('trade:XBTUSD');
      expect(topics).toContain('quote:XBTPERP');
      expect(topics).not.toContain('trade:ETHUSD');
      expect(topics.length).toBe(6); // 3 channels × 2 symbols
    });
  });

  describe('Edge cases and validation', () => {
    it('should handle GLOBAL role with empty symbols (returns empty topics)', () => {
      const channels = ['insurance', 'announcement'];
      const symbols: string[] = [];

      const topics = buildSubscriptionTopics(channels, symbols);

      // Global channels don't need symbols, so should still be included
      expect(topics).toContain('insurance');
      expect(topics).toContain('announcement');
      expect(topics.length).toBe(2);
    });

    it('should handle HIGH_VOLUME role with only Bitcoin symbols (returns no topics for those)', () => {
      const channels = ['orderBookL2', 'quote', 'trade'];
      const symbols = ['XBTUSD', 'XBTPERP'];

      // These symbols don't match HIGH_VOLUME (which needs non-Bitcoin)
      const filteredSymbols = filterSymbolsByRole(symbols, 'HIGH_VOLUME');

      expect(filteredSymbols).toEqual([]);

      const topics = buildSubscriptionTopics(channels, filteredSymbols);
      expect(topics).toEqual([]);
    });

    it('should handle role mismatches gracefully', () => {
      // Try to use quote channel with BITCOIN role - should be filtered through
      const channels = filterChannelsByRole(['quoteBin1m'], 'BITCOIN');
      expect(channels).toEqual([]); // BITCOIN only gets orderBookL2, quote, trade

      // Try to use liquidation with HIGH_VOLUME role
      const channels2 = filterChannelsByRole(['liquidation'], 'HIGH_VOLUME');
      expect(channels2).toEqual([]); // HIGH_VOLUME only gets orderBookL2, quote, trade
    });

    it('should handle mixed role channels and symbol filters in sequence', () => {
      // Simulate the full resolution process
      const allChannels = [
        'trade',
        'quote',
        'orderBookL2',
        'quoteBin1m',
        'quoteBin5m',
        'liquidation',
        'funding',
        'settlement',
        'insurance',
        'announcement',
      ];
      const allSymbols = [
        'XBTUSD',
        'XBTM26',
        'ETHUSD',
        'ADAUSD',
        'LTCUSD',
      ];

      // LOW_VOLUME_3 should get liquidation, funding, settlement for ALL symbols
      const channels = filterChannelsByRole(allChannels, 'LOW_VOLUME_3');
      const symbols = filterSymbolsByRole(allSymbols, 'LOW_VOLUME_3');

      expect(channels).toContain('liquidation');
      expect(channels).toContain('funding');
      expect(channels).not.toContain('trade');
      expect(channels).not.toContain('quoteBin1m');

      expect(symbols).toEqual(allSymbols); // LOW_VOLUME_3 doesn't filter symbols

      const topics = buildSubscriptionTopics(channels, symbols);
      expect(topics).toContain('liquidation:XBTUSD');
      expect(topics).toContain('funding:ETHUSD');
      expect(topics).toContain('settlement:ADAUSD');
      expect(topics).not.toContain('trade:XBTUSD');
      expect(topics.length).toBe(15); // 3 channels (liquidation, funding, settlement) × 5 symbols
    });
  });
});
