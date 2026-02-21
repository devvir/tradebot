/**
 * Encoded value with bit width specification, describing what and how much space is needed.
 */
export interface EncodedField {
  encoded: number | bigint;
  bits: number;
}

export interface EncodedMessage {
  headers: Record<string, unknown>;
  payload: Buffer | Record<string, unknown[]>;
}

export type PackedDataItem = (string | number | Buffer<ArrayBufferLike>)[];
