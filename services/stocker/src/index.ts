import { access, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import SK from './service';
import config from './config';
import { sweepScratch } from './build';
import { pool } from './containers';
import { open } from './db';
import { Scans, drain } from './drain';
import { validate } from './ledger';
import { SCAN_MINUTES, report, sweep } from './scan';

/**
 * The archives are read-only to this service and must never be written to, so
 * they are checked for readability rather than writability — a mount that is
 * missing should fail loudly here rather than as a sweep that finds nothing on
 * disk.
 */
const assertReadable = async (dir: string): Promise<void> => {
  try {
    await access(dir);
  } catch {
    throw new Error(`Archives directory '${dir}' is not readable. It is hauler's, mounted read-only.`);
  }

  logger.info({ dir }, 'Archives directory ready');
};

const assertWritable = async (dir: string): Promise<void> => {
  const probe = join(dir, '.stocker-write-test');

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, '');
    await unlink(probe);
  } catch (err) {
    throw new Error(
      `Vault directory '${dir}' is not writable (${(err as Error).message}). ` +
      `Create the host directory and give it to uid 1000: ` +
      `sudo mkdir -p <host-dir> && sudo chown 1000:1000 <host-dir>`,
    );
  }

  logger.info({ dir }, 'Vault directory ready');
};

/**
 * Declared above rather than below, deliberately: `SK.run` invokes its callback
 * while this module is still evaluating, so the first thing the callback touches
 * must already exist.
 *
 * Shutdown — SIGTERM or SIGINT, through service-kit — drains the sweeps: see
 * `drain`. It is listened for before anything else is done, so a signal during
 * the checks below exits without a sweep ever starting.
 */
SK.run(async (service) => {
  const scans = new Scans(SCAN_MINUTES * 60 * 1000);

  let closeEngine = (): void => {};

  service.on('shutdown', () => drain(scans, config.drainSeconds * 1000, { engine: () => closeEngine(), pool: () => pool.close() }));

  await assertReadable(config.archivesDir);
  await assertWritable(config.vaultDir);

  await sweepScratch();

  // Once, before the first sweep: what the ledger says against what the vault holds.
  await validate();

  const { conns, close } = await open();

  closeEngine = close;

  /**
   * "Caught up" from a completed sweep is a signal worth acting on: everything
   * in scope that is on disk is stocked.
   */
  await scans.start(async stop => report(await sweep(conns, stop), SCAN_MINUTES));
});
