/**
 * Parse a stored timestamp to epoch ms. Tolerates the ancient
 * nanosecond-without-`Z` form (`2019-01-01T00:00:50.590967000`) seen in very
 * old `trade`/`quote` rows alongside the normal millisecond `…Z`. Always
 * interpreted as UTC — the stored data is UTC.
 */
export const toMs = (ts: string): number => {
  if (ts.endsWith('Z')) return Date.parse(ts);

  const m = ts.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);

  if (! m) return Date.parse(ts);

  const frac = (m[2] ?? '').slice(0, 3).padEnd(3, '0');

  return Date.parse(`${m[1]}.${frac}Z`);
};
