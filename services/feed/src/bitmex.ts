import { KNOWN_CHANNELS, SYMBOL_REQUIRED_CHANNELS } from './channels';
import { filterChannelsByRole, filterSymbolsByRole } from './config';
import type { FeedRole } from './types';

// Re-export channel constants for convenience
export { KNOWN_CHANNELS, SYMBOL_REQUIRED_CHANNELS, GLOBAL_CHANNELS } from './channels';

/**
 * Fetch all active symbols from BitMEX, filtered by patterns and role.
 * Returns the symbols this service instance should handle.
 */
export const fetchAllSymbols = async (patterns: string[], role: FeedRole): Promise<string[]> => {
  const filter = encodeURIComponent(JSON.stringify({ state: 'Open' }));
  const res = await fetch(`https://www.bitmex.com/api/v1/instrument?filter=${filter}`);
  const instruments = (await res.json()) as Array<{ symbol: string }>;
  const symbols = instruments.map((inst) => inst.symbol);

  return filterSymbolsByPatterns(filterSymbolsByRole(symbols, role), patterns);
};

/**
 * Convert glob pattern to RegExp
 * * = 0 or more chars
 * ? = exactly one char
 */
export const globToRegex = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
    .replace(/\*/g, '.*') // * becomes .*
    .replace(/\?/g, '.'); // ? becomes .
  return new RegExp(`^${escaped}$`);
};

/**
 * Match symbol against a list of patterns
 */
export const matchesPatterns = (symbol: string, patterns: string[]): boolean => {
  return patterns.some((pattern) => {
    const regex = globToRegex(pattern);
    return regex.test(symbol);
  });
};

/**
 * Filter symbols by patterns
 */
export const filterSymbolsByPatterns = (symbols: string[], patterns: string[]): string[] => {
  return symbols.filter((symbol) => matchesPatterns(symbol, patterns));
};

/**
 * Filter channels by patterns
 */
export const filterChannelsByPatterns = (channels: string[], patterns: string[]): string[] => {
  return channels.filter((channel) => matchesPatterns(channel, patterns));
};

/**
 * Resolve channel patterns to concrete channels this service instance should handle.
 */
export const resolveChannels = (patterns: string[], role: FeedRole): string[] => {
  const roleChannels = filterChannelsByRole([...KNOWN_CHANNELS], role);
  return filterChannelsByPatterns(roleChannels, patterns);
};

export const buildSubscriptionTopics = (channels: string[], symbols: string[]): string[] => {
  const topics: string[] = [];

  channels.forEach((channel) => {
    if (SYMBOL_REQUIRED_CHANNELS.includes(channel as any)) {
      symbols.forEach((symbol) => {
        topics.push(`${channel}:${symbol}`);
      });
    } else {
      // Global channels (no symbol needed)
      topics.push(channel);
    }
  });

  return topics;
};
