/**
 * Encoded value with bit width specification, describing what and how much space is needed.
 */
export interface EncodedField {
  encoded: number | bigint;
  bits: number;
}

export type PackedDataItem = (string | number | bigint)[];