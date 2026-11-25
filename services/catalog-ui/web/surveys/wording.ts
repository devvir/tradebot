/**
 * How a pass is put into words: when, how long, and by what mechanism.
 */

/** A timestamp to the minute, with a space for its `T`. */
export const when = (at: string): string => at.slice(0, 16).replace('T', ' ');

/**
 * How long a pass took, in one unit.
 *
 * **The largest unit the duration fills at least once**, rounded to a whole
 * number of it: a run is compared against other runs of the same venue, where
 * the question is whether it took minutes or hours, and a second figure never
 * changes that answer. `4h` is the whole fact about a walk; `4h 03m` is the same
 * fact costing twice the width.
 */
export const took = (from: string, to: string): string => {
  const ms = Date.parse(to) - Date.parse(from);

  const units: [number, string][] = [
    [86400000, 'd'],
    [3600000,  'h'],
    [60000,    'm'],
    [1000,     's'],
  ];

  for (const [size, unit] of units)
    if (ms >= size) return `${Math.round(ms / size)}${unit}`;

  return `${Math.max(ms, 0)}ms`;
};

/** How a pass reads a venue, for the tooltip under a word that does not say. */
export const howOf = (kind: 'walk' | 'update'): string =>
  (kind === 'walk'
    ? 'Walking the listing'
    : 'Probing files');
