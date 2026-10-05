import { loadConfig } from './config';
import * as db from './db';
import { fmtBytes } from '../../shared/utils/format';
import { info, spacer, success } from '../../shared/ui/logger';
import type { Origin } from './types';

/**
 * What cold storage holds, shallowly.
 *
 * Deliberately one summary rather than the drill-down by venue and symbol we
 * will want: the interesting cuts are the ones a restore asks for, and those
 * are better shaped against a table with real data in it than guessed at now.
 */
export const runStats = async (origin: Origin): Promise<void> => {
  const config = loadConfig(origin);
  const handle = db.open(config.dbPath);

  try {
    const totals = db.totals(handle, origin);

    spacer();

    if (totals.parts === 0) {
      info(`Nothing from ${origin} is in cold storage yet`);

      return;
    }

    const pending = totals.parts - totals.uploaded;

    info(`origin      ${origin}`);
    info(`parts       ${totals.uploaded.toLocaleString()} uploaded`
      + (pending > 0 ? `, ${pending.toLocaleString()} pending` : '')
      + ` of ${totals.parts.toLocaleString()}`);
    info(`files       ${totals.files.toLocaleString()}`);
    info(`size        ${fmtBytes(totals.uploadedBytes)} in Mega of ${fmtBytes(totals.bytes)} planned`);

    spacer();

    const venues = db.byVenue(handle, origin);

    for (const row of venues)
      info(`  ${row.venue.padEnd(10)} ${String(row.parts).padStart(5)} parts  `
        + `${fmtBytes(row.bytes).padStart(10)}  ${row.months} month${row.months === 1 ? '' : 's'}`);

    spacer();

    if (pending === 0) success('Everything planned is in cold storage');
  } finally {
    db.close(handle);
  }
};
