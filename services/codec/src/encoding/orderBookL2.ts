import type { OrderBookL2Data, BitmexAction } from '@tradebot/types';
import type { PackedDataItem } from './types';
import { SIDE_ID, SIDE_ID_REVERSE } from './mappings';
import { pack, encodeTimestamp, decodeTimestamp, encodePriceAndSize, decodePriceAndSize } from './utils';

// ── Encode ─────────────────────────────────────────────────────────────────────

/**
 * Compression strategy for orderBookL2:
 * - delete: [id, ts]
 * - other:  [id, pack(ts, meta, side), field1, [field2], [pool]]
 */
export const encodeOrderBookL2 = (
  { id, side, size, price, transactTime, pool }: OrderBookL2Data,
  action: BitmexAction,
): PackedDataItem => {
  const ts = encodeTimestamp(transactTime);

  if (action === 'delete') return [id, ts.number];

  const { meta, field1, field2 } = encodePriceAndSize(price, size!);
  const encodedSizePrice = meta ? [field1] : [field1, field2!];
  const encodedMeta = { number: meta, bits: 10 };
  const encodedTsSideMeta = Number(pack([ts, encodedMeta, SIDE_ID[side]]));

  return [
    id,
    encodedTsSideMeta,
    ...encodedSizePrice,
    ...(pool ? [pool] : []),
  ];
};

// ── Decode ─────────────────────────────────────────────────────────────────────

const decodeItem = (item: unknown[], action: BitmexAction): Partial<OrderBookL2Data> => {
  const id = item[0] as number;

  if (action === 'delete') {
    return { id, transactTime: decodeTimestamp(item[1] as number) };
  }

  const encoded = item[1] as number;
  const field1 = item[2] as number;

  const sideId = encoded & 0x1;
  const meta = (encoded >> 1) & 0x3ff;
  const ts = encoded >> 11;
  const priceBytes = (meta >> 5) & 0x7;

  const base = {
    id,
    side: SIDE_ID_REVERSE[sideId as 0 | 1] || 'Buy',
    transactTime: decodeTimestamp(ts),
  } as const;

  if (priceBytes === 0) {
    return { ...base, size: field1, price: item[3] as number, pool: item[4] as string | undefined };
  }

  const { price, size } = decodePriceAndSize(field1, meta);
  return { ...base, size, price, pool: item[3] as string | undefined };
};

export const decodeOrderBookL2 = (
  payload: Record<string, unknown[]>,
  action: BitmexAction,
): OrderBookL2Data[] => {
  const items: OrderBookL2Data[] = [];

  for (const [symbol, symbolData] of Object.entries(payload)) {
    if (symbol === '_') continue;

    for (const raw of symbolData) {
      const d = decodeItem(raw as unknown[], action);
      items.push({
        symbol,
        id: d.id || 0,
        side: d.side || 'Buy',
        size: d.size,
        price: d.price || 0,
        transactTime: d.transactTime || '',
        timestamp: d.transactTime || '',
        pool: d.pool,
      });
    }
  }

  return items;
};
