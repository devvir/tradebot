import type { FetchClientHandle } from '@devvir/service-kit';
import type { TableConfig } from '../types';

export type Row = Record<string, unknown>;

export interface Credential {
  apiKey:    string;
  apiSecret: string;
}

export interface Identity {
  name:       string;
  credential: Credential | null; // null = anonymous "guest" (per-IP bucket)
  limit:      number;            // bucket size / refill target (180 guest, 120 auth)
  remaining:  number;            // budget estimate — last reported by BitMEX, then decremented optimistically per dispatch
  updatedAt:  number;            // epoch ms of that report — anchors the refill estimate
  client:     FetchClientHandle; // SK fetch client carrying this identity's retries + signing
}

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
