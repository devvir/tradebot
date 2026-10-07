/**
 * Order pairs by their key.
 *
 * **A sort with nothing to go by turns each pair into a string to compare
 * them** — key and value both. That is the key's order only by accident, and it
 * throws outright where a value cannot be made a string: a row read from the
 * record has no `toString`. So pairs are always ordered by saying what by.
 */
export const byKey = <T>([a]: readonly [string, T], [b]: readonly [string, T]): number =>
  (a < b ? -1 : a > b ? 1 : 0);
