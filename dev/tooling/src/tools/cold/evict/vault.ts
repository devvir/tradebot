import { scanVault } from '../scan';
import { reclaim } from './reclaim';
import { fmtBytes } from '../../../shared/utils/format';
import { C } from '../../../shared/utils/colors';
import * as db from '../db';
import { info, spacer, warn } from '../../../shared/ui/logger';
import { confirm } from '../../../shared/ui/prompts';
import type { DatabaseSync } from 'node:sqlite';
import { HELD_REASONS } from '../types';
import type {
  ColdConfig, EvictGroup, HeldPartition, HeldReason, SourceFile, VaultFilter,
} from '../types';

/**
 * Reclaim vault partitions that are provably in Mega, a selection at a time.
 *
 * **One question, and it is per file: is this exact partition — path, size and
 * mtime — inside a tar Mega holds?** The archives ask a second one, whether the
 * raw ever became a partition, because raw exists in order to become one and raw
 * that became none is a modelling gap worth stopping on. A partition is the end
 * of the line, so there is no equivalent here and nothing to substitute for it.
 *
 * That holds under both ways the tree changes underneath it. A rebuilt partition
 * is written in place, so its mtime moves and it reads as not-in-Mega until
 * `cold push vault` repacks it. A newly modelled dataset is all-new paths, so it
 * appends as the next part and touches nothing already backed up. In both cases
 * the partitions that were evicted are irrelevant: what comes back is new bytes
 * either way, and cold storage takes them as an update or as an addition.
 *
 * **Selective, because that is what it is for.** The vault is what gets pulled
 * back down to work with, so the normal shape is "keep every BTC and ETH future,
 * reclaim the rest" — a filter across venue, market, dataset, symbol and period
 * rather than a sweep. A selection cuts across tars freely: a tar says a
 * partition *can* be restored, not that it is the only thing riding on that
 * object.
 *
 * **Nothing that is not in Mega goes, and there is no override.** Matching
 * partitions cold storage does not hold are named and kept. A filter is a
 * request for what to reclaim, never permission to lose the only copy of
 * something.
 */
