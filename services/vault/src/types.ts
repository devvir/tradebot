export type FileState   = 'open' | 'closed';
export type FileListing = Record<string, FileState>;
export type Row         = Record<string, unknown>;
export type DirEntry    = [dir: string, file: string];

/** A BitMEX WebSocket message as sent to vault by journalist. */
export interface WsMessage {
  action: string;
  date?:  string;
  data:   Row[];
}
