import path from 'node:path';
import { FactManager } from '@tradebot/pipeline';
import type { ColdConfig, PartitionKey } from './types';

/**
 * Stocker's record of what it built, as cold storage reads it.
 *
 * **The one thing cold storage cannot answer for itself.** It knows which files
 * it packed and which raw they came from; it does not know what stocker *set
 * out* to build, because that is a record of what stocker did rather than of
 * what was backed up. Two commands need it and need different readings of it,
 * so the reading lives here rather than twice:
 *
 * - `cold evict archives` asks which partitions a raw file fed, to know whether
 *   deleting that raw would strand something unmodelled.
 * - `cold push vault` asks which partitions a month should contain, to know
 *   whether packing it now would record a fragment as a finished month.
 *
 * It is the same kind of dependency `cold push archives` already has on the
 * collector's published tips — a documented output, not a reach into internals.
 *
 * **Asked of the facts, not of stocker's files.** Both questions used to be
 * answered by parsing `@meta/built/*.jsonl`, and both are now queries against
 * the `vault` topic. The shapes returned are unchanged, so the commands that
 * consume them did not have to move with the store.
 *
 * Read as whatever the caller is, since reads are unowned: a consumer needs no
 * permission to find out where a producer has got to.
 */

/**
 * A handle on what the services have said, for the length of one command.
 *
 * `tooling` owns no topic and needs to own none — every question cold storage
 * asks is a read, and reads are unowned by design. The caller closes it.
 */
export const openFacts = (config: ColdConfig): FactManager =>
  new FactManager({ owner: 'tooling', root: path.join(config.sharedRoot, 'facts') });

/** `klines|bitget|spot|BTCUSDT|1m|2020-08` — stocker's id for one partition. */
export const idOf = (key: PartitionKey): string => {
  const extras = key.variant
    ? key.variant.split('/').map(level => level.slice(level.indexOf('=') + 1))
    : [];

  return [key.dataset, key.venue, key.market, key.symbol, ...extras,
    `${key.month.slice(0, 4)}-${key.month.slice(4)}`].filter(Boolean).join('|');
};

/**
 * Which partitions each raw file of a venue fed.
 *
 * Ledger paths are relative to the venue root and cold's are venue-prefixed, so
 * the venue — which the fact is filed under — is put back on.
 *
 * **The member list lives in `vault:details`, apart from the partitions
 * themselves.** It is the bulk of what stocker records and nothing that asks
 * "what has been built" wants to carry it, so it is its own topic and therefore
 * its own database, out of the way of every other question.
 *
 * A partition rebuilt from more raw than before keeps both sets here, where the
 * flat file kept only the newest. They are the same answer: a rebuild reads raw
 * and nothing else, and raw is evicted a whole month at a time, so the files in
 * hand are always a superset of the ones the last build recorded and an input
 * set can only grow.
 */
export const inputsByRaw = (
  facts: FactManager,
  venue: string,
): Map<string, string[]> => {
  const found = new Map<string, string[]>();

  for (const member of facts.find({ topic: 'vault:details', venue })) {
    // The path is the `fact` — it is what makes one member distinct from
    // another, so it is what identifies the row rather than what annotates it.
    const key = `${venue}/${member.fact}`;
    const ids = found.get(key) ?? [];
    const id  = partitionId(member);

    if (! ids.includes(id)) ids.push(id);

    found.set(key, ids);
  }

  return found;
};

/**
 * Which partitions a venue's months should contain, keyed `YYYYMM`.
 *
 * Duplicate ids collapse into the set on their own, which is the right reading:
 * a partition stocker has rebuilt is still one partition the month should hold.
 */
export const idsByMonth = (
  facts: FactManager,
  venue: string,
): Map<string, Set<string>> => {
  const found = new Map<string, Set<string>>();

  for (const built of facts.find({ topic: 'vault', venue, fact: 'built' })) {
    const ids = found.get(built.period) ?? new Set<string>();

    ids.add(partitionId(built));
    found.set(built.period, ids);
  }

  return found;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Stocker's id, rebuilt from the columns a fact is filed under.
 *
 * A fact says `period` where a partition id says `month`, and `subject` holds
 * the extra levels bare — `1m` rather than `interval=1m`. [`idOf`](#idOf) reads
 * both the same way, since it takes whatever follows an absent `=`.
 */
const partitionId = (fact: {
  venue: string; period: string; market: string; symbol: string;
  dataset: string; subject: string;
}): string =>
  idOf({ ...fact, month: fact.period, variant: fact.subject });
