import type { OrderBookL2Data } from '@tradebot/types';
import type { DecodedMessageData, PackedDataItem } from '../types';
import { SIDE_ID, SIDE_ID_REVERSE } from '../mappings';
import { pack, encodeTimestamp, decodeTimestamp, encodePriceAndSize, decodePriceAndSize } from '../utils';

// ── Encode ─────────────────────────────────────────────────────────────────────

/**
 * Compression strategy for orderBookL2:
 * - no size (delete action): [id, timestamp, transactTime]
 * - with size:  [id, timestamp, pack(transactTime, meta, side), field1, [field2], [pool]]
 */
export const encodeOrderBookL2 = (
  { id, side, size, price, transactTime, timestamp, pool }: OrderBookL2Data,
): PackedDataItem => {
  const ts = encodeTimestamp(timestamp);
  const tts = encodeTimestamp(transactTime);

  /** Delete actions have all props but size (who knows why) */
  if (! size) return [id, ts.number, tts.number];

  const { meta, field1, field2 } = encodePriceAndSize(price, size);
  const encodedSizePrice = meta ? [field1] : [field1, field2!];
  const encodedMeta = { number: meta, bits: 10 };
  const encodedTsSideMeta = pack([tts, encodedMeta, SIDE_ID[side]]);

  return [
    id,
    ts.number,
    encodedTsSideMeta,
    ...encodedSizePrice,
    ...(pool ? [pool] : []),
  ];
};

// ── Decode ─────────────────────────────────────────────────────────────────────

const decodeItem = (item: unknown[]): Partial<OrderBookL2Data> => {
  const id = item[0] as number;
  const timestamp = decodeTimestamp(item[1] as number);

  if (item.length === 3) { // delete: [id, timestamp, transactTime]
    return { id, timestamp, transactTime: decodeTimestamp(item[2] as number) };
  }

  const encoded = item[2] as number;
  const field1 = item[3] as number;

  const sideId = encoded & 0x1;
  const meta = (encoded >> 1) & 0x3ff;
  const tts = Math.floor(encoded / 2048);
  const priceBytes = (meta >> 5) & 0x7;

  const base = {
    id,
    timestamp,
    side: SIDE_ID_REVERSE[sideId as 0 | 1] || 'Buy',
    transactTime: decodeTimestamp(tts),
  } as const;

  if (priceBytes === 0) {
    return { ...base, size: field1, price: item[4] as number, pool: item[5] as string | undefined };
  }

  const { price, size } = decodePriceAndSize(field1, meta);
  return { ...base, size, price, pool: item[4] as string | undefined };
};

export const decodeOrderBookL2 = (payload: DecodedMessageData): OrderBookL2Data[] => {
  const items: OrderBookL2Data[] = [];

  for (const [symbol, symbolData] of Object.entries(payload)) {
    for (const raw of symbolData) {
      const doc = decodeItem(raw as unknown[]);

      items.push({
        symbol,
        id: doc.id,
        side: doc.side,
        size: doc.size,
        price: doc.price,
        transactTime: doc.transactTime,
        timestamp: doc.timestamp,
        pool: doc.pool,
      } as OrderBookL2Data);
    }
  }

  return items;
};
