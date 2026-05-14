import { C } from '../../../shared/utils/colors';
import { info, spacer } from '../log';
import { loadConfig } from '../scan/config';
import { scanAll } from '../scan';
import { checkMegaAvailable } from '../scan/mega';
import { deriveTasks, findRsyncTemps } from './tasks';
import { printSummary } from './display';
import { runInteractive } from './interactive';

/**
 * `data sync` entry point.
 *
 * Scans local, remotes, and Mega; derives the pending task list; prints the
 * summary; then walks the interactive Y/n/a prompt loop.
 */
export async function runSync(): Promise<void> {
  const config = loadConfig();

  spacer();
  console.log(`${C.bold}${C.cyan}Data — sync${C.reset}`);
  spacer();

  info(`Local vault : ${config.localBase}`);
  info(`Remotes     : ${config.remotes.length === 0 ? '(none)' : config.remotes.map(r => r.name).join(', ')}`);
  info(`Mega vault  : ${config.megaVault}`);
  info(`Mega raw    : ${config.megaRaw}`);
  spacer();

  await checkMegaAvailable();

  info('Scanning local, remotes, and Mega …');

  const state     = await scanAll(config);
  const rsyncTask = findRsyncTemps(config.localBase);
  const tasks     = [
    ...(rsyncTask ? [rsyncTask] : []),
    ...deriveTasks(state, 'planned'),
  ];

  printSummary(tasks);
  await runInteractive(tasks, state);
}
