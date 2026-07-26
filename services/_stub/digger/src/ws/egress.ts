import type { WsServerHandle, WsServerClient } from '@devvir/service-kit';
import type { WsMessage, StreamItem, DataItem } from '../core/types';

/**
 * Fan a merged message out to every subscribed client. A client subscribed to the
 * bare table gets the full frame (serialised once and shared); a symbol-scoped
 * client gets a frame filtered to its symbols. A bare-table subscription wins over
 * a scoped one.
 */

/** `ws` WebSocket.OPEN — inlined to avoid a runtime dependency on the `ws` package. */
const WS_OPEN = 1;

export const fanout = (server: WsServerHandle, item: StreamItem): void => {
  const { msg } = item;
  const table   = msg.table;

  /** Serialised lazily — only built if at least one full-table subscriber exists. */
  let fullJson: string | null = null;

  for (const client of server.clients()) {
    const subs = client.data.subs as Set<string> | undefined;

    if (! subs || subs.size === 0) continue;

    if (subs.has(table)) {
      if (fullJson === null) fullJson = JSON.stringify(msg);

      send(client, fullJson);

      continue;
    }

    const symbols = scopedSymbols(subs, table);

    if (symbols.size === 0) continue;

    const filtered = filterBySymbols(msg, symbols);

    if (filtered) send(client, JSON.stringify(filtered));
  }
};

// ── Internal ──────────────────────────────────────────────────────────────────

const send = (client: WsServerClient, data: string): void => {
  if (client.socket.readyState === WS_OPEN) client.socket.send(data);
};

/** The symbols a client subscribed to for `table` via `table:SYMBOL` channels. */
const scopedSymbols = (subs: Set<string>, table: string): Set<string> => {
  const out    = new Set<string>();
  const prefix = `${table}:`;

  for (const channel of subs) {
    if (channel.startsWith(prefix)) out.add(channel.slice(prefix.length));
  }

  return out;
};

const filterBySymbols = (msg: WsMessage, symbols: Set<string>): WsMessage | null => {
  const data = (msg.data as DataItem[]).filter(d => symbols.has(d.symbol as string));

  if (data.length === 0) return null;

  return { ...msg, data };
};
