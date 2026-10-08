import { loadConfig } from '../config';
import * as record from '../shared/record';
import { fmtBytes } from '../../../shared/utils/format';
import { info, spacer, table } from '../../../shared/ui/logger';
import { locate } from '../shared/vault/layout';
import { stockedIn } from '../shared/vault/ledger';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Origin } from '../types';

/** What the record holds of one origin, venue by venue. */
export const runStats = async (origin: Origin): Promise<void> => {
  const config = loadConfig(origin);
  const db     = record.open(config.dbPath);

  try {
    if (origin === 'vault') return vaultStats(db, config);

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

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The vault, venue by venue: how much of what its ledger holds is in cold
 * storage, and how much of that is away from the disk right now.
 */
const vaultStats = (db: DatabaseSync, config: ColdConfig): void => {
  const ledger = stockedIn(config.vaultRoot);

  if (! ledger) {
    info(`No ledger in ${config.vaultRoot} — nothing is known of the vault`);

    return;
  }

  const current = new Map(ledger.map(one => [one.partition, one.revision]));
  const stored  = record.vaultStored(db);
  const files   = record.vaultFiles(db).filter(file => current.get(file.partition) === file.revision);
  const venueOf = (partition: string): string => locate(partition).levels['venue'] ?? '';
  const venues  = [...new Set(ledger.map(one => venueOf(one.partition)))].sort();

  spacer();

  table(venues.map(venue => {
    const own    = ledger.filter(one => venueOf(one.partition) === venue);
    const safe   = own.filter(one => stored.get(one.partition)?.has(one.revision));
    const held   = files.filter(file => venueOf(file.partition) === venue && file.state === 'stored');
    const away   = held.filter(file => file.evictedAt !== null);
    const months = own.map(one => locate(one.partition).month).sort();

    return {
      venue,
      months:     `${months[0]}–${months[months.length - 1]}`,
      partitions: `${safe.length}/${own.length}`,
      files:      held.length,
      stored:     fmtBytes(held.reduce((sum, file) => sum + file.bytes, 0)),
      away:       away.length === 0 ? '—' : `${away.length} · ${fmtBytes(away.reduce((sum, file) => sum + file.bytes, 0))}`,
    };
  }), ['venue', 'months', 'partitions', 'files', 'stored', 'away']);

  const safe = ledger.filter(one => stored.get(one.partition)?.has(one.revision)).length;

  spacer();
  info(`${safe}/${ledger.length} partitions stored · ${fmtBytes(files.filter(file => file.state === 'stored').reduce((sum, file) => sum + file.bytes, 0))}`);
};
