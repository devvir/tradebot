import type { WsMessage, StreamItem } from '../core/types';

/** `GET /ws/:table` response — a page of wire messages + the next cursor. */
export interface StreamPage {
  messages:  StreamItem[];
  cursor:    number | null;
  exhausted: boolean;
}

/** `GET /ws/:table/partial` response — the partial to apply + the start cursor. */
export interface PartialResult {
  partial: WsMessage | null;
  cursor:  number | null;
}
