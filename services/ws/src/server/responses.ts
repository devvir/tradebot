/**
 * BitMEX-compatible WebSocket response builders.
 *
 * All error responses follow the same envelope:
 *   { status: 400, error: "...", meta: {}, request: { ...original } }
 *
 * Behaviour confirmed against testnet.bitmex.com:
 *   - Invalid JSON             → unrecognizedRequest({})
 *   - Valid JSON, no op        → unrecognizedRequest(parsedObject)
 *   - Valid JSON, unknown op   → unrecognizedRequest({ ...parsed, op: 'UNKNOWN' })
 *   - subscribe, no/null/[] args → no response (silent)
 *   - subscribe, string args   → treated as single-item (BitMEX quirk, we replicate)
 *   - subscribe, unknown table → unknownTable(table, originalOp)
 *   - duplicate subscribe      → alreadySubscribed(topic, originalOp)
 *   - unsubscribe not subbed   → success (unsubscribeAck in protocol.ts)
 */

const DOCS = 'https://www.bitmex.com/app/wsAPI';

const UNRECOGNIZED =
  `Unrecognized request. See the docs or send 'help' for more details. Please see the documentation at ${DOCS}.`;

const error400 = (message: string, request: object): string =>
  JSON.stringify({ status: 400, error: message, meta: {}, request });

/**
 * Unrecognized or malformed request.
 *
 * Pass the parsed object as-is when there was no op (or invalid JSON, pass {}).
 * When there is an unknown op, pass { ...parsed, op: 'UNKNOWN' } — BitMEX
 * replaces the op value with the literal string "UNKNOWN" in the echoed request.
 */
export const unrecognizedRequest = (request: object): string =>
  error400(UNRECOGNIZED, request);

/** The client sent a subscribe op for a table that doesn't exist. */
export const unknownTable = (table: string, request: object): string =>
  error400(
    `Unknown table: ${table}. Please see the documentation at ${DOCS}.`,
    request,
  );

/** The client tried to subscribe to a topic they're already subscribed to. */
export const alreadySubscribed = (topic: string, request: object): string =>
  error400(
    `You are already subscribed to this topic:${topic}. Please see the documentation at ${DOCS}.`,
    request,
  );
