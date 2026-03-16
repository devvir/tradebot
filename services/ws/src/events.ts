import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import type { BitmexWsMessage, SubscribeOp } from './types';

// ---- Event payload types ------------------------------------------------

export interface SubscriptionEvent {
  ws: WebSocket;
  op: SubscribeOp;
}

export interface DisconnectEvent {
  ws: WebSocket;
}

export interface DeltaChannelEvent {
  delta:   BitmexWsMessage;
  counter: number;
}

// ---- Event name constants -----------------------------------------------

/** Emitted by websocket.ts when a client sends a subscribe/unsubscribe op */
export const SUBSCRIPTION = 'subscription';

/** Emitted by websocket.ts when a client disconnects (close or error) */
export const DISCONNECT = 'disconnect';

/** Per-symbol delta channel: 'delta:orderBookL2:XBTUSD' */
export const deltaChannel = (table: string, symbol: string): string =>
  `delta:${table}:${symbol}`;

/** Per-table wildcard channel: 'delta:orderBookL2:*' — emitted on every delta for the table */
export const deltaWildcard = (table: string): string =>
  `delta:${table}:*`;

// ---- Bus ----------------------------------------------------------------

/**
 * Typed event bus shared across all modules.
 * Modules depend on this interface, not on each other directly.
 */
export class Bus extends EventEmitter {}

export const createBus = (): Bus => new Bus();
