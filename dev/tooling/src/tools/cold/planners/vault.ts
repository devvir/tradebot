import { binPack } from '../plan';
import { scanVault } from '../scan';
import { idOf, idsByMonth } from '../ledger';
import { C } from '../../../shared/utils/colors';
import { info, warn } from '../../../shared/ui/logger';
import * as db from '../db';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ColdConfig, IncompleteMonth, PartitionKey, PendingGroup, PendingPlan, Planner, SourceFile,
} from '../types';

/**
 * Stocker's normalised partitions.
 *
 * **The whole tree is compared every run, and the comparison is the scheduler.**
 * It makes no distinction between a first pack, a month collected since, a
 * dataset nobody was collecting before, or a partition stocker has rebuilt —
 * all of them are files whose path, size or mtime does not appear in `member`,
 * and all are packed the same way. There is no branch for any of those cases.
 *
 * That is affordable here and only here. The vault is 190,000 partitions, and
 * stocker rewrites them in place — so a per-file comparison is both cheap and
 * the only thing that would notice a rebuild. The raw archives are neither.
 */
export const vault: Planner = {
  async pending(
    handle: DatabaseSync,
    config: ColdConfig,
    venues: string[],
  ): Promise<PendingPlan> {
    info(`Scanning ${config.sourceRoot} …`);

    /**
     * **The filter is applied here, not after.** A run named for three venues
     * that reports on seven has done the work of seven — and worse, it says
     * things about the four nobody asked about. `push vault bitget okx` warned
     * at length about bybit's incomplete months, which are neither news nor
     * anything that run could act on.
     *
     * The whole tree is still walked: `venue=` is the top level today and may
     * not be tomorrow, and a walk is cheap next to the ledger read and the
     * per-file comparison that this skips.
     */
    const wanted = (venue: string): boolean =>
      venues.length === 0 || venues.includes(venue);

    const files = (await scanVault(config.sourceRoot)).filter(file => wanted(file.venue));
    const known = db.packed(handle, 'vault');

    const pending: SourceFile[] = [];

    for (const file of files) {
      const seen = known.get(file.path);

      if (! seen || seen.bytes !== file.bytes || seen.mtime !== file.mtime) pending.push(file);
    }

    /**
     * **"Planned" is not "backed up".** A row in `member` only says a file has
     * been assigned to a part; the part may not have been packed, let alone
     * uploaded. Reporting the two together made a first run look as though the
     * whole vault was already in cold storage.
     *
     * Counted from the same rows the gate needs anyway, rather than from a
     * separate query, so every number on this line is about the same selection
     * of venues.
     */
    const uploaded = db.uploaded(handle, 'vault').filter(row => wanted(row.venue));
    const inCold   = uploaded.length;

    info(`${files.length.toLocaleString()} partitions · `
      + `${inCold.toLocaleString()} in cold storage · `
      + `${(files.length - inCold - pending.length).toLocaleString()} planned, not yet uploaded · `
      + `${pending.length.toLocaleString()} to plan`);

    return await whole(config, files, uploaded, byMonth(pending));
  },

  pack: binPack,
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Drop any month the vault does not hold in full.
 *
 * **A month is packed once, and what it holds when it is packed is what cold
 * storage says it is.** The files present say which partitions are here, never
 * whether that is all of them — so packing whatever is on disk records a
 * fragment as a finished month, and the record then reads as coverage that does
 * not exist. That is not hypothetical: most of bybit's vault was parked on
 * another disk while the real one was full, and 45 months went into cold storage
 * from the remains, one of them holding 1 partition out of the 133 stocker had
 * built.
 *
 * Stocker's ledger is what knows the difference, and it is the same shape of
 * dependency `push archives` already has on the collector's published tips: the
 * producer says what a month is, and cold storage does not guess.
 *
 * **A partition counts as present if it is on disk *or* already in cold
 * storage.** The second half is what keeps `cold evict vault` compatible with
 * this — an evicted partition is gone from disk on purpose and is not a hole.
 *
 * **There is no override.** An incomplete month is not a formality to wave
 * through: it means partitions stocker built are missing and nothing has them.
 * A flag to pack anyway would turn the one signal that surfaces that into a
 * prompt people learn to answer.
 *
 * A venue the ledger says nothing about is left alone rather than refused — an
 * absent ledger is not evidence of a missing partition, and blocking on it would
 * stop a venue nobody has a record for from ever being backed up.
 */
const whole = async (
  config:   ColdConfig,
  files:    SourceFile[],
  uploaded: PartitionKey[],
  groups:   PendingGroup[],
): Promise<PendingPlan> => {
  if (groups.length === 0) return { groups, withheld: 0 };

  /** Every partition that exists somewhere: on disk now, or backed up already. */
  const present = new Set<string>();

  for (const file of files) present.add(idOf(file));
  for (const row of uploaded) present.add(idOf(row));

  const ledgers    = new Map<string, Map<string, Set<string>>>();
  const complete: PendingGroup[] = [];
  const short:    IncompleteMonth[] = [];

  for (const group of groups) {
    if (! ledgers.has(group.venue))
      ledgers.set(group.venue, await idsByMonth(config.vaultRoot, group.venue));

    const built = ledgers.get(group.venue)!.get(group.month);

    if (! built) { complete.push(group); continue; }

    let missing = 0;

    for (const id of built) if (! present.has(id)) missing++;

    if (missing === 0) complete.push(group);
    else short.push({ venue: group.venue, month: group.month, built: built.size, missing });
  }

  report(short);

  return { groups: complete, withheld: short.length };
};

/**
 * Say which months were refused and how badly, grouped by venue.
 *
 * **The aggregate is the diagnosis.** One month short is a partition that has
 * not landed yet; forty months short across one venue is a disk that went
 * missing, and only the grouping says which of those is happening. The worst
 * month is named because the ratio is what tells the two apart at a glance.
 */
const report = (short: IncompleteMonth[]): void => {
  if (short.length === 0) return;

  const venues = new Map<string, IncompleteMonth[]>();

  for (const month of short) venues.set(month.venue, [...venues.get(month.venue) ?? [], month]);

  const partitions = short.reduce((total, month) => total + month.missing, 0);

  warn(`${short.length} month${short.length === 1 ? '' : 's'} not packed — `
    + `${partitions.toLocaleString()} partitions stocker built are neither on disk nor in cold storage`);

  for (const [venue, months] of [...venues].sort()) {
    const worst = [...months].sort((a, b) => b.missing / b.built - a.missing / a.built)[0]!;

    info(`${C.dim}    ${venue.padEnd(9)}${String(months.length).padStart(4)} month`
      + `${months.length === 1 ? ' ' : 's'} · `
      + `${months.reduce((total, month) => total + month.missing, 0).toLocaleString()} partitions missing · `
      + `worst ${worst.month} (${worst.missing} of ${worst.built})${C.reset}`);
  }

  info(`${C.dim}    Restore what is missing and run again; nothing is packed until a month is whole.${C.reset}`);
};

/**
 * Grouped by venue-month, because that is the scope a set of tars covers.
 *
 * `closedAt` is null: the vault has no producer signal saying a month is
 * finished, and none is wanted — a month collected later simply adds parts
 * beside the ones already there. A null is also what stops a month row being
 * written for a tree that would never consult one.
 */
const byMonth = (files: SourceFile[]): PendingGroup[] => {
  const months = new Map<string, SourceFile[]>();

  for (const file of files) {
    const id = `${file.venue} ${file.month}`;

    months.set(id, [...(months.get(id) ?? []), file]);
  }

  return [...months.entries()].sort().map(([id, group]) => {
    const [venue, month] = id.split(' ') as [string, string];

    return { venue, month, closedAt: null, files: group };
  });
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_whole = whole;
