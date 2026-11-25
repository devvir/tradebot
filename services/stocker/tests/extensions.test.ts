import { describe, expect, it } from 'vitest';
import { ensureExtensions } from '../src/db';
import { whyUnavailable } from './reachable';
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

/**
 * A connection whose `INSTALL` of `stalled` never answers until interrupted, as
 * on a host whose network drops the download; anything else succeeds.
 */
const unanswered = () => {
  const seen: string[] = [];
  let interrupt = () => {};
  const conn = {
    run: (sql: string) => sql === 'INSTALL stalled'
      ? new Promise((_, reject) => { interrupt = () => reject(new Error('Interrupted')); })
      : Promise.resolve(),
    interrupt: () => { seen.push('interrupt'); interrupt(); },
    closeSync: () => { seen.push('close'); },
  } as unknown as DuckDBConnection;

  return { conn, seen };
};

describe('probing whether a host can have an extension', () => {
  it('says nothing, and closes the connection, when the extension can be had', async () => {
    const { conn, seen } = unanswered();

    expect(await whyUnavailable(conn, ['ready'], 'xlsx', 1_000)).toBeUndefined();
    expect(seen).toEqual(['close']);
  });

  it('gives the reason when the install fails', async () => {
    const { conn } = fake({ offline: true });
    const closable = { closeSync: () => {}, interrupt: () => {} };

    expect(await whyUnavailable(Object.assign(conn, closable), ['absent'], 'xlsx', 1_000))
      .toMatch(/'absent' extension, which could not be installed or loaded: Failed to download/);
  });

  /** A download nobody answers gives up at the deadline instead of holding the run until it times out. */
  it('gives up on an install that does not answer in time, and interrupts it', async () => {
    const { conn, seen } = unanswered();
    const started        = Date.now();

    expect(await whyUnavailable(conn, ['stalled'], 'xlsx', 50)).toMatch(/did not answer within 0.05s/);
    expect(Date.now() - started).toBeLessThan(1_000);

    await new Promise(resolve => setImmediate(resolve));
    expect(seen).toEqual(['interrupt', 'close']);
  });
});
