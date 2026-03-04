import type { BitmexDataItem, QuoteDataFull } from '@tradebot/types';
import type { DecodedMessageData, PackedDataItem } from '../types';
import { pack, encodePriceAndSize, decodePriceAndSize, extract, encodeTimestamp, decodeTimestamp } from '../utils';

// ── Encode ─────────────────────────────────────────────────────────────────────

/**
 * Compression strategy for quote (output depends on which price/size pairs are present):
 *
 * Item layout: [encodedTimestamp, ...quoteData]
 *
 * quoteData (packed):
 *  - 1 item:  one pair present  → packed with LSB witness (0 = bid, 1 = ask)
 *  - 2 items: both pairs        → [packedBid, packedAsk], LSB is always 0/1 respectively
 *
 * quoteData (raw fallback when packing exceeds safe int range):
 *  - 3 items: one pair + witness → [price, size, witness]
 *  - 4 items: both pairs         → [bidPrice, bidSize, askPrice, askSize]
 *
 * Packed layout per value: priceAndSize | meta(10 bits) | witness(1 bit)
 */
const MAX_PACKABLE = 4_398_046_511_103; // 2^42 - 1, leaving room for meta+witness

export const encodeQuote = (
  { timestamp, bidPrice, bidSize, askPrice, askSize }: QuoteDataFull
): PackedDataItem => {
  const { meta: bidMeta, field1: bid } = bidPrice ? encodePriceAndSize(bidPrice, bidSize!) : {};
  const { meta: askMeta, field1: ask } = askPrice ? encodePriceAndSize(askPrice, askSize!) : {};

  // Fall back to raw if any pair couldn't be packed or exceeds safe range
  if ((bid && (! bidMeta || bid > MAX_PACKABLE)) || (ask && (! askMeta || ask > MAX_PACKABLE))) {
    const witness = bidPrice && askPrice ? [] : [bidPrice ? 0 : 1];

    return [
      encodeTimestamp(timestamp).number,
      bidPrice, bidSize,
      askPrice, askSize,
      ...witness,
    ].filter(x => x !== undefined);
  }

  return [
    encodeTimestamp(timestamp).number,
    ...(bid ? [Number(pack([bid, { number: bidMeta!, bits: 10 }, 0]))] : []),
    ...(ask ? [Number(pack([ask, { number: askMeta!, bits: 10 }, 1]))] : []),
  ];
};

// ── Decode ─────────────────────────────────────────────────────────────────────

/**
 * Unpack a single packed quote value.
 *
 * Layout (LSB → MSB): witness(1) | meta(10) | priceAndSize(remaining)
 */
const unpackQuoteValue = (packed: number) => {
  const meta = extract(packed, 1, 10);
  const priceAndSize = extract(packed, 11, 42);

  return decodePriceAndSize(priceAndSize, meta);
};

export const decodeQuote = (payload: DecodedMessageData): BitmexDataItem[] => {
  const items: BitmexDataItem[] = [];

  for (const [symbol, symbolData] of Object.entries(payload)) {
    if (symbol === '_' || ! Array.isArray(symbolData)) continue;

    for (const raw of symbolData) {
      const arr = raw as unknown[];
      const timestamp = decodeTimestamp(arr[0] as number);
      const base = { symbol, timestamp };
      const rest = arr.slice(1);

      switch (rest.length) {
        case 1: {
          const packed = rest[0] as number;
          const { price, size } = unpackQuoteValue(packed);
          items.push(
            ((packed & 1) === 0
              ? { ...base, bidPrice: price, bidSize: size }
              : { ...base, askPrice: price, askSize: size }
            ) as BitmexDataItem
        );
          break;
        }

        case 2: {
          const { price: bidPrice, size: bidSize } = unpackQuoteValue(rest[0] as number);
          const { price: askPrice, size: askSize } = unpackQuoteValue(rest[1] as number);
          items.push({ ...base, bidPrice, bidSize, askPrice, askSize } as BitmexDataItem);
          break;
        }

        case 3: {
          const witness = rest[2] as number;
          items.push(
            (witness === 0
              ? { ...base, bidPrice: rest[0] as number, bidSize: rest[1] as number }
              : { ...base, askPrice: rest[0] as number, askSize: rest[1] as number }
            ) as BitmexDataItem
          );
          break;
        }

        case 4:
          items.push({
            ...base,
            bidPrice: rest[0] as number,
            bidSize: rest[1] as number,
            askPrice: rest[2] as number,
            askSize: rest[3] as number,
          } as BitmexDataItem);
          break;
      }
    }
  }

  return items;
};
