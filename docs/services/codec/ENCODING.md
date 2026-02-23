# Encoding System — Technical Reference

The codec service encodes Bitmex WebSocket messages into compact binary/numeric representations for compressed archival. All source lives under `services/codec/src/encoding/`.

---

## Table of Contents

1. [Overview](#overview)
2. [Core Primitives (`utils.ts`)](#core-primitives)
3. [Document ID (`document-id.ts`)](#document-id)
4. [Table Encoders / Decoders](#table-encoders--decoders)
   - [orderBookL2](#orderbookl2)
   - [trade](#trade)
   - [quote](#quote)
   - [instrument](#instrument)
5. [Mappings (`mappings.ts`)](#mappings)
6. [Entry Points](#entry-points)

---

## Overview

The encoding pipeline takes a `BitmexDataMessage` and produces an `EncodedMessage` ready for archival in MongoDB. The inverse pipeline takes a stored document and reproduces the original message.

```
WebSocket message
       │
       ▼
   encode()           ← transform.ts — builds headers, calls encodePayload, brotli-compresses
       │
       ├── buildDocumentId()    → 8-byte MongoDB _id
       └── encodePayload()      → table-specific packed arrays
              │
              ├── encodeOrderBookL2()
              ├── encodeTrade()
              ├── encodeQuote()
              └── encodeInstrument()

Stored document
       │
       ▼
   decodeMessage()    ← decoders.ts — decompresses, routes to table decoder
       │
       ├── unpackDocumentId()   ← document-id.ts
       └── decodeOrderBookL2() / decodeTrade() / decodeQuote() / decodeInstrument()
```

The fundamental encoding primitives are in `utils.ts`. Each table encoder uses those primitives independently.

---

## Core Primitives

**File:** `services/codec/src/encoding/utils.ts`

### Constants

| Name | Value | Meaning |
|---|---|---|
| `EPOCH_2000` | `946684800000` | Unix ms for 2000-01-01T00:00:00Z — the timestamp baseline |
| `MAX_SAFE_INT` | `0x1fffffffffffff` | 2^53 − 1, the largest integer representable exactly as a `number` |

### Bit Helpers

```ts
minBits(n: number): number
```
Returns the minimum number of bits required to represent the non-negative integer `n`.
Formula: `n ? floor(log2(n)) + 1 : 1`. Only valid for `n ≥ 0`.

```ts
minBytes(n: number): number
```
Returns `ceil(minBits(n) / 8)`.

```ts
extract(value: number, offset: number, width: number): number
```
Extracts `width` bits from a `number` starting at bit `offset` (counted from LSB).
Uses unsigned right-shift (`>>>`): safe for values up to 32 bits.

```ts
extractBig(value: bigint, offset: number, width: number): number
```
Same semantics as `extract` but operates on a `bigint`. Returns a `number`.

### Packing

```ts
pack(fields: (EncodedField | number)[]): bigint
```

MSB-first BigInt packer. Each field contributes `bits` bits. The first element occupies
the most significant position; the last occupies the least significant.

```ts
// Example: pack 3 → 2-bit, 7 → 3-bit, 1 → 1-bit
pack([{ number: 3, bits: 2 }, { number: 7, bits: 3 }, { number: 1, bits: 1 }])
// = 0b11_111_1 = 0x3f
```

Plain `number` elements are auto-sized via `minBits`.

```ts
bigIntToBuffer(value: bigint): Buffer
```
Serialises a BigInt as an 8-byte big-endian `Buffer`.

### Version Encoding (9 bits)

```ts
encodeVersion(version: string): EncodedField<number>   // '2.0.0' → { number, bits: 9 }
decodeVersion(encoded: number): string                  // inverse
```

Semver packed as `major(2) | minor(3) | patch(4)` (MSB-first). Supports up to `3.7.15`.

### Timestamp Encoding (42 bits)

```ts
encodeTimestamp(isoString: string): EncodedField<number>
decodeTimestamp(encoded: number | bigint): string
```

Stores milliseconds elapsed since `EPOCH_2000`. 42 bits covers the range 2000–2139.
Throws if the timestamp is outside this range.

### Price + Size Encoding (10-bit meta)

This is the most important primitive — used by orderBookL2, trade, and quote.

```ts
encodePriceAndSize(price: number, size: number): EncodedPriceAndSize
```

Attempts to pack price and size into a single JavaScript number. Returns:

| Field | Packed path | Raw fallback path |
|---|---|---|
| `meta` | 10-bit metadata word (see below) | `0` |
| `field1` | `pack([abs(size), scaledPrice])` | `size` |
| `field2` | `undefined` | `price` |
| `bits` | total bit width of `field1` | `0` |

**Meta layout (10 bits, LSB → MSB):**

```
bit 9   negativeSize   (1)  — size < 0
bit 8   negativePrice  (1)  — price < 0
bits 7–5 priceBytes    (3)  — number of bytes used for scaled price (1–7)
bits 4–0 decimals      (5)  — number of decimal places in price (0–31)
```

**Packed path** is taken when:
- `decimals ≤ 31`, AND
- `sizeBits + priceBits ≤ 53` (fits in a safe JS integer)

**Raw fallback** is taken when either condition fails. `meta === 0` signals the raw path.
On the raw path `priceBytes` is 0, which is used as the sentinel by decoders.

```ts
decodePriceAndSize(field1: number, meta: number): { price: number; size: number }
```

Inverse of the packed path:

```ts
decimals      = meta & 0x1f
priceBits     = ((meta >> 5) & 0x7) * 8
negativePrice = (meta >> 8) & 0x1
negativeSize  = (meta >> 9) & 0x1

price = (field1 & ((1 << priceBits) - 1)) / 10^decimals * (negativePrice ? -1 : 1)
size  = (field1 >> priceBits)             * (negativeSize  ? -1 : 1)
```

---

## Document ID

**File:** `services/codec/src/encoding/document-id.ts`

Every archived document's MongoDB `_id` is an 8-byte BigInt that encodes the message timestamp, API version, encoder version, and action — so documents are self-describing and sortable.

### Bit layout (64 bits, MSB → LSB)

```
bits 63–62  unused         (2)
bits 61–20  timestamp      (42)  — ms since EPOCH_2000
bits 19–11  apiVersion     (9)   — semver
bits 10–2   encoderVersion (9)   — semver
bits 1–0    action         (2)   — partial/insert/update/delete
```

### Functions

```ts
buildDocumentId(
  timestamp: string,
  action: BitmexAction,
  apiVersion?: string,      // default '2.0.0'
  encoderVersion?: string,  // default '1.0.0'
): bigint
```

```ts
buildDocumentIdBuffer(...same args...): Buffer
```
Convenience wrapper — encodes and serialises to 8-byte big-endian Buffer.

```ts
unpackDocumentId(idBuffer: Buffer | ArrayBuffer): {
  action: BitmexAction;
  encoderVersion: string;
  timestamp: string;         // ISO-8601
}
```

---

## Table Encoders / Decoders

### orderBookL2

**File:** `services/codec/src/encoding/orderBookL2.ts`

#### Strategy

Order book rows are differentiated by action:

- **`delete`**: only `id` and `transactTime` are needed — no price/size.
- **all others**: price, size, side, and timestamp are all present.

Optional `pool` string is appended when present.

#### Encoded array layout

**Delete action:** `[id, ts]`

| Index | Value | Notes |
|---|---|---|
| 0 | `id` | raw number |
| 1 | `ts` | ms offset from EPOCH_2000 |

**Insert / update / partial:** `[id, encodedTsSideMeta, field1, (field2?), (pool?)]`

| Index | Value | Notes |
|---|---|---|
| 0 | `id` | raw number |
| 1 | `encodedTsSideMeta` | packed number (see below) |
| 2 | `field1` | packed(size, scaledPrice) or `size` |
| 3 | `field2` or `pool` | `price` on raw path; `pool` on packed path |
| 4 | `pool` | only if both raw path and pool present |

**`encodedTsSideMeta` layout (single JS number, bits LSB → MSB):**

```
bit 0        side      (1)  — Buy=0, Sell=1
bits 10–1    meta      (10) — encodePriceAndSize meta
bits 52–11   ts        (42) — timestamp offset
```

#### Decoder extraction

```ts
const sideId = encoded & 0x1;
const meta   = (encoded >> 1) & 0x3ff;
const ts     = encoded >> 11;
```

`meta === 0` (i.e. `priceBytes === 0`) → raw path: `size = field1`, `price = item[3]`.

---

### trade

**File:** `services/codec/src/encoding/trade.ts`

#### Strategy

Symbol and timestamp are stripped — symbol is the grouping key, timestamp comes from the document `_id`. All optional fields (`trdMatchID`, `grossValue`, `homeNotional`, `foreignNotional`, `pool`) are represented by presence flags in the header, then appended in order.

#### Encoded array layout

`[packed, field1, (field2?), (trdMatchID?), (grossValue?), (homeNotional?), (foreignNotional?), (pool?), (trdType string?)]`

**`packed` header layout (20 bits, LSB → MSB):**

```
bit 0         pool flag             (1)
bit 1         foreignNotional flag  (1)
bit 2         homeNotional flag     (1)
bit 3         grossValue flag       (1)
bit 4         trdMatchID flag       (1)
bits 6–5      trdType id            (2)  — Regular=0, Referential=1, unknown=2
bits 8–7      tickDirection id      (2)  — MinusTick=0, ZeroMinusTick=1, ZeroPlusTick=2, PlusTick=3
bit 9         side id               (1)  — Buy=0, Sell=1
bits 19–10    sizePriceMeta         (10) — encodePriceAndSize meta
```

**Body elements (in order after `packed`):**

1. `field1` — always present (packed size+price, or just size on raw path)
2. `field2` — only on raw path (`price`)
3. `trdMatchID` — only if flag is set (string)
4. `grossValue` — only if flag is set (number)
5. `homeNotional` — only if flag is set (number)
6. `foreignNotional` — only if flag is set (number)
7. `pool` — only if flag is set (string)
8. `trdType` raw string — only if `trdTypeId === 2` (unknown type)

**trdType encoding:** known values are mapped to their numeric id (Regular=0, Referential=1). If the value is not in `TRD_TYPE`, id=2 is used and the original string is appended at the end.

**Zero-value handling:** The encoder uses `meta !== 0` (not `Boolean(field1)`) to distinguish packed vs raw, because size or price can legitimately be `0`.

---

### quote

**File:** `services/codec/src/encoding/quote.ts`

#### Strategy

Quote rows can have a bid pair, an ask pair, or both. Each price+size pair is encoded independently and the two values are differentiated by a 1-bit witness (LSB of the packed number: `0 = bid`, `1 = ask`). Symbol and timestamp are stripped.

`MAX_PACKABLE = 2^42 − 1` — the maximum value of the `priceAndSize` portion, leaving 11 bits for meta(10) + witness(1).

#### Encoded array layout — 4 cases

**Case 1 — 1 element, packed:** one pair (bid or ask)

```
[packedValue]
```

`packed layout (LSB → MSB): witness(1) | meta(10) | priceAndSize(remaining)`

The witness bit identifies which pair: `packed & 1 === 0` → bid, `=== 1` → ask.

**Case 2 — 2 elements, packed:** both pairs packed

```
[packedBid, packedAsk]
```

Each element has witness of 0 or 1 respectively.

**Case 3 — 3 elements, raw fallback:** one pair exceeded `MAX_PACKABLE` or meta=0

```
[price, size, witness]
```

`witness = 0` → bid pair, `witness = 1` → ask pair.

**Case 4 — 4 elements, raw fallback:** both pairs, at least one exceeded limit

```
[bidPrice, bidSize, askPrice, askSize]
```

#### Decoder

The decoder switches on array length to select the appropriate case. For packed values, `unpackQuoteValue` extracts:

```ts
const meta         = extractBig(BigInt(packed), 1, 10);
const priceAndSize = Number(BigInt(packed) >> 11n);
const { price, size } = decodePriceAndSize(priceAndSize, meta);
```

---

### instrument

**File:** `services/codec/src/encoding/instrument.ts`

#### Strategy

Instrument updates are very sparse — typically 10 of 97 possible fields are present per message. The encoder builds a compact key string (1–2 character codes per field) and appends values in order.

#### Encoded array layout

```
[keysString, value0, value1, ...]
```

- `keysString`: concatenated field codes from `INSTRUMENT_FIELD` (e.g. `"R1S1_"`)
  - 2-character codes for most fields
  - `"_"` for `symbol`
- Values are stored in the same order as the keys appear in the string.

> **Note:** Booleans, enums, and timestamps are not yet encoded compactly — values are stored raw. This is annotated TODO in the source.

---

## Mappings

**File:** `services/codec/src/encoding/mappings.ts`

All numeric lookup tables used by encoders and decoders. Reverse mappings are derived with `reverseMapping()`.

| Export | Type | Values |
|---|---|---|
| `ACTION_ID` | `partial=0, insert=1, update=2, delete=3` | used in document _id |
| `SIDE_ID` / `SIDE_ID_REVERSE` | `Buy=0, Sell=1` | orderBookL2, trade |
| `TICK_DIRECTION` / `TICK_DIRECTION_REVERSE` | `MinusTick=0, ZeroMinusTick=1, ZeroPlusTick=2, PlusTick=3` | trade |
| `TRD_TYPE` / `TRD_TYPE_REVERSE` | `Regular=0, Referential=1` | trade |
| `INSTRUMENT_FIELD` / `INSTRUMENT_KEY_REVERSE` | per-field 1–2 char codes | instrument |

---

## Entry Points

### `encodePayload` (`encoders.ts`)

```ts
encodePayload(
  data: BitmexDataItem[],
  table: string,
  action: BitmexAction,
): Record<string, unknown[]>
```

Dispatches to the correct table encoder. Output is grouped by `symbol` (or keyed as `_` for tables without a symbol field).

### `decodeMessage` (`decoders.ts`)

```ts
decodeMessage(
  table: BitmexTable,
  payload: Buffer | Record<string, unknown[]>,
  idBuffer: Buffer | ArrayBuffer,
): Partial<BitmexDataMessage>
```

Accepts a Brotli-compressed `Buffer` or pre-parsed JSON object. Extracts action, version, and timestamp from the `_id`, then delegates to the appropriate table decoder. Throws on unsupported encoder versions.

### `encode` (`transform.ts`)

```ts
encode(rawMsg: RawMessage, jsonMsg: BitmexDataMessage): EncodedMessage
```

Top-level pipeline entry. Builds headers, optionally encodes and Brotli-compresses the payload (controlled by `codecStrategy`), and gracefully falls back to raw payload on error.
