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
