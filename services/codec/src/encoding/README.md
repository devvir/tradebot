# `encoding/` — Public API

Handles encoding and decoding of Bitmex WebSocket messages for compressed archival.

## Functions

### `encode(strategy, rawMsg, jsonMsg) → EncodedMessage`

Top-level entry point. Builds a document ID, embeds it in the payload as `_id`, encodes the data payload (table-specific packing, Brotli compression), and returns payload ready for archival. Falls back to the raw payload on any encoding error.

### `encodePayload(data, table, action) → Record<string, unknown[]>`

Encodes the `data` array from a message by dispatching to the appropriate table encoder. Output is grouped by `symbol`, or keyed as `_` for tables without symbols. Used internally by `encode`.

### `decodeMessage(table, payload, idBuffer) → Partial<BitmexDataMessage>`

Decodes a stored document back to a `BitmexDataMessage`. `payload` may be a Brotli-compressed `Buffer` or a pre-parsed JSON object. `idBuffer` is the 8-byte MongoDB `_id`.

### `buildDocumentId(timestamp, action, apiVersion?, encoderVersion?) → bigint`

Packs message metadata into a 64-bit document `_id`. Encodes timestamp (42 bits), API version, encoder version, and action — making documents self-describing and time-sortable.

### `buildDocumentIdBuffer(...) → Buffer`

Same as `buildDocumentId` but returns the result as an 8-byte big-endian `Buffer`.

### `unpackDocumentId(idBuffer) → { action, encoderVersion, timestamp }`

Extracts action, encoder version, and ISO-8601 timestamp from an 8-byte `_id`.

---

For the full technical description of bit layouts and encoding strategies for each table, see [docs/services/ENCODING.md](../../../../docs/services/ENCODING.md).
