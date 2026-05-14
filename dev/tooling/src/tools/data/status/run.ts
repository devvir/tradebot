import { info } from '../log';
import { loadConfig } from '../scan/config';
import { scanAll } from '../scan';
import { checkMegaAvailable } from '../scan/mega';
import { printTable } from './display';

/**
 * `data status` entry point.
 *
 * Loads the scan config, verifies `mega-cmd` is reachable, scans every
 * location (local, remotes, Mega), and renders the wide per-table state grid.
 * Read-only — never mutates the vault.
 */
export async function runStatus(): Promise<void> {
  const config = loadConfig();

  info(`Local vault: ${config.localBase}`);
  info(`Remotes: ${config.remotes.length === 0 ? '(none)' : config.remotes.map(r => r.name).join(', ')}`);
  info(`Mega vault: ${config.megaVault}`);
  info(`Mega raw:   ${config.megaRaw}`);

  await checkMegaAvailable();

  info('Scanning local, remotes, and Mega …');

  const state = await scanAll(config);

  await printTable(state);
}
