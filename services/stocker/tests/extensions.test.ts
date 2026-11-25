import { describe, expect, it } from 'vitest';
import { ensureExtensions } from '../src/db';
import type { DuckDBConnection } from '@duckdb/node-api';

/** A connection that records what it is asked to run, and fails `INSTALL` while `offline` says so. */
const fake = (state: { offline: boolean }) => {
  const ran: string[] = [];
  const conn = {
    run: async (sql: string) => {
      ran.push(sql);
      await new Promise(resolve => setTimeout(resolve, 5));
      if (state.offline && sql.startsWith('INSTALL')) throw new Error('Failed to download extension');
    },
  } as unknown as DuckDBConnection;

  return { conn, ran };
};

describe('loading the extensions a format needs', () => {
  /** Installing can mean a download; it happens once, however many builds ask. */
  it('installs an extension once for every build that asks, and loads it on each', async () => {
    const { conn, ran } = fake({ offline: false });

    await Promise.all([ensureExtensions(conn, ['once'], 'xlsx'), ensureExtensions(conn, ['once'], 'xlsx')]);
    await ensureExtensions(conn, ['once'], 'xlsx');

    expect(ran.filter(sql => sql === 'INSTALL once')).toHaveLength(1);
    expect(ran.filter(sql => sql === 'LOAD once')).toHaveLength(3);
  });

  it('names the format and the extension when it cannot be had', async () => {
    const { conn } = fake({ offline: true });

    await expect(ensureExtensions(conn, ['missing'], 'xlsx')).rejects.toThrow(
      /xlsx series need the DuckDB 'missing' extension, which could not be installed or loaded: Failed to download/);
  });

  /** A failed download is not the last word: the next build tries again. */
  it('tries again after a failed install', async () => {
    const state         = { offline: true };
    const { conn, ran } = fake(state);

    await expect(ensureExtensions(conn, ['flaky'], 'xlsx')).rejects.toThrow();

    state.offline = false;
    await ensureExtensions(conn, ['flaky'], 'xlsx');

    expect(ran.filter(sql => sql === 'INSTALL flaky')).toHaveLength(2);
    expect(ran).toContain('LOAD flaky');
  });
});
