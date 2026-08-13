import { access, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import SK from './service';
import config from './config';
import { sweepScratch } from './build';
import { open } from './db';
import * as ledger from './ledger';
import { report, sweep } from './scan';

/**
 * Raw is read-only to this service and must never be written to, so it is
 * checked for readability rather than writability — a mount that arrived
 * read-write would still work, but one that is missing should fail loudly here
 * rather than as an empty scan that looks like "nothing to do".
 */
const assertReadable = async (dir: string): Promise<void> => {
  try {
    await access(dir);
  } catch {
    throw new Error(
      `Raw directory '${dir}' is not readable. It is the collectors' output, mounted read-only.`,
    );
  }

  logger.info({ dir }, 'Raw directory ready');
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
 * must already exist. A `const` arrow function further down the file is still in
 * its temporal dead zone at that moment.
 */
SK.run(async () => {
  await assertReadable(config.truckerDir);
  await assertWritable(config.vaultDir);

  await sweepScratch();

  // Stated before the first sweep, because a consumer reading the vault while
  // stocker is still starting should already be able to tell a venue that is
  // one month short by design from one that is one month behind.
  ledger.publishTraits();

  const { conns } = await open();

  /**
   * Long-lived rather than a batch job, so raw that lands while nobody is
   * watching is picked up on its own. "Nothing to do" from a completed sweep is
   * then a signal worth acting on: every raw file visible has been normalised,
   * and once backed up it is safe to delete locally.
   */
  let sweeping = false;

  const pass = async (): Promise<void> => {
    if (sweeping) {
      logger.info('Sweep still running — skipping this scan');

      return;
    }

    sweeping = true;

    try {
      report(await sweep(conns), config.scanMinutes);
    } catch (err) {
      logger.error({ err }, 'Sweep failed');
    } finally {
      sweeping = false;
    }
  };

  await pass();

  // No 'now watching' line: the sweep report above already ends with when the
  // next one runs, and saying it twice makes the log noisier, not clearer.
  setInterval(() => void pass(), config.scanMinutes * 60 * 1000);
});
