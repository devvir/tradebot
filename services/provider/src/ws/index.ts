import { tableKind, needsGrouping } from '../catalog';
import { messageItem } from './message';
import { wrapInsert, groupBySweep } from './wrap';
import { staticPartial, latestPartial } from './partial';
import { seekId } from './seek';
import type { BitmexTable } from '@tradebot/types';
import type { Librarian } from '../librarian';
import type { StreamResponse, PartialResponse } from '../types';

/**
 * The WS surface of the provider — turns stored docs into ordered wire messages.
 *
 *   partialBefore — the partial to apply on cold-activate (raw stored partial for
 *                   message tables, schema-only for flat/order-book), plus the
 *                   cursor to begin paging the forward stream.
 *   streamAfter   — the next page of wire messages after an opaque cursor.
 *
 * Cursors are `_id`-valued but opaque to callers; the provider owns the encoding.
 */

// ── Public API ────────────────────────────────────────────────────────────────

export const partialBefore = async (
  lib: Librarian, table: BitmexTable, beforeMs: number,
): Promise<PartialResponse> => {
  const kind = tableKind(table);

  if (kind === 'message') {
    const found = await latestPartial(lib, table, beforeMs);

    return found ? { partial: found.msg, cursor: found.id + 1 } : { partial: null, cursor: null };
  }

  if (kind === 'flat') {
    return { partial: staticPartial(table), cursor: await seekId(lib, table, beforeMs) };
  }

  /** order-book tables: empty schema partial, no stream. */
  if (kind === 'orderbook') {
    return { partial: staticPartial(table), cursor: null };
  }

  return { partial: null, cursor: null };
};

export const streamAfter = async (
  lib: Librarian, table: BitmexTable, after: number, limit: number,
): Promise<StreamResponse> => {
  const kind = tableKind(table);

  /** order-book tables carry no data yet (TODO: pending distiller); unknown → empty. */
  if (kind === 'orderbook' || kind === null) {
    return { messages: [], cursor: null, exhausted: true };
  }

  const docs = await lib.read(table, { from: after, order: 'asc', limit });
  const full = docs.length === limit;
  const last = docs[docs.length - 1];

  if (kind === 'message') {
    return { messages: docs.map(messageItem), cursor: last ? last._id + 1 : after, exhausted: ! full };
  }

  if (needsGrouping(table)) {
    const { items, consumedId } = groupBySweep(table, docs, full);

    return { messages: items, cursor: consumedId !== null ? consumedId + 1 : after, exhausted: ! full };
  }

  return { messages: docs.map(d => wrapInsert(table, d)), cursor: last ? last._id + 1 : after, exhausted: ! full };
};
