import type { InstrumentItem } from './types';

/**
 * Merge per-symbol field contributions into one delta per symbol — the pipeline's
 * **merge** stage. A pure, stateless function: the same contributions always yield the
 * same result.
 *
 * Within a single timestamp a symbol can receive fields from several sources (e.g. a
 * `quote`-driven bid/ask and a trade-driven `lastPrice`); merging collapses them to one
 * delta per symbol, last-write-wins per field. Contribution order is therefore
 * significant only when two contributions set the *same* field — the later one wins.
 */
export function merge(
  contributions: Iterable<readonly [string, Partial<InstrumentItem>]>,
): Map<string, Partial<InstrumentItem>> {
  const bySymbol = new Map<string, Partial<InstrumentItem>>();

  for (const [symbol, fields] of contributions) {
    const existing = bySymbol.get(symbol);

    bySymbol.set(symbol, existing ? { ...existing, ...fields } : { ...fields });
  }

  return bySymbol;
}
