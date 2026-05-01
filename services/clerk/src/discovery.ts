import { listTables, listFiles } from './vault';

export interface DateBatch {
  date:   string;
  tables: string[];
}

/**
 * Discovers closed vault files across all tables and groups them by date.
 *
 * Open files are intentionally skipped: vault refuses to serve them anyway,
 * and the next poll cycle will pick them up once they close. Returned batches
 * are sorted by date ascending; tables within a batch are sorted alphabetically.
 */
export const discoverFiles = async (
  vaultUrl: string,
  filter:   string[] = [],
): Promise<DateBatch[]> => {
  const allTables = await listTables(vaultUrl);
  const tables    = filter.length > 0 ? allTables.filter(t => filter.includes(t)) : allTables;

  const byDate = new Map<string, string[]>();

  await Promise.all(tables.map(async (table) => {
    const files = await listFiles(vaultUrl, table);

    if (! files) return;

    for (const [date, state] of Object.entries(files)) {
      if (state !== 'closed') continue;

      const entry = byDate.get(date) ?? [];

      entry.push(table);
      byDate.set(date, entry);
    }
  }));

  return [...byDate.keys()].sort().map(date => ({
    date,
    tables: byDate.get(date)!.sort(),
  }));
};
