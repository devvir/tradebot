import type { WebSocket } from 'ws';

// ---- Types --------------------------------------------------------------

export type ClientState = 'idle' | 'awaitSnapshot' | 'streaming';

interface ClientRecord {
  state:         ClientState;
  subscriptions: Set<string>;
}

// ---- Registry -----------------------------------------------------------

/**
 * Tracks all connected WebSocket clients: what they're subscribed to and
 * their current lifecycle state.
 *
 * This is the reverse-lookup half of the subscription data model:
 *   client → keys
 *
 * The forward half (key → clients) lives in subscription.ts, used for
 * efficient broadcasting.
 */
export class ClientRegistry {
  private readonly _map = new Map<WebSocket, ClientRecord>();

  register(ws: WebSocket): void {
    this._map.set(ws, { state: 'idle', subscriptions: new Set() });
  }

  /**
   * Remove a client and return the set of keys it was subscribed to,
   * so callers can clean up the forward map.
   */
  deregister(ws: WebSocket): Set<string> {
    const record = this._map.get(ws);
    this._map.delete(ws);
    return record?.subscriptions ?? new Set();
  }

  has(ws: WebSocket): boolean {
    return this._map.has(ws);
  }

  // ---- State -------------------------------------------------------

  getState(ws: WebSocket): ClientState | undefined {
    return this._map.get(ws)?.state;
  }

  setState(ws: WebSocket, state: ClientState): void {
    const record = this._map.get(ws);
    if (record) record.state = state;
  }

  // ---- Subscriptions -----------------------------------------------

  hasSubscription(ws: WebSocket, key: string): boolean {
    return this._map.get(ws)?.subscriptions.has(key) ?? false;
  }

  addSubscription(ws: WebSocket, key: string): void {
    this._map.get(ws)?.subscriptions.add(key);
  }

  removeSubscription(ws: WebSocket, key: string): void {
    this._map.get(ws)?.subscriptions.delete(key);
  }

  getSubscriptions(ws: WebSocket): Set<string> {
    return this._map.get(ws)?.subscriptions ?? new Set();
  }
}
