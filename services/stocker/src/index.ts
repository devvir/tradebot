import { access, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import SK from './service';
import config from './config';
import { sweepScratch } from './build';
import { open } from './db';
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
 */
SK.run(async () => {
  await assertReadable(config.archivesDir);
  await assertWritable(config.vaultDir);

  await sweepScratch();

  // Once, before the first sweep: what the ledger says against what the vault holds.
  await validate();

  const { conns } = await open();

  /**
   * Long-lived rather than a batch job, so files that land while nobody is
   * watching are picked up on its own. "Caught up" from a completed sweep is
   * then a signal worth acting on: everything in scope that is on disk is
   * stocked.
   */
  let sweeping = false;

  const pass = async (): Promise<void> => {
    if (sweeping) {
      logger.info('Sweep still running — skipping this scan');

      return;
    }

    sweeping = true;

    try {
      report(await sweep(conns), SCAN_MINUTES);
    } catch (err) {
      logger.error({ err }, 'Sweep failed');
    } finally {
      sweeping = false;
    }
  };

  await pass();

  setInterval(() => void pass(), SCAN_MINUTES * 60 * 1000);
});
