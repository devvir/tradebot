import { join } from 'node:path';
import { FactManager } from '@tradebot/pipeline';
import config from './config';
import { idOf } from './partition';
import { SERIES } from './schema/series';
import type { FactInput } from '@tradebot/pipeline';
import type { Built, PartitionKey } from './types';

/**
 * A durable record of every partition ever built, which **survives the
 * partition being deleted**.
 *
 * The steady state is that most of the vault lives in cold storage: a partition
 * is built, backed up, and evicted from local disk while its raw may still be
 * here. A record kept beside the data would go with it, leaving stocker unable
 * to tell "never built" from "built and evicted" — and it would rebuild the lot
 * on the next scan.
 *
 * **Two topics, because they are read at different rates.** `vault` is one fact
 * per partition and is what everything asks for; `vault:details` is one fact per
 * *input*, which is twenty times the volume and is wanted only by the one thing
 * that asks which raw file became which partition. Separate topics are separate
 * databases, so the common question never pays for the rare one's rows.
 *
 * It lives in the shared store rather than beside the vault for the same reason
 * it always did: reclaiming space is deleting `.parquet` files by any means,
 * including whole subtrees, and the record has to outlive that.
 */

/**
 * The store, opened once and kept.
 *
 * Stocker owns `vault` and everything below it, which is what lets it write —
 * the ownership check is made against this name, so a service cannot state
 * facts about a tree it does not fill.
 */
let store: FactManager | null = null;

const facts = (): FactManager =>
  (store ??= new FactManager({ owner: 'stocker', root: join(config.sharedDir, 'facts') }));

/**
 * Every partition ever built, by id.
 *
 * The members are read alongside, because `inputs` is what decides whether a
 * partition is stale and that decision is made for every partition on every
 * sweep.
 */
export const load = async (): Promise<Map<string, Built>> => {
  const byId  = new Map<string, Built>();
  const store = facts();

  for (const fact of store.find({ topic: 'vault', fact: 'built' }, { meta: true })) {
    const meta = (fact.meta ?? {}) as { key?: PartitionKey; rows?: number; closedAt?: string | null };

    // The key is carried whole rather than rebuilt from the columns: `market`
    // and `table` are unions, `interval`, `variant` and `kind` are optional and
    // only one of them is ever set, and reassembling that from a flattened
    // `subject` would be a second, guessing copy of `keyOf`.
    if (! meta.key) continue;

    const id = idOf(meta.key);

    byId.set(id, {
      id,
      key:      meta.key,
      inputs:   [],
      rows:     meta.rows ?? 0,
      builtAt:  fact.value,
      closedAt: meta.closedAt ?? null,
    });
  }

  // Streamed rather than fetched. There is one of these per partition *input*,
  // so the array `find` would build is millions of rows and over a gigabyte of
  // objects, to be folded straight into the map above and thrown away. Nothing
  // writes while this runs, which is what makes stepping the statement safe.
  for (const member of store.stream({ topic: 'vault:details' })) {
    const built = byId.get(idFor(member));

    // The path is the `fact` and the size is the `value`: the path is what makes
    // one member distinct from another, so it identifies the row rather than
    // annotating it.
    if (built) built.inputs.push({ path: member.fact, size: Number(member.value) });
  }

  return byId;
};

/**
 * Record a partition and everything it was built from, in one transaction.
 *
 * **The members are replaced, not added to.** A rebuild reads raw afresh, so the
 * inputs it records are the whole truth about that partition and the previous
 * set is not part of it. Accumulating instead would leave a raw file that a
 * rebuild dropped still vouching for a partition it no longer feeds — which is
 * not hypothetical: bitget's klines were rebuilt from one of two published
 * layouts at a time, and thirty-five months read as fully normalised and were
 * offered for eviction, taking the raw the repair needed with them.
 *
 * **The `built` fact is written last, and that is the commit.** The two topics
 * are two databases, so no transaction spans them and a crash can land between.
 * Ordering the members first means the worst case is members with no partition
 * claiming them, which reads as never built and is rebuilt — the safe direction.
 * The reverse would leave a partition claiming to be built from a set that is
 * not there.
 */
export const record = async (entry: Built): Promise<void> => {
  const store   = facts();
  const columns = columnsOf(entry.key);

  store.forgetAll({ topic: 'vault:details', ...columns });

  store.recordAll(entry.inputs.map((input): FactInput => ({
    topic: 'vault:details', ...columns, fact: input.path, value: String(input.size),
  })));

  store.record({
    topic: 'vault', ...columns, fact: 'built', value: entry.builtAt,
    meta: { key: entry.key, rows: entry.rows, inputs: entry.inputs.length, closedAt: entry.closedAt },
  });
};

/**
 * Venues whose newest closed month can never be built, stated once so that
 * nothing downstream has to know what a series is.
 *
 * A back-spilling series keeps a month's tail in the following month's first
 * bucket, so `requiredThrough` holds that month until the collector closes the
 * next one. Where **every** series of a venue spills that way — bitget, whose
 * buckets cut at 16:00 UTC — the venue's newest closed month yields no partition
 * at all, and the vault sits exactly one month behind the archives for as long
 * as that month is the tip.
 *
 * **That is complete, not missing**, and no consumer can tell the two apart by
 * counting. Only some series spilling is a different situation and deliberately
 * not stated: the month is still built, just from fewer series, so nothing
 * downstream sees a shortfall to explain.
 */
export const publishTraits = (): void => {
  const store  = facts();
  const venues = new Set(SERIES.map(series => series.venue));

  for (const venue of venues) {
    const all = SERIES.filter(series => series.venue === venue);

    if (! all.every(series => series.spill === 'back' || series.spill === 'both')) continue;

    // No period: this is a statement about the venue's shape rather than about
    // any one month, and the blank is what says so.
    store.record({ topic: 'vault', venue, period: '', fact: 'spills', value: 'back' });
  }
};

/** Close the store. The service holds it open for its lifetime otherwise. */
export const close = (): void => {
  store?.close();
  store = null;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Where a partition is filed.
 *
 * `venue`, `market`, `symbol` and `dataset` are the vocabulary the whole
 * pipeline shares and filters on. The extras — an interval, a variant, a kind,
 * and only ever one of them — go in `subject`, which is the column for what only
 * the owner knows the shape of.
 */
const columnsOf = (key: PartitionKey) => ({
  venue:   key.venue,
  period:  key.month.replace('-', ''),
  market:  key.market,
  symbol:  key.symbol,
  dataset: key.table,
  subject: key.interval ?? key.variant ?? key.kind ?? '',
});

/** The id of the partition a member belongs to, from the columns it shares. */
const idFor = (member: {
  venue: string; period: string; market: string; symbol: string;
  dataset: string; subject: string;
}): string =>
  [member.dataset, member.venue, member.market, member.symbol,
    ...(member.subject ? [member.subject] : []),
    `${member.period.slice(0, 4)}-${member.period.slice(4)}`].join('|');

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_columnsOf = columnsOf;
