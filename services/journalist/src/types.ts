import type { BitmexAction, BitmexDataItem, BitmexTable, BitmexPartial, BitmexDataMessage } from '@tradebot/types';
import { isBitmexDataMessage } from '@tradebot/types';

export {
  type BitmexAction,
  type BitmexDataItem,
  type BitmexTable,
  type BitmexPartial,
  type BitmexDataMessage,
  isBitmexDataMessage,
};

export interface Config {
  rabbitmqUrl:   string;
  vaultUrl:      string;
  vaultSuffix:   string;
  [key: string]: unknown;
}

/**
 * The BitMEX WS client a table is fed by. The two clients run independently —
 * `platform` is steady while `realtime` can lag under backpressure — so day
 * closes are scoped per endpoint (see `closer.ts`).
 */
export type Endpoint = 'realtime' | 'platform';

/**
 * A message's data routed to one vault table. Most messages yield a single group
 * (their own table); a `trade` message splits into `trade` (real prints) and the
 * derived `tick` table (referential index prints). `table` is a plain string
 * because `tick` is not a BitMEX channel — it's a vault table name.
 */
export interface RouteGroup {
  table: string;
  data:  BitmexDataItem[];
}

export type WsMessage = {
  action: BitmexAction;
  date:   string;
  data:   BitmexDataItem[];
};

/**
 * Outcome of a single vault write attempt.
 *   - `ok`          — rows accepted.
 *   - `closed`      — the target bucket is sealed/closing (HTTP 409); rows must
 *                     be diverted to the `.tail` safety-valve file.
 *   - `unavailable` — vault is down/throttled/unhealthy; retry after back-off.
 */
export type WriteResult = 'ok' | 'closed' | 'unavailable';

export interface BufferedEntry {
  day: string;
  msg: WsMessage;
}

export interface TableBuffer {
  messages: BufferedEntry[];
  timer:    ReturnType<typeof setTimeout> | null;
}
