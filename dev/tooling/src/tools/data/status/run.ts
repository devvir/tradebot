import { info, warn } from '../log';
import { loadConfig } from '../scan/config';
import { scanAll } from '../scan';
import { checkDatabaseAvailable } from '../scan/database';
import { checkMegaAvailable } from '../scan/mega';
import { printTable } from './display';

/** Background refresh cadence for watch mode. */
const REFRESH_MS = 30 * 1000;

interface StatusOptions {
  /**
   * When true (default), stay alive after the first render and silently
   * re-scan + re-print every two minutes. When false, render once and return
   * — used by `data sync -y` so unattended runs don't hang.
   */
  watch?: boolean;
}

/**
 * `data status` entry point.
 *
 * Loads the scan config, verifies `mega-cmd` and Redis are reachable, scans
 * every location (local, remotes, Mega, database), and renders the wide
 * per-table state grid. Read-only — never mutates the vault.
 *
 * In watch mode it then stays alive, clearing the screen and re-scanning every
 * two minutes so an open terminal always shows fresh state. The refresh is
 * silent: only the grid is re-printed, never the config/progress lines.
 * Ctrl+C exits.
 */
export async function runStatus({ watch = true }: StatusOptions = {}): Promise<void> {
  const config = loadConfig();

  info(`Local vault: ${config.localBase}`);
  info(`Remotes: ${config.remotes.length === 0 ? '(none)' : config.remotes.map(r => r.name).join(', ')}`);
  info(`Mega vault: ${config.megaVault}`);
  info(`Mega raw:   ${config.megaRaw}`);

  await checkMegaAvailable();
  await checkDatabaseAvailable();

  info('Scanning local, remotes, Mega, and database …');

  const state = await scanAll(config);

  if (watch) process.stdout.write('\x1b[2J\x1b[H');

  await printTable(state);

  if (! watch) return;

  // Stay alive: silently re-scan and re-print every two minutes. The last
  // good scan is kept so a transient mega/redis failure shows a stale grid
  // (with its scanned-at timestamp) instead of crashing the watch.
  let lastGood = state;

  const refresh = async (): Promise<void> => {
    let next = lastGood;
    let failed: string | null = null;

    try {
      next     = await scanAll(config);
      lastGood = next;
    } catch (err) {
      failed = (err as Error).message;
    }

    await printTable(next);

    if (failed) warn(`Refresh failed: ${failed} — showing last good scan, retrying in 2 min`);

    setTimeout(() => { void refresh(); }, REFRESH_MS);
  };

  setTimeout(() => { void refresh(); }, REFRESH_MS);
}
