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

export type WsMessage = {
  action: BitmexAction;
  date:   string;
  data:   BitmexDataItem[];
};

export interface BufferedEntry {
  day: string;
  msg: WsMessage;
}

export interface TableBuffer {
  messages: BufferedEntry[];
  timer:    ReturnType<typeof setTimeout> | null;
}
