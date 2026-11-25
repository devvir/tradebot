import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import config from '../config';
import { SCRATCH } from '../containers';
import { keepPieces } from './pieces';

/** Under scratch: where partitions are built before they are put in the vault. */
const STAGE = 'stage';

/**
 * Clear what a hard kill leaves behind in `<vault>/.stocker-tmp`, where
 * everything transient is: extractions, part-built partitions, the engine's
 * spill. Run before the engine is opened, so none of it is in use.
 *
 * **All of it goes but the pieces that are built** — see `finishPiece`: hours
 * of a partition that was being built a piece at a time, which the next build
 * of it takes up.
 *
 * `<vault>/.duckdb-tmp`, an engine spill directory outside scratch, goes too
 * wherever it is found.
 */
export const sweepScratch = async (): Promise<void> => {
  const scratch = join(config.vaultDir, SCRATCH);

  await rm(join(config.vaultDir, '.duckdb-tmp'), { recursive: true, force: true }).catch(() => {});

  for (const name of await readdir(scratch).catch(() => [] as string[]))
    if (name !== STAGE) await rm(join(scratch, name), { recursive: true, force: true }).catch(() => {});

  const kept = [];

  for (const name of await readdir(join(scratch, STAGE)).catch(() => [] as string[])) {
    await keepPieces(join(scratch, STAGE, name));

    if (await readdir(join(scratch, STAGE, name)).then(() => true, () => false)) kept.push(name);
  }

  if (kept.length > 0) logger.info({ partitions: kept }, 'Scratch cleared — pieces built before are kept, to be taken up');
  else logger.info('Scratch cleared');
};
