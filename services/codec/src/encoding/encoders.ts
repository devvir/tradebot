import {
  type BitmexDataItem,
  type PackedDataItem,
  type EncodedField,
  type InstrumentData,
  type OrderBookL2Data,
  type QuoteData,
  type TradeData,
  type BitmexAction,
  INSTRUMENT_KEY,
  SIDE_ID,
  TICK_DIRECTION,
  isBitmexDataWithSymbol,
} from '.';

/**
 * Start of encoded timestamp range (2000-01-01 00:00:00.000Z)
 */
const EPOCH_2000 = 946684800000;

/**
 * Semver string encoding (9 bits: 2 major + 3 minor + 4 patch)
 */
export const encodeVersion = (version: string): EncodedField => {
  const [major, minor, patch] = version.split('.').map(Number);
  const encoded = ((major & 0b11) << 7)
                | ((minor & 0b111) << 4)
                | (patch & 0b1111);

  return { encoded, bits: 9 };
};

/**
 * Semver string decoding (9 bits: 2 major + 3 minor + 4 patch)
 */
export const decodeVersion = (encoded: number): string => {
  const major = (encoded >> 7) & 0b11;
  const minor = (encoded >> 4) & 0b111;
  const patch = encoded & 0b1111;

  return `${major}.${minor}.${patch}`;
};

/**
 * Timestamp encoding (42 bits: ms since Jan 1, 2000 - covers up to 2100).
 */
export const encodeTimestamp = (isoString: string): EncodedField => {
  const ms = new Date(isoString).getTime();
  const offset = ms - EPOCH_2000;

  if (offset < 0 || offset > 0x3ffffffffff) {
    throw new Error(`Timestamp ${isoString} out of valid range (2000-2100)`);
  }

  return { encoded: offset, bits: 42 };
};

export const decodeTimestamp = (encoded: number | bigint): string => {
  const ms = Number(encoded) + EPOCH_2000;

  return new Date(ms).toISOString();
};

/**
 * Encode payload (doc.data) according to the table and action, applying the appropriate packing/trimming strategy.
 *
 * Output depends on whether symbols apply to the table:
 *  - without Symbol: { _: dataGroup }
 *  - with Symbol: { [symbol1]: dataGroup1, [symbol2]: dataGroup2, ... }
 */
export const encodePayload = (
  data: BitmexDataItem[],
  table: string,
  action: BitmexAction
): Record<string, unknown[]> => {
  const payload = data.map(item => extractPayload(item, table, action));

  if (! isBitmexDataWithSymbol(data)) {
    return { _: payload };
  }

  return Object.groupBy(payload, (_, i) => data[i].symbol) as Record<string, unknown[]>;
}

/**
 * Per-table encoding strategies
 */
const extractPayload = (item: BitmexDataItem, table: string, action: BitmexAction): unknown => {
  switch (table) {
    case 'instrument':
      return instrumentPayload(item as InstrumentData);

    case 'quote':
      return quotePayload(item as QuoteData);

    case 'orderBookL2':
      return orderBookL2Payload(item as OrderBookL2Data, action);

    case 'trade':
      return tradePayload(item as TradeData);

    default:
      return item;
  }
}

/**
 * Pack / trim instrument message payload.
 *
 * Assumptions:
 * - most data items make sparse use of the whole set of possible properties (~30 out of 97)
 * - this is dramatically lower for update action messages (< 10)
 * - storing the encoded list of fields (2 bytes per field) + the fields values is very efficient
 */
const instrumentPayload = (item: InstrumentData): PackedDataItem => {
  const fields = Object.keys(item).map(k => INSTRUMENT_KEY[k as keyof InstrumentData]);

  // TODO : encode bools (6), enums (3+), timestamps (9), ...
  return [ fields.join(''), ...Object.values(item)];
}

/**
 * Pack / trim quote message payload.
 *
 * Assumptions:
 * - only partial and insert actions
 * - all fields are present in any quote data item
 */
const quotePayload = ({ bidSize, bidPrice, askSize, askPrice }: QuoteData): PackedDataItem => {
  return [ bidSize, bidPrice, askPrice, askSize ];
}

/**
 * Pack / trim orderBookL2 message payload.
 *
 * Assumptions:
 * - delete actions only carry relevant data in id+side+transactTime
 * - all fields are present for any action, except size for deletes
 */
const orderBookL2Payload = (
  { id, side, size, price, transactTime, pool }: OrderBookL2Data,
  action: BitmexAction
): PackedDataItem => {
  const ts = encodeTimestamp(transactTime).encoded as number;
  const sideId = SIDE_ID[side];
  const poolItem = pool ? [pool] : [];  // This seems to exist only in the Rest API

  // TODO: pack side, size, price, transactTime
  // e.g. with an encoding determining how many bytes each holds (definitely less than 64)
  // First int64: side: 1bit, size-price-boundary: 3bits, transactTime: 42bits
  // Second int64: size: X bytes, price: 8-X bytes
  // That's 46 bits | 64 bits
  // we can rule out 8 bytes for both size and price together... (there won't be multi-billionaire
  // orders, and in any case we can use boundary := 0 to allow for one int64 for each if needed)
  // If this is feasible, orderBookL2 items go from 5 ints > 2 ints (320 bytes > 128 bytes)
  return (action === 'delete') ? [ id, sideId, ts ] : [ id, sideId, size!, price, ts, ...poolItem ];
}

/**
 * Pack / trim trade message payload.
 *
 * Assumptions:
 * - only partial and insert actions
 * - all fields are present in any trade data item
 */
const tradePayload = (
  { trdType, trdMatchID, side, size, price, tickDirection, grossValue, homeNotional, foreignNotional }: TradeData
): PackedDataItem => {
  const sideId = SIDE_ID[side];
  const tickId = TICK_DIRECTION[tickDirection];
  const trdItem = trdType === 'Regular' ? [] : [trdType];

  return [ ...trdItem, trdMatchID, sideId, size, price, tickId, grossValue, homeNotional, foreignNotional ];
}
