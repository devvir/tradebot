import type { QuoteData } from '@tradebot/types';
import type { PackedDataItem } from '../types';
import { pack, encodePriceAndSize, decodePriceAndSize, extract } from '../utils';

// ── Encode ─────────────────────────────────────────────────────────────────────

/**
 * Compression strategy for quote (output depends on which price/size pairs are present):
 *
 * Encoded (packed):
 *  - 1 item:  one pair present  → packed with LSB witness (0 = bid, 1 = ask)
 *  - 2 items: both pairs        → [packedBid, packedAsk], LSB is always 0/1 respectively
 *
 * Raw (fallback when packing exceeds safe int range):
 *  - 3 items: one pair + witness → [price, size, witness]
 *  - 4 items: both pairs         → [bidPrice, bidSize, askPrice, askSize]
 *
 * Packed layout per value: priceAndSize | meta(10 bits) | witness(1 bit)
 */
const MAX_PACKABLE = 4398046511103; // 2^42 - 1, leaving room for meta+witness in 53 bits

export const encodeQuote = (item: QuoteData): PackedDataItem => {
  const { bidPrice, bidSize, askPrice, askSize } = item as
    { bidPrice?: number; bidSize?: number; askPrice?: number; askSize?: number };

  const { meta: bidMeta, field1: bid } = bidPrice ? encodePriceAndSize(bidPrice, bidSize!) : {};
  const { meta: askMeta, field1: ask } = askPrice ? encodePriceAndSize(askPrice, askSize!) : {};

  // Fall back to raw if any pair couldn't be packed or exceeds safe range
  if ((bid && (! bidMeta || bid > MAX_PACKABLE)) || (ask && (! askMeta || ask > MAX_PACKABLE))) {
    const witness = bidPrice && askPrice ? [] : [bidPrice ? 0 : 1];
    return [bidPrice, bidSize, askPrice, askSize, ...witness].filter(x => x !== undefined);
  }

  return [
    ...(bid ? [Number(pack([bid, { number: bidMeta!, bits: 10 }, 0]))] : []),
    ...(ask ? [Number(pack([ask, { number: askMeta!, bits: 10 }, 1]))] : []),
  ];
};

// ── Decode ─────────────────────────────────────────────────────────────────────

/**
 * Unpack a single packed quote value.
 * Layout (LSB → MSB): witness(1) | meta(10) | priceAndSize(remaining)
 */
const unpackQuoteValue = (packed: number) => {
  const meta = extract(packed, 1, 10);
  const priceAndSize = extract(packed, 11, 42);

  return decodePriceAndSize(priceAndSize, meta);
};

export const decodeQuote = (
  payload: Record<string, unknown[]>,
  timestamp: string,
): QuoteData[] => {
  const items: QuoteData[] = [];

  for (const [symbol, symbolData] of Object.entries(payload)) {
    if (symbol === '_') continue;

    for (const raw of symbolData) {
      const arr = raw as unknown[];
      const base = { symbol, timestamp };

      switch (arr.length) {
        case 1: {
          const packed = arr[0] as number;
          const { price, size } = unpackQuoteValue(packed);
          items.push(
            (packed & 1) === 0
              ? { ...base, bidPrice: price, bidSize: size }
              : { ...base, askPrice: price, askSize: size },
          );
          break;
        }

        case 2: {
          const { price: bidPrice, size: bidSize } = unpackQuoteValue(arr[0] as number);
          const { price: askPrice, size: askSize } = unpackQuoteValue(arr[1] as number);
          items.push({ ...base, bidPrice, bidSize, askPrice, askSize });
          break;
        }

        case 3: {
          const witness = arr[2] as number;
          items.push(
            witness === 0
              ? { ...base, bidPrice: arr[0] as number, bidSize: arr[1] as number }
              : { ...base, askPrice: arr[0] as number, askSize: arr[1] as number },
          );
          break;
        }

        case 4:
          items.push({
            ...base,
            bidPrice: arr[0] as number,
            bidSize: arr[1] as number,
            askPrice: arr[2] as number,
            askSize: arr[3] as number,
          });
          break;
      }
    }
  }

  return items;
};
