import { logger } from '@devvir/service';
import type { InstrumentData } from '@tradebot/types';
import type { DecodingFn, EncodedInstrumentItem, EncodingFn, PackedDataItem } from './types';
import { INSTRUMENT_FIELD, INSTRUMENT_FIELD_REVERSE, TICK_DIRECTION, TICK_DIRECTION_REVERSE } from './mappings';
import { encodeTimestamp, decodeTimestamp } from './utils';

// ── Encode ─────────────────────────────────────────────────────────────────────

/**
 * Encode an instrument by encoding the keys and presence indicators.
 *
 * Symbol is implicit (not stored) since it's the primary key.
 * Only present fields are stored as values.
 */
export const encodeInstrument = (item: InstrumentData): PackedDataItem => {
  const { symbol, timestamp, ...props } = item; /** symbol and timestamp are always present */

  const fields = Object.keys(props).map(k => INSTRUMENT_FIELD[k as keyof typeof INSTRUMENT_FIELD]);
  const values = Object.entries(props).map(([k, v]) => applyEncoding(k, v));

  return [
    encodeTimestamp(timestamp).number,  // Timestamp, always present
    fields.join(''),                    // Ordered list of fields present in item (by field code)
    ...values,                          // Encoded values corresponding to the fields
  ];
};

// ── Decode ─────────────────────────────────────────────────────────────────────

export const decodeInstrument = (payload: Record<string, unknown[]>): InstrumentData[] => {
  const items: InstrumentData[] = [];

  for (const [symbol, data] of Object.entries(payload)) {
    if (! Array.isArray(data) || data.length === 0) continue;

    for (const item of data) {
      const [ encodedTs, encodedFieldsStr, ...encodedValues ] = item as EncodedInstrumentItem;
      const encodedFields = encodedFieldsStr.split('') as (keyof typeof INSTRUMENT_FIELD_REVERSE)[];

      const fields = encodedFields.map(f => INSTRUMENT_FIELD_REVERSE[f]);
      const entries = encodedValues.map((encoded, idx) => [fields[idx], applyDecoding(fields[idx], encoded)]);
      const timestamp = typeof encodedTs === 'number' ? decodeTimestamp(encodedTs) : encodedTs;

      items.push({ symbol, timestamp, ...Object.fromEntries(entries) });
    }
  }

  return items;
};

// ── Utils ─────────────────────────────────────────────────────────────────────

const isEncodableProp = (k: string): k is keyof typeof encodable => k in encodable;

const encodeTs: EncodingFn = (v) => encodeTimestamp(v as string).number;
const decodeTs: DecodingFn = (v) => decodeTimestamp(v as number);

const applyEncoding = (k: string, v: string | number | boolean): number | string => {
  if (typeof v === 'boolean') return Number(v);

  try {
    if (isEncodableProp(k)) return encodable[k]?.[0](v, k) ?? v;
  } catch (err) {
    logger.warn({ err }, 'Falling back to raw timestamp/timespan');
  }

  return v;
}

const applyDecoding = (k: string, v: number | string | boolean): string | number | boolean => {
  const booleanFields = new Set<string>(['isQuanto', 'isInverse', 'taxed', 'deleverage', 'hasLiquidity', 'instantPnl']);

  if (typeof v === 'string') return v;  // If it's a string, it's not encoded
  if (booleanFields.has(k)) return Boolean(v);
  if (isEncodableProp(k)) return encodable[k]?.[1](v) ?? v;

  return v;
}

const encodable: Partial<Record<keyof InstrumentData, [EncodingFn, DecodingFn]>> = {
  /* Timestamps */
  timestamp: [encodeTs, decodeTs],
  listing: [encodeTs, decodeTs],
  front: [encodeTs, decodeTs],
  expiry: [encodeTs, decodeTs],
  settle: [encodeTs, decodeTs],
  listedSettle: [encodeTs, decodeTs],
  fundingTimestamp: [encodeTs, decodeTs],
  rebalanceTimestamp: [encodeTs, decodeTs],
  launchingTimestamp: [encodeTs, decodeTs],

  /* Timespans */
  calcInterval: [encodeTs, decodeTs],
  fundingInterval: [encodeTs, decodeTs],
  publishInterval: [encodeTs, decodeTs],
  rebalanceInterval: [encodeTs, decodeTs],
  relistInterval: [encodeTs, decodeTs],

  /* Enums */
  lastTickDirection: [
    (v) => TICK_DIRECTION[v as keyof typeof TICK_DIRECTION] ?? v,
    (v) => TICK_DIRECTION_REVERSE[v as keyof typeof TICK_DIRECTION_REVERSE] ?? v,
  ],
} as const;
