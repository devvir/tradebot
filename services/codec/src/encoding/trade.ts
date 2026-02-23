import type { TradeData } from '@tradebot/types';
import type { PackedDataItem } from './types';
import { encodePriceAndSize, decodePriceAndSize, extract, pack } from './utils';
import {
  SIDE_ID, SIDE_ID_REVERSE,
  TICK_DIRECTION, TICK_DIRECTION_REVERSE,
  TRD_TYPE, TRD_TYPE_REVERSE
} from './mappings';

// ── Encode ─────────────────────────────────────────────────────────────────────

/**
 * Trade payload: strip symbol/timestamp (recovered from grouping key + document _id),
 * encode side and tickDirection as compact ids, omit trdType when 'Regular'.
 *
 * Packed header layout (LSB → MSB):
 *   pool(1) | foreignNotional(1) | homeNotional(1) | grossValue(1) | trdMatchID(1)
 *   | trdType(2) | tickDirection(2) | side(1) | sizePriceMeta(10)
 *
 * Body: [packed, ...sizePrice, trdMatchID?, grossValue?, homeNotional?, foreignNotional?, pool?, trdType?]
 */
export const encodeTrade = (
  { side, size, price, tickDirection, trdType, trdMatchID, grossValue, homeNotional, foreignNotional, pool }: TradeData,
): PackedDataItem => {
  const { meta: sizePriceMeta, field1: sizeAndPrice, field2: priceIfRaw } = encodePriceAndSize(price, size);
  // Use meta (not filter(Boolean)) to distinguish packed vs raw — size or price may be 0
  const encodedSizeAndPrice = sizePriceMeta !== 0
    ? [sizeAndPrice]
    : [sizeAndPrice, priceIfRaw as number];

  const trdTypeId = TRD_TYPE[trdType as keyof typeof TRD_TYPE] ?? trdType;
  const trdTypeEncoded = typeof trdTypeId === 'number' ? trdTypeId : 2;

  const packed = pack([
    { number: sizePriceMeta, bits: 10 },
    { number: SIDE_ID[side], bits: 1 },
    { number: TICK_DIRECTION[tickDirection], bits: 2 },
    { number: trdTypeEncoded, bits: 2 },
    { number: trdMatchID ? 1 : 0, bits: 1 },
    { number: grossValue ? 1 : 0, bits: 1 },
    { number: homeNotional ? 1 : 0, bits: 1 },
    { number: foreignNotional ? 1 : 0, bits: 1 },
    { number: pool ? 1 : 0, bits: 1 },
  ]);

  return [
    Number(packed),
    ...encodedSizeAndPrice,
    ...(trdMatchID ? [trdMatchID] : []),
    ...(grossValue ? [grossValue] : []),
    ...(homeNotional ? [homeNotional] : []),
    ...(foreignNotional ? [foreignNotional] : []),
    ...(pool ? [pool] : []),
    ...(trdTypeEncoded === 2 ? [trdType] : []),
  ];
};

// ── Decode ─────────────────────────────────────────────────────────────────────

const decodeTradeItem = (arr: unknown[]): Omit<TradeData, 'symbol' | 'timestamp'> => {
  const packed = arr[0] as number;

  const poolFlag =             extract(packed, 0, 1);
  const foreignNotionalFlag =  extract(packed, 1, 1);
  const homeNotionalFlag =     extract(packed, 2, 1);
  const grossValueFlag =       extract(packed, 3, 1);
  const trdMatchIDFlag =       extract(packed, 4, 1);
  const trdTypeEncoded =       extract(packed, 5, 2);
  const tickDirectionId =      extract(packed, 7, 2);
  const sideId =               extract(packed, 9, 1);
  const meta =                 extract(packed, 10, 10);

  let i = 1;

  // Price + size: packed (meta ≠ 0) or raw pair (meta = 0)
  let price: number;
  let size: number;

  if (meta !== 0) {
    ({ price, size } = decodePriceAndSize(arr[i++] as number, meta));
  } else {
    size = arr[i++] as number;
    price = arr[i++] as number;
  }

  // Optional fields, conditioned on presence flags
  const trdMatchID =      trdMatchIDFlag ? arr[i++] as string : undefined;
  const grossValue =      grossValueFlag ? arr[i++] as number : undefined;
  const homeNotional =    homeNotionalFlag ? arr[i++] as number : undefined;
  const foreignNotional = foreignNotionalFlag ? arr[i++] as number : undefined;
  const pool =            poolFlag ? arr[i++] as string : undefined;

  // trdType: known id or appended string
  const trdType = trdTypeEncoded === 2
    ? arr[i++] as string
    : TRD_TYPE_REVERSE[trdTypeEncoded as 0 | 1];

  const result: Omit<TradeData, 'symbol' | 'timestamp'> = {
    side: SIDE_ID_REVERSE[sideId as 0 | 1],
    size,
    price,
    tickDirection: TICK_DIRECTION_REVERSE[tickDirectionId as 0 | 1 | 2 | 3],
    trdType,
  };

  if (trdMatchID !== undefined) result.trdMatchID = trdMatchID;
  if (grossValue !== undefined) result.grossValue = grossValue;
  if (homeNotional !== undefined) result.homeNotional = homeNotional;
  if (foreignNotional !== undefined) result.foreignNotional = foreignNotional;
  if (pool !== undefined) result.pool = pool;

  return result;
};

export const decodeTrade = (
  payload: Record<string, unknown[]>,
  timestamp: string,
): TradeData[] => {
  const items: TradeData[] = [];

  for (const [symbol, symbolData] of Object.entries(payload)) {
    if (symbol === '_') continue;

    for (const raw of symbolData) {
      items.push({ symbol, timestamp, ...decodeTradeItem(raw as unknown[]) });
    }
  }

  return items;
};
