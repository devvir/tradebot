import type { EncodedField, EncodedPriceAndSize } from './types';

/** Start of encoded timestamp range (2000-01-01 00:00:00.000Z) */
const EPOCH_2000_MS = 946_684_800_000;

// ── Bit helpers ────────────────────────────────────────────────────────────────

/** Minimum bits required to hold `n`. */
export const minBits = (n: number) => n ? (Math.floor(Math.log2(n)) + 1) : 1;

/** Minimum bytes required to hold `n`. */
export const minBytes = (n: number) => Math.ceil(minBits(n) / 8);

/** Extract `width` bits starting at bit position `offset` (from LSB). Handles values up to 53 bits. */
export const extract = (value: number, offset: number, width: number): number =>
  Math.floor(value / 2 ** offset) % (2 ** width);

// ── Packing ────────────────────────────────────────────────────────────────────

/**
 * Pack multiple encoded fields into a single number (MSB-first).
 * Accepts { number, bits } objects or plain numbers (auto-sized).
 * All values must fit within 53 bits total (Number.MAX_SAFE_INTEGER).
 */
export const pack = (fields: (EncodedField | number)[]): number =>
  fields
    .map(f => (typeof f === 'object') ? f : { number: f, bits: minBits(f) })
    .reduce((acc, { number, bits }) => acc * (2 ** bits) + number, 0);

// ── Semver (9 bits: 2 major + 3 minor + 4 patch) ──────────────────────────────

export const encodeVersion = (version: string): EncodedField => {
  const [major, minor, patch] = version.split('.').map(Number);
  const encoded = ((major & 0b11) << 7) | ((minor & 0b111) << 4) | (patch & 0b1111);
  return { number: encoded, bits: 9 };
};

export const decodeVersion = (encoded: number): string => {
  const major = extract(encoded, 7, 2);
  const minor = extract(encoded, 4, 3);
  const patch = extract(encoded, 0, 4);
  return `${major}.${minor}.${patch}`;
};

// ── Timestamp (42 bits: ms since Jan 1, 2000 — covers up to ~2139) ────────────

// BitMEX uses this date as a sentinel for instruments that are planned but not yet launched.
const FAR_FUTURE_ISO = '2200-02-01T00:00:00.000Z';

export const encodeTimestamp = (isoString: string): EncodedField => {
  if (isoString === FAR_FUTURE_ISO) return { number: 0, bits: 42 };

  const offset = new Date(isoString).getTime() - EPOCH_2000_MS;

  if (offset < 0 || offset > 0x3ffffffffff) {
    throw new Error(`Timestamp ${isoString} out of valid range (2000-2100)`);
  }

  return { number: offset, bits: 42 };
};

export const decodeTimestamp = (encoded: number): string => {
  return (encoded === 0)
    ? FAR_FUTURE_ISO /** Sentinel value BitMEX uses for planned instruments */
    : new Date(Number(encoded) + EPOCH_2000_MS).toISOString();
};

// ── Price + Size encoding/decoding ─────────────────────────────────────────────

/**
 * Pack price and size into 1-2 numbers.
 *
 * Meta byte layout: priceBytes(3) | decimals(5)
 * - If packable: { meta, field1: packed(size, scaledPrice) }
 * - If not:      { meta: 0, field1: size, field2: price }
 */
export const encodePriceAndSize = (price: number, size: number): EncodedPriceAndSize => {
  const priceStr = price.toString().replace('-', '');
  const dotIdx = priceStr.indexOf('.');
  const decimals = dotIdx >= 0 ? priceStr.length - dotIdx - 1 : 0;
  const scaledPrice = Math.round(Math.abs(price) * 10 ** decimals);

  const sizeBits = minBits(Math.abs(size));
  const priceBytes = minBytes(Math.abs(scaledPrice));
  const priceBits = priceBytes * 8;

  if (decimals > 31 || sizeBits + priceBits > 53) {
    return { bits: 0, meta: 0, field1: size, field2: price };
  }

  return {
    bits: priceBits + sizeBits,
    meta: Number(pack([
      { number: size < 0 ? 1 : 0, bits: 1 },    // Negative size flag
      { number: price < 0 ? 1 : 0, bits: 1 },   // Negative price flag (unlikely but for completeness)
      { number: priceBytes, bits: 3 },
      { number: decimals, bits: 5 },
    ])),
    field1: Number(pack([
      { number: Math.abs(size), bits: sizeBits },
      { number: scaledPrice, bits: priceBits },
    ])),
  };
};

/**
 * Recover price and size from a packed field1 + meta byte.
 * Inverse of encodePriceAndSize for the packed case.
 *
 * Meta layout (LSB → MSB): decimals(5) | priceBytes(3) | negativePrice(1) | negativeSize(1)
 */
export const decodePriceAndSize = (field1: number, meta: number) => {
  const decimals = meta & 0x1f;
  const priceBits = ((meta >> 5) & 0x7) * 8;
  const negativePrice = (meta >> 8) & 0x1;
  const negativeSize = (meta >> 9) & 0x1;
  const priceScale = 2 ** priceBits;

  return {
    price: (field1 % priceScale) / 10 ** decimals * (negativePrice ? -1 : 1),
    size: Math.floor(field1 / priceScale) * (negativeSize ? -1 : 1),
  };
};

