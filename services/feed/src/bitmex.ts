import https from 'https';
import logger from './logger';
import { KNOWN_CHANNELS, SYMBOL_REQUIRED_CHANNELS } from './channels';

// Re-export channel constants for convenience
export { KNOWN_CHANNELS, SYMBOL_REQUIRED_CHANNELS, GLOBAL_CHANNELS } from './channels';

export const fetchAllSymbols = (): Promise<string[]> => {
  return new Promise((resolve, reject) => {
    const req = https.get('https://www.bitmex.com/api/v1/instrument/active', (res) => {
      let data = '';

      res.on('data', (chunk: string) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const instruments = JSON.parse(data) as Array<{ symbol?: string }>;
          const symbols = instruments
            .map((inst) => inst.symbol)
            .filter((symbol): symbol is string => Boolean(symbol));
          logger.info({ count: symbols.length }, 'Fetched active symbols from BitMEX');
          resolve(symbols);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
  });
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
export const filterChannelsByPatterns = (patterns: string[]): string[] => {
  return KNOWN_CHANNELS.filter((channel) => matchesPatterns(channel, patterns));
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
