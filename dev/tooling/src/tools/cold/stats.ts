import { loadConfig } from './config';
import * as record from './record';
import { fmtBytes } from '../../shared/utils/format';
import { info, spacer, table } from '../../shared/ui/logger';
import type { Origin } from './types';

/** What the record holds of one origin, venue by venue. */
export const runStats = async (origin: Origin): Promise<void> => {
  const config = loadConfig(origin);
  const db     = record.open(config.dbPath);

  try {
    const tars   = record.tarsOf(db, origin);
    const venues = [...new Set(tars.map(tar => tar.venue))].sort();

    if (tars.length === 0) {
      info(`Nothing recorded for ${origin} yet`);

      return;
    }

    spacer();

    table(venues.map(venue => {
      const own    = tars.filter(tar => tar.venue === venue);
      const stored = own.filter(tar => tar.state === 'stored');
      const months = [...new Set(own.map(tar => tar.month))].sort();

      return {
        venue,
        months:     `${months[0]}–${months[months.length - 1]}`,
        tars:       `${stored.length}/${own.length}`,
        partitions: record.heldOf(db, origin, venue).length,
        stored:     fmtBytes(stored.reduce((sum, tar) => sum + (tar.bytes ?? 0), 0)),
      };
    }), ['venue', 'months', 'tars', 'partitions', 'stored']);

    const all = record.totals(db, origin);

    spacer();
    info(`${all.stored}/${all.tars} tars stored · ${fmtBytes(all.storedBytes)} · ${all.partitions} partitions`);
  } finally {
    record.close(db);
  }
};
