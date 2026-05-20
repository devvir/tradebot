export type Row = Record<string, unknown>;

export interface WsMessage {
  action: string;
  date?:  string;
  data:   Row[];
}

export interface Buffer {
  readonly table:    string;
  readonly filename: string;

  push(line: string): void;
  pushMany(lines: string[]): void;

  count():       number;
  lastFlushed(): number;

  /** Returns all buffered lines and clears the buffer. Updates lastFlushed. */
  flush(): string[];
}

export interface FlushResult {
  table:    string;
  filename: string;
  lines:    string[];
}

export interface VaultParser {
  /**
   * Streams a closed file's records — `string[]` in column order, the header
   * row first — skipping the first `skip` messages.
   */
  read(filename: string, skip?: number): AsyncGenerator<string[]>;
}
