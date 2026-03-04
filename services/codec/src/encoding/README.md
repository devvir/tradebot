# Encoding

Brotli compression with optional table-specific field encoding. All messages are compressed; `orderBookL2`, `trade`, `quote`, and `instrument` also go through a field encoding step first. The public entry points are `encode` and `decode` in `strategies/`; everything in `tables/` and `utils.ts` is internal.

---

## Symbol Grouping

Before encoding, data items are grouped by symbol:

- Tables **with** symbol (trade, quote, orderBookL2, instrument): `{ XBTUSD: [...], ETHUSD: [...] }`
- Tables **without** symbol (announcement, chat, etc.): `{ _: [...] }`

The symbol is stripped from each item after grouping and restored by the decoder using the group key. On decode, items keyed `_` are skipped (no symbol to restore).

---

## Bit Packing (`utils.ts`)

### `pack(fields)`

Packs an array of `{ number, bits }` fields MSB-first into a single JS number (up to 53 bits total, limited by `Number.MAX_SAFE_INTEGER`). Plain numbers are auto-sized via `minBits`.

### `extract(value, offset, width)`

Extracts `width` bits starting at bit position `offset` (from LSB). Inverse of pack for individual fields.

### `minBits(n)` / `minBytes(n)`

Compute the minimum number of bits/bytes needed to represent `n`.

---

## Price + Size Encoding (`utils.ts`)

`encodePriceAndSize(price, size)` packs a price/size pair into 1-2 numbers:

**Packed form** (when total bits ≤ 53 and decimals ≤ 31):

```
meta byte: negativeSize(1) | negativePrice(1) | priceBytes(3) | decimals(5)
field1:    abs(size) packed with scaledPrice  (size bits + price bits)
```

`scaledPrice = round(abs(price) × 10^decimals)` — removes the decimal point entirely.

**Raw fallback** (when packing would overflow):

```
meta: 0  →  field1 = size, field2 = price (unchanged)
```

The `meta === 0` sentinel distinguishes packed from raw; callers must use `meta`, not a truthiness check on `field1` (size or price may legitimately be 0).

---

## Timestamp Encoding (`utils.ts`)

Timestamps are stored as milliseconds since 2000-01-01 (42 bits, covering up to ~2139). This trims ~7 bits vs Unix epoch and fits alongside other fields in a packed number.

```
encodeTimestamp(isoString) → { number: msSince2000, bits: 42 }
decodeTimestamp(encoded)   → ISO-8601 string
```

---

## Per-Table Encoding

### `trade`

Item layout: `[timestamp, packed_header, ...sizePrice, trdMatchID?, grossValue?, homeNotional?, foreignNotional?, pool?, trdType?]`

The `packed_header` encodes in 19 bits (LSB → MSB):
```
sizePriceMeta(10) | side(1) | tickDirection(2) | trdType(2) | trdMatchID_flag(1)
| grossValue_flag(1) | homeNotional_flag(1) | foreignNotional_flag(1) | pool_flag(1)
```

Optional fields are appended in the order their presence flags appear. `trdType` is stored as a 2-bit enum id for known values (`Regular`=0, `BlockTrade`=1); unknown types use id=2 and append the raw string.

### `quote`

Item layout: `[timestamp, ...quoteData]`

`quoteData` encodes up to two bid/ask pairs. Each packed value includes a witness bit (LSB) that identifies whether it is a bid (0) or ask (1), followed by 10 meta bits and then the packed price+size:

```
witness(1) | sizePriceMeta(10) | priceAndSize(remaining bits)
```

If both pairs fit: two packed values. If only one: one packed value (witness identifies which side). If packing overflows: raw fallback `[price, size, witness?]` or `[bidPrice, bidSize, askPrice, askSize]`.

### `orderBookL2`

Item layout:

- Delete (no size): `[id, timestamp]`
- With size: `[id, packed(ts+meta+side), field1, field2?, pool?]`

The second element packs timestamp (42 bits), sizePriceMeta (10 bits), and side (1 bit) into a single number. `priceBytes === 0` in meta signals the raw fallback (field1=size, field2=price).

### `instrument`

Instrument messages carry many optional fields. Rather than a fixed array, each item is encoded as:

```
[timestamp, fieldCodes, ...values]
```

`fieldCodes` is a string of single-character codes (from `INSTRUMENT_FIELD` mapping) listing which fields are present, in order. Values follow in the same order. Timestamps and timespans are encoded as ms-since-2000; enums are encoded as numeric ids; booleans as 0/1. Fields not in the mapping are stored as-is.

---

## Brotli Compression

After per-table encoding, the entire grouped payload (a `Record<string, unknown[]>`) is JSON-serialised and Brotli-compressed into a `Buffer`, stored as `b` on the message. Quality is configurable via `CODEC_BROTLI_QUALITY` (default: 1 — fast).

On decode, `b` arrives as a base64 string (AMQP serialisation), is reconstructed into a Buffer, Brotli-decompressed, JSON-parsed, then passed to the appropriate table decoder.
