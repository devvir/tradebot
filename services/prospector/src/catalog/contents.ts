import { BUCKET, levelsOf } from '../canonical';
import { open } from './series';
import type { MarketContents, Publishing, Shape } from '../types';

/**
 * What a venue holds, folded out of its series.
 *
 * **One read, several projections.** Every question here — which markets, which
 * datasets, which instruments, over what span — is the same rows counted
 * differently, so they are folds over what `seriesFor` already returned rather
 * than queries of their own. Separate queries could each decide differently
 * whether a retired pattern counts, whether a delisted series is an instrument, or
 * what an unstated end means; folds of one result cannot disagree.
 *
 * Nothing here reaches the database, and nothing here filters: the caller has
 * already narrowed the rows to what was asked for.
 */

/**
 * One row per distinct thing the venue publishes —
 * `(market, dataset, variant, grain)`.
 *
 * **It says nothing about how the venue arranges its URLs.** Whether a dataset
 * changed its path once or a thousand times is the catalog's business, not a
 * consumer's; where two shapes would be the same data twice, one is offered and
 * the other never surfaces. What a shape does distinguish is **variants of a
 * dataset**, never the same data under two names.
 */
export const intoShapes = (rows: readonly Publishing[]): Shape[] => {
  const shapes = new Map<string, Shape>();

  for (const one of rows) {
    const key   = `${one.market}|${one.dataset}|${one.variant}|${one.grain}`;
    const found = shapes.get(key) ?? {
      market: one.market, dataset: one.dataset,
      variant: levelsOf(one.dataset, one.variant),
      grain: one.grain, symbols: 0, buckets: 0,
      first: null as string | null, last: null as string | null,
      open: false,
    };

    if (one.symbol === BUCKET) found.buckets++;
    else found.symbols++;

    if (one.first && (found.first === null || one.first < found.first)) found.first = one.first;

    /**
     * **`last` is the newest file anybody has seen of this shape**, and nothing
     * more. It is a measurement, so it accumulates as a plain maximum: no series
     * suppresses it, and a shape still being written reports the date it has
     * reached rather than a blank.
     */
    if (one.last !== null && (found.last === null || one.last > found.last)) found.last = one.last;

    /**
     * **Open is stated, not inferred from a missing end.** One series still open
     * is enough: the shape has not stopped while any of it is still being
     * written, and reporting the latest date anybody reached would otherwise
     * read as though it had.
     *
     * It is the same `open` generation asks, so a shape reported open is exactly
     * one this catalog is still requesting keys for, and the two cannot disagree.
     */
    if (open(one)) found.open = true;

    shapes.set(key, found);
  }

  return [...shapes.values()].sort(byShape);
};

/**
 * The markets a venue publishes, with enough of each to decide where to look.
 *
 * **The datasets are named rather than counted**, because "this market has four
 * datasets" answers nothing a caller can act on, and the names are what they
 * came for.
 */
export const intoMarkets = (rows: readonly Publishing[]): MarketContents[] => {
  const markets = new Map<string, Map<string, Held>>();
  const symbols = new Map<string, Set<string>>();

  for (const shape of intoShapes(rows)) {
    const datasets = markets.get(shape.market) ?? new Map<string, Held>();
    const found    = datasets.get(shape.dataset) ?? {
      shapes: 0, variants: new Set<string>(), grains: new Set<string>(), symbols: new Set<string>(),
    };

    found.shapes++;
    found.grains.add(shape.grain);

    const variant = Object.values(shape.variant).join(',');

    if (variant) found.variants.add(variant);

    datasets.set(shape.dataset, found);
    markets.set(shape.market, datasets);
  }

  /**
   * **Counted off the series, not off the shapes.** One instrument carries many
   * shapes, so summing a shape's `symbols` would count it once per bar length.
   */
  for (const one of rows) {
    if (one.symbol === BUCKET) continue;

    const held = symbols.get(one.market) ?? new Set<string>();

    held.add(one.symbol);
    symbols.set(one.market, held);

    markets.get(one.market)?.get(one.dataset)?.symbols.add(one.symbol);
  }

  return [...markets.entries()]
    .map(([market, datasets]) => ({
      market,
      datasets: [...datasets.entries()]
        .map(([dataset, held]) => ({
          dataset,
          shapes:   held.shapes,
          variants: [...held.variants].sort(),
          grains:   [...held.grains].sort(),
          symbols:  held.symbols.size,
        }))
        .sort((a, b) => a.dataset.localeCompare(b.dataset)),
      symbols: symbols.get(market)?.size ?? 0,
    }))
    .sort((a, b) => a.market.localeCompare(b.market));
};

/**
 * Every instrument named in these rows, once each.
 *
 * **The venue-wide file is not an instrument.** `@` is the catalog's own name for
 * a file carrying every instrument of a market at once, so listing it beside real
 * symbols would offer a name nothing trades — `buckets` on a shape is where that
 * is reported instead.
 *
 * **Not paged.** The largest answer is a few thousand strings, and it is asked
 * by somebody deciding what to fetch rather than in a loop.
 */
export const intoSymbols = (rows: readonly Publishing[]): string[] =>
  [...new Set(rows.filter(one => one.symbol !== BUCKET).map(one => one.symbol))].sort();

// ── Internals ─────────────────────────────────────────────────────────────────

/** One dataset's counts while they accumulate, before the sets become sizes. */
interface Held {
  shapes:   number;
  variants: Set<string>;
  grains:   Set<string>;
  symbols:  Set<string>;
}

const byShape = (a: Shape, b: Shape): number =>
  a.market.localeCompare(b.market)
  || a.dataset.localeCompare(b.dataset)
  || JSON.stringify(a.variant).localeCompare(JSON.stringify(b.variant))
  || a.grain.localeCompare(b.grain);
