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

export interface Config {
  vaultUrl:  string;
  startDate: string;
  [key: string]: unknown;
}