export const evictVault = async (
  handle: DatabaseSync,
  config: ColdConfig,
  filter: VaultFilter,
  purge:  boolean,
): Promise<void> => {
  info(`Scanning ${config.sourceRoot} …`);

  const all     = await scanVault(config.sourceRoot);
  const matched = all.filter(file => matches(file, filter));

  spacer();
  info(`Selection: ${describe(filter)}`);
  info(`${all.length.toLocaleString()} partitions in the vault · `
    + `${matched.length.toLocaleString()} matching`);

  if (matched.length === 0) {
    spacer();
    info('Nothing matches — nothing to evict');

    return;
  }

  /**
   * What Mega holds, as it was when packed.
   *
   * Read for the whole vault rather than per venue: the filter may name several
   * venues or none, and the map is one row per uploaded member — the vault is
   * 190,000 partitions, not the archives' 2.5 million files.
   */
  const cold = new Map<string, { bytes: number; mtime: number }>();

  for (const row of db.uploaded(handle, 'vault'))
    cold.set(row.path, { bytes: Number(row.bytes), mtime: Number(row.mtime) });

  const going: SourceFile[]   = [];
  const held:  HeldPartition[] = [];

  for (const file of matched) {
    const was = cold.get(file.path);

    if (! was) { held.push({ path: file.path, reason: 'unpacked' }); continue; }

    // Size and mtime are the whole comparison. A rewrite that preserved both
    // would slip through, which is a far smaller risk than reading every byte
    // of the vault on every run.
    if (was.bytes !== file.bytes || was.mtime !== file.mtime) {
      held.push({ path: file.path, reason: 'changed' });

      continue;
    }

    going.push(file);
  }

  const groups = group(going);

  report(groups, held);

  if (going.length === 0) {
    spacer();
    info('Nothing matching is in Mega — nothing can be evicted');

    return;
  }

  spacer();

  const bytes = groups.reduce((total, entry) => total + entry.bytes, 0);

  if (! await confirm(
    `${purge ? 'Delete' : 'Trash'} ${going.length.toLocaleString()} partition`
    + `${going.length === 1 ? '' : 's'} from the vault · ${fmtBytes(bytes)}?`, false)) {
    info('Nothing deleted');

    return;
  }

  await reclaim(config.sourceRoot, groups, purge);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Whether one partition is in the selection.
 *
 * **An empty list matches everything**, which is what makes every part of the
 * filter optional without a wildcard to mistype — and what makes the four
 * dimensions compose as a conjunction rather than needing a rule each.
 *
 * A period token is compared as a prefix of the month, so `2017` and `201703`
 * are the same test rather than two. Nothing else is a prefix match: a symbol
 * filter that caught `BTCUSDT` from `BTC` would delete far more than was asked
 * for, and this is the command where that matters most.
 */
const matches = (file: SourceFile, filter: VaultFilter): boolean =>
  within(filter.venues,   file.venue)
  && within(filter.markets,  file.market)
  && within(filter.datasets, file.dataset)
  && within(filter.symbols,  file.symbol)
  && (filter.periods.length === 0
    || filter.periods.some(period => file.month.startsWith(period)));

/** Filter values arrive lowercased, so the attribute is lowered to meet them. */
const within = (wanted: string[], value: string | null): boolean =>
  wanted.length === 0 || (value !== null && wanted.includes(value.toLowerCase()));

/**
 * The selection in one line, so what is about to be deleted is stated in the
 * operator's own terms before it is stated in the tree's.
 *
 * A filter that reads back wrong is the cheapest mistake to catch here, and the
 * only place it can be caught is before the counts, which look plausible
 * whatever was asked for.
 */
const describe = (filter: VaultFilter): string => {
  const parts = [
    ['venue',   filter.venues],
    ['market',  filter.markets],
    ['dataset', filter.datasets],
    ['symbol',  filter.symbols],
    ['period',  filter.periods],
  ] as const;

  const named = parts
    .filter(([, values]) => values.length > 0)
    .map(([name, values]) => `${name}=${values.join(',')}`);

  return named.length > 0 ? named.join(' · ') : 'the whole vault';
};

/**
 * Everything going, by venue and dataset.
 *
 * That pair is the unit somebody asks to reclaim, so it is the unit the report
 * counts in and the unit a failed trash is reported against. The month is not:
 * the vault is judged a partition at a time, and a month grouping would suggest
 * a month-wide decision that is not being taken.
 */
const group = (files: SourceFile[]): EvictGroup[] => {
  const groups = new Map<string, SourceFile[]>();

  for (const file of files) {
    const label = `${file.venue}/${file.dataset ?? '—'}`;

    groups.set(label, [...groups.get(label) ?? [], file]);
  }

  return [...groups.entries()].sort().map(([label, members]) => ({
    label,
    files: members.map(file => file.path),
    bytes: members.reduce((total, file) => total + file.bytes, 0),
  }));
};

/**
 * What is going, and what was asked for and cannot.
 *
 * **The held-back list is the half worth reading**, which is why it is warned
 * rather than dimmed. Everything else in this family reports what cannot be done
 * quietly, because raw not being ready is the ordinary state of raw. Here it is
 * the opposite: the operator named these partitions, and is not getting them.
 *
 * Grouped by venue with a dataset line each, and every dataset carries its month
 * range — the two numbers and the span that say whether this is the selection
 * that was meant.
 */
const report = (groups: EvictGroup[], held: HeldPartition[]): void => {
  if (groups.length > 0) {
    const venues = new Map<string, EvictGroup[]>();

    for (const entry of groups) {
      const venue = entry.label.slice(0, entry.label.indexOf('/'));

      venues.set(venue, [...venues.get(venue) ?? [], entry]);
    }

    for (const [venue, entries] of [...venues].sort()) {
      const files = entries.reduce((total, entry) => total + entry.files.length, 0);
      const bytes = entries.reduce((total, entry) => total + entry.bytes, 0);

      spacer();
      info(`${venue} — ${entries.length} dataset${entries.length === 1 ? '' : 's'} · `
        + `${files.toLocaleString()} partitions · ${fmtBytes(bytes)}`);

      for (const entry of entries)
        info(`${C.dim}    ${entry.label.slice(venue.length + 1).padEnd(14)}`
          + `${span(entry.files).padEnd(20)}`
          + `${entry.files.length.toLocaleString().padStart(9)} partitions   `
          + `${fmtBytes(entry.bytes).padStart(10)}${C.reset}`);
    }

    const files = groups.reduce((total, entry) => total + entry.files.length, 0);
    const bytes = groups.reduce((total, entry) => total + entry.bytes, 0);

    spacer();
    info(`${files.toLocaleString()} partitions clear · ${fmtBytes(bytes)}`);
  }

  if (held.length === 0) return;

  const tally = new Map<HeldReason, HeldPartition[]>();

  for (const partition of held)
    tally.set(partition.reason, [...tally.get(partition.reason) ?? [], partition]);

  spacer();
  warn(`${held.length.toLocaleString()} matching partition${held.length === 1 ? '' : 's'} `
    + `${held.length === 1 ? 'is' : 'are'} not in Mega and will be kept`);

  for (const [reason, partitions] of [...tally].sort((a, b) => b[1].length - a[1].length)) {
    info(`    ${partitions.length.toLocaleString().padStart(7)}  ${HELD_REASONS[reason]}`);

    for (const partition of partitions.slice(0, 3))
      info(`${C.dim}             ${partition.path}${C.reset}`);

    if (partitions.length > 3)
      info(`${C.dim}             … and ${(partitions.length - 3).toLocaleString()} more${C.reset}`);
  }

  info(`${C.dim}    Run 'tools cold push vault' to back these up, then evict again.${C.reset}`);
};

/**
 * The months a set of partitions spans, read off their paths.
 *
 * The month is the last `=`-free component before the extension in stocker's
 * filenames, but rather than re-derive it the range is taken from the six digits
 * the filename ends with — enough to say which end of the archive this is, which
 * is all the range is for.
 */
const span = (paths: string[]): string => {
  const months = paths
    .map(file => /(\d{6})\.parquet$/.exec(file)?.[1])
    .filter((month): month is string => month !== undefined)
    .sort();

  if (months.length === 0) return '';

  const first = months[0]!;
  const last  = months[months.length - 1]!;

  return first === last ? first : `${first} → ${last}`;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_matches  = matches;
export const _test_describe = describe;
export const _test_group    = group;
export const _test_span     = span;
