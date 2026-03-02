# `encoding/` — Codec Encoding & Decoding Engine

Encodes and decodes Bitmex WebSocket messages for compressed archival and retrieval.

## Directory Structure

```
encoding/
├── transform.ts       Entry point. Dispatches to strategies, manages _id
├── documentId.ts       Build / unpack / normalise 53-bit document _ids
├── encoders.ts         Encode dispatcher: routes data to table encoders
├── decoders.ts         Decode dispatcher: routes payload to table decoders
├── mappings.ts         Enum ↔ number lookup tables (action, side, tick, etc.)
├── utils.ts            Bit packing, timestamp/version codecs, price+size encoding
├── types.ts            Shared type definitions
├── strategies/
│   ├── encode.ts       Encode strategy: field-reduce + optional Brotli compress
│   └── decode.ts       Decode strategy: decompress + reverse-encode
└── tables/
    ├── trade.ts        Trade-specific encode/decode
    ├── quote.ts        Quote-specific encode/decode
    ├── orderBookL2.ts  OrderBookL2-specific encode/decode
    └── instrument.ts   Instrument-specific encode/decode
```

## How It Works

### Entry Point: `transform(rawMsg, jsonMsg) → Buffer`

Every message flowing through the codec enters via `transform()`. It:

1. Reads the strategy from the routing key (e.g. `encode.trade` → strategy `encode`, table `trade`)
2. Dispatches to the strategy handler (`encode` or `decode`) or leaves unchanged for `passthru`
3. Ensures a deterministic `_id` via `getIdempotentId()` (see _Document ID_ below)

**`transform` is the only place that manages `_id`.** Strategies return payloads without `_id`.

### Strategies

#### Encode (`strategies/encode.ts`)

Reduces message payload size:

1. Strips BitMEX envelope fields (`table`, `keys`, `types`, `filter`)
2. Dispatches `data[]` to the appropriate table encoder (via `encodePayload`)
3. Groups encoded items by symbol (or `_` for symbol-less tables)
4. Returns a flat `{ [symbol]: encodedItems[] }` object

#### Compress (`strategies/encode.ts`, compress branch)

Same as encode, but followed by Brotli compression:

1. Runs the encode pipeline above
2. Serialises the encoded payload to JSON
3. Brotli-compresses the JSON string
4. Returns `{ b: <Buffer> }` (a single binary field)

#### Decode (`strategies/decode.ts`)

Reverses any combination of encode + compress. Inspects the incoming document to detect the storage format:

- **`raw`** — document has a string `action` field → decode the encoded record
- **`compressed`** — document has a non-array `b` field → decompress with Brotli, then decode
- **`encoded`** — otherwise → return as-is (passthru data)

Decompressed payloads are routed through `decodeMessage()`, which unpacks the `_id` to recover `action` and `timestamp`, then dispatches to the appropriate table decoder.

### Table Encoders / Decoders (`tables/`)

Each table has a matched encode/decode pair. Encoding applies table-specific field reduction:

- **trade** — maps `side`, `tickDirection`, `trdType` to numeric IDs; packs `price+size` into a single number using `encodePriceAndSize()`
- **quote** — splits into bid/ask halves; packs each `price+size` pair
- **orderBookL2** — maps `side` to numeric; packs `price+size`; stores `id` directly
- **instrument** — stores selected numeric fields only (e.g. `impactBidPrice`, `markPrice`)

The `encodePriceAndSize()` utility (in `utils.ts`) packs a price and size into 1–2 numbers using a meta byte that encodes decimal count and byte widths. Falls back to raw values when the pair exceeds 53 bits.

### Document ID (`documentId.ts`)

Every document gets a deterministic 53-bit numeric `_id` that fits within `Number.MAX_SAFE_INTEGER`.

**Bit layout** (MSB → LSB):

```
timestamp(42) | apiVersion(9) | action(2)  =  53 bits
```

- **timestamp** — milliseconds since 2000-01-01 (covers up to ~2139)
- **apiVersion** — semver packed into 9 bits (2 major + 3 minor + 4 patch)
- **action** — `partial=0`, `insert=1`, `update=2`, `delete=3`

Key functions:

| Function | Description |
|----------|-------------|
| `buildDocumentId(ts, action, apiVersion?)` | Returns the packed `_id` as a plain `number` |
| `unpackDocumentId(id)` | Extracts `{ action, apiVersion, timestamp }` from a number |
| `getIdempotentId(incoming, result, rawMsg)` | Resolves the `_id`: preserves existing numeric `_id` or generates a new one |

### Bit Packing (`utils.ts`)

`pack(fields)` concatenates an array of `{ number, bits }` fields into a single `number`, MSB-first, using `acc * 2**bits + n` arithmetic (safe for all values ≤ 53 bits). This is how the document `_id`, the version fields, and the price+size encodings are all built.

## Public Exports (`index.ts`)

The barrel file exports strategies, document ID utilities, type definitions, and the encode/decode dispatchers. Internal helpers or table-specific functions are not exported.
