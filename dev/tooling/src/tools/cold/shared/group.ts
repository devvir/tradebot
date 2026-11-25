/**
 * Items grouped by a key, each group in the order its items came. An item whose
 * key is null is left out.
 *
 * Each group is grown in place, so a group of hundreds of thousands of items
 * costs what its items do and no more.
 */
export const groupBy = <K, V>(items: Iterable<V>, keyOf: (item: V) => K | null): Map<K, V[]> => {
  const groups = new Map<K, V[]>();

  for (const item of items) {
    const key = keyOf(item);

    if (key === null) continue;

    const group = groups.get(key);

    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  return groups;
};
