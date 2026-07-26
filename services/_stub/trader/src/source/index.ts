/**
 * Source module barrel — inbound market data.
 *
 * Owns the WebSocket lifecycle and the in-memory cache that strategies read
 * each tick. Outbound REST lives in `rest/`, not here.
 */

export { Connection }                  from './ws';
export { DataCache }                   from './cache';
export { dispatch }                    from './dispatch';
export type { SourceConfig, SourceData, WsMessage } from './types';
