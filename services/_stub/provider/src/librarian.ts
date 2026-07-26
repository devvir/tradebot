import type { FetchClientHandle } from '@devvir/service-kit';
import type { ReadOpts, StoredDoc } from './types';

/**
 * The librarian seam — the single place that knows the librarian HTTP shape.
 * Everything else in the provider asks for docs in terms of `_id` cursors,
 * order, and filters; swapping librarian for another source is a change here only.
 *
 * Reads return docs sorted by `_id` (ascending by default; `order: 'desc'` for
 * backward reads and single-doc cursor probes).
 */
export class Librarian {
  constructor(private readonly client: FetchClientHandle) {}

  async read(table: string, opts: ReadOpts = {}): Promise<StoredDoc[]> {
    const params = new URLSearchParams();

    if (opts.from   !== undefined) params.set('from',   String(opts.from));
    if (opts.before !== undefined) params.set('before', String(opts.before));
    if (opts.order)                params.set('order',  opts.order);
    if (opts.limit  !== undefined) params.set('limit',  String(opts.limit));
    if (opts.filter)               params.set('filter', JSON.stringify(opts.filter));

    const res = await this.client.get<{ docs: StoredDoc[] }>(`/${table}?${params.toString()}`);

    return res?.docs ?? [];
  }

  /** Convenience: the single doc at-or-before `beforeId` matching `filter`, or null. */
  async latestBefore(table: string, beforeId: number, filter?: Record<string, unknown>): Promise<StoredDoc | null> {
    const docs = await this.read(table, { before: beforeId, order: 'desc', limit: 1, filter });

    return docs[0] ?? null;
  }
}
