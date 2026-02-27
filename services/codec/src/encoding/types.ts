import { InstrumentData } from ".";

/**
 * Encoded value with bit width specification (how much space to take).
 */
export interface EncodedField<T extends number | bigint = number> {
  number: T;
  bits: number;
}

export type UnknownMessage = Record<string, unknown>;

/**
 * Structured format for encoded messages ready for publishing.
 */
export interface EncodedMessage {
  headers: Record<string, unknown>;
  payload: Buffer | Record<string, unknown[]>;
}

/**
 * Structured format for decoded messages ready for publishing.
 */
export interface DecodedMessage {
  headers: Record<string, unknown>;
  payload: Record<string, unknown>; // Partial<BitmexDataMessage> but also compatible with JSON serialization
}

/**
 * Unified output from any codec transformation (passthru, encode, or decode).
 */
export interface TransformResult {
  payload: unknown;
  contentType: string;
  headers?: Record<string, unknown>;
}

/**
 * Represents encoded price and size, with optional packing.
 *
 * - If packed: { decodingInfo, encodedPriceAndSize, undefined }
 * - If unpacked: { 0, size, price } (unchanged from original)
 */
export interface EncodedPriceAndSize {
  bits: number;
  meta: number;     // priceBytes (3 bits) + decimals (5 bits)
  field1: number;   // packed(size+price) or size
  field2?: number;  // price (if unpacked) or undefined (if packed)
}

/** The result of encoding data items */
export type PackedDataItem = (string | number | Buffer<ArrayBufferLike>)[];

/** Used by instrument encoder/decoder */
export type EncodingFn = (v: number | string | boolean, k: keyof InstrumentData) => number | string;
export type DecodingFn = (v: number | string | boolean) => string | number | boolean;

export type EncodedInstrumentItem = [
  timestamp: number,
  fields: string,
  ...values: (number | string | boolean)[],
];
