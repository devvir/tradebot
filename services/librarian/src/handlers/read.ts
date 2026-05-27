/**
 * `GET /:table` handler — batched read over the `_id` index. Pagination is the
 * caller's job: forward, pass `from = lastSeenId + 1`; backward (`order=desc`),
 * pass `before = firstSeenId - 1`. The optional `filter` JSON is spread verbatim
 * into the mongo query, so anything mongo's filter language supports is reachable.
 *
 * `from`/`before` bound the `_id` range (`$gte`/`$lte`); `order` flips the sort.
 * All optional and additive — a bare `GET /:table` is unchanged.
 */

import { logger } from '@devvir/service-kit';
import type { RequestHandler } from 'express';
import type { Db, Document, Filter } from 'mongodb';
import { parseLimit, parseFrom, parseBefore, parseOrder, parseFilter } from '../query';
import type { ReadCounter } from '../types';

export const makeReadHandler = (db: Db, counter: ReadCounter): RequestHandler => async (req, res) => {
  const table = String(req.params.table);

  const limit = parseLimit(req.query.limit);

  if (limit instanceof Error) {
    res.status(400).json({ error: limit.message });

    return;
  }

  const from = parseFrom(req.query.from);

  if (from instanceof Error) {
    res.status(400).json({ error: from.message });

    return;
  }

  const before = parseBefore(req.query.before);

  if (before instanceof Error) {
    res.status(400).json({ error: before.message });

    return;
  }

  const order = parseOrder(req.query.order);

  if (order instanceof Error) {
    res.status(400).json({ error: order.message });

    return;
  }

  const filter = parseFilter(req.query.filter);

  if (filter instanceof Error) {
    res.status(400).json({ error: filter.message });

    return;
  }

  const idBound: Record<string, number> = {};

  if (from   !== undefined) idBound.$gte = from;
  if (before !== undefined) idBound.$lte = before;

  /** Mongo's default `_id` type is ObjectId; our `_id`s are js-safe numbers,
   *  so cast through `unknown` to bypass the driver's narrow filter typing. */
  const query = { ...filter, ...(Object.keys(idBound).length > 0 ? { _id: idBound } : {}) } as unknown as Filter<Document>;

  try {
    const docs = await db.collection(table).find(query).sort({ _id: order }).limit(limit).toArray();

    counter(docs.length);
    res.json({ docs });
  } catch (err) {
    logger.error({ err }, 'Librarian read failed');
    res.status(500).json({ error: (err as Error).message ?? 'internal error' });
  }
};
