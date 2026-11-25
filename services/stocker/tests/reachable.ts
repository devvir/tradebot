import type { DuckDBConnection } from '@duckdb/node-api';
import { ensureExtensions } from '../src/db';

/** How long an install may go unanswered before the extension counts as unavailable. */
export const PROBE_MS = 15_000;

/**
 * Why `extensions` cannot be had on this host, or nothing when they can.
 *
 * Installing an extension downloads it from DuckDB's extension repository, and
 * a host whose network drops that traffic leaves the download waiting with no
 * answer. So an install still unanswered after `ms` counts as unavailable, and
 * is interrupted rather than awaited.
 *
 * The probe owns `conn` and closes it once nothing runs on it any more.
 */
export const whyUnavailable = async (
  conn: DuckDBConnection, extensions: readonly string[], format: string, ms = PROBE_MS,
): Promise<string | undefined> => {
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const close    = () => conn.closeSync();
  const work     = ensureExtensions(conn, extensions, format).finally(() => { settled = true; });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`DuckDB's extension repository did not answer within ${ms / 1000}s`)), ms);
  });

  try {
    await Promise.race([work, deadline]);

    return undefined;
  } catch (err) {
    return (err as Error).message;
  } finally {
    clearTimeout(timer);

    if (settled) close();
    else {
      conn.interrupt();
      work.then(close, close);
    }
  }
};
