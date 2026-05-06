import type { TableConfig } from '../types';

export type Row = Record<string, unknown>;

export interface FetchFilter {
  symbol?:    string;
  startTime?: string;
  endTime?:   string;
  count?:     number;
  reverse?:   boolean;
  filter?:    Record<string, unknown>;
}

export interface FetchService {
  oldest(table: TableConfig, filter?: FetchFilter): Promise<Row | null>;
  newest(table: TableConfig, filter?: FetchFilter): Promise<Row | null>;
  getRows(table: TableConfig, filter?: FetchFilter): AsyncIterable<Row>;
  getDay(table: TableConfig, date: string, filter?: FetchFilter): AsyncIterable<Row>;
}
