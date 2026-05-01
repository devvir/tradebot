export type TardyTable =
  | 'announcement'
  | 'chat'
  | 'connected'
  | 'instrument'
  | 'liquidation'
  | 'orderBookL2'
  | 'publicNotifications';

export type FileState = 'open' | 'closed';

export interface WsMessage {
  action: string;
  date:   string;
  data:   Record<string, unknown>[];
}

export interface Buf {
  rows: WsMessage[];
}

export interface Config {
  vaultUrl:  string;
  startDate: string;
  suffix:    string;
  [key: string]: unknown;
}
