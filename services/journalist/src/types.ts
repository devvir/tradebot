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
 * A vault routing key: a real BitMEX table, or a pool pseudo-table such as
 * `orderBookL2.secondary`. The pool is encoded in the suffix; vault strips it
 * (`baseTable`) for header/cast lookup but stores the pseudo-table separately.
 */
export type VaultTable = BitmexTable | `${BitmexTable}.${string}`;

/**
 * The BitMEX WS client a table is fed by. The two clients run independently —
 * `platform` is steady while `realtime` can lag under backpressure — so day
 * closes are scoped per endpoint (see `closer.ts`).
 */
export type Endpoint = 'realtime' | 'platform';

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
