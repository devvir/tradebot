import type { InstrumentData } from "@tradebot/types";

export * from '../types';

/**
 * Encoded value with bit width specification (how much space to take).
 */
export interface EncodedField {
  number: number;
  bits: number;
}

export type UnknownMessage = Record<string, unknown>;

export type DecodedMessage = Record<string, unknown>;

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
export type PackedDataItem = (string | number)[];

/** Used by instrument encoder/decoder */
export type EncodingFn = (v: number | string | boolean, k: keyof InstrumentData) => number | string;
export type DecodingFn = (v: number | string | boolean) => string | number | boolean;

export type EncodedInstrumentItem = [
  timestamp: number,
  fields: string,
  ...values: (number | string | boolean)[],
];
