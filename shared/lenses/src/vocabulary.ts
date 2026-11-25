/**
 * Every grain, coarsest first: a file a month, a day, an hour, a minute.
 * `Grain` is one of these.
 */
export const GRAINS = ['monthly', 'daily', 'hourly', 'minutely'] as const;

/**
 * Every bundle: a file holds one instrument, or all of a market's at once.
 * `Bundle` is one of these.
 */
export const BUNDLES = ['instrument', 'market'] as const;
