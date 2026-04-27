export type Row = Record<string, unknown>;

export interface WsMessage {
  action: string;
  date?:  string;
  data:   Row[];
}

export interface Buffer {
  readonly table: string;
  readonly date:  string;

  push(line: string): void;
  pushMany(lines: string[]): void;

  count():       number;
  lastFlushed(): number;

  /** Returns all buffered lines and clears the buffer. Updates lastFlushed. */
  flush(): string[];
}

export interface FlushResult {
  table: string;
  date:  string;
  lines: string[];
}
