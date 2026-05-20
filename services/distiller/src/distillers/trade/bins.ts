import type { Document } from 'mongodb';
import { startOfDayMongoId } from '@tradebot/utils';
import type { BinSize, Range } from '../types';

const BIN_CONFIG: Record<BinSize, { unit: string; amount: number }> = {
  '1m': { unit: 'minute', amount: 1 },
  '5m': { unit: 'minute', amount: 5 },
  '1h': { unit: 'hour',   amount: 1 },
  '1d': { unit: 'day',    amount: 1 },
};

export function trades2bins(binSize: BinSize): Document[] {
  return [
    { $sort: { _id: 1 } },
    {
      $group: {
        _id:             { symbol: '$symbol', period: groupTrades(binSize) },
        _binId:          { $first: '$_id' },
        open:            { $first: '$price' },
        high:            { $max: '$price' },
        low:             { $min: '$price' },
        close:           { $last: '$price' },
        trades:          { $sum: 1 },
        volume:          { $sum: '$size' },
        lastSize:        { $last: '$size' },
        turnover:        { $sum: '$grossValue' },
        homeNotional:    { $sum: '$homeNotional' },
        foreignNotional: { $sum: '$foreignNotional' },
        _pxv:            { $sum: { $multiply: ['$price', '$size'] } },
      },
    },
    {
      $set: {
        _id:       '$_binId',
        symbol:    '$_id.symbol',
        timestamp: periodToTimestamp('$_id.period', binSize),
        vwap:      { $cond: [{ $eq: ['$volume', 0] }, null, { $divide: ['$_pxv', '$volume'] }] },
      },
    },
    { $unset: ['_binId', '_pxv'] },

    ...fixOpen(), // Fix bins open to match BitMEX standard: O(N) = C(N-1)
  ];
}

export function bins2bins(binSize: BinSize): Document[] {
  return [
    { $sort: { _id: 1 } },
    {
      $group: {
        _id:             { symbol: '$symbol', period: groupBins(binSize) },
        _binId:          { $first: '$_id' },
        open:            { $first: '$open' },
        high:            { $max: '$high' },
        low:             { $min: '$low' },
        close:           { $last: '$close' },
        trades:          { $sum: '$trades' },
        volume:          { $sum: '$volume' },
        lastSize:        { $last: '$lastSize' },
        turnover:        { $sum: '$turnover' },
        homeNotional:    { $sum: '$homeNotional' },
        foreignNotional: { $sum: '$foreignNotional' },
        _pxv:            { $sum: { $multiply: ['$vwap', '$volume'] } },
      },
    },
    {
      $set: {
        _id:       '$_binId',
        symbol:    '$_id.symbol',
        timestamp: periodToTimestamp('$_id.period', binSize),
        vwap:      { $cond: [{ $eq: ['$volume', 0] }, null, { $divide: ['$_pxv', '$volume'] }] },
      },
    },
    { $unset: ['_binId', '_pxv'] },

    ...fixOpen(), // Fix bins open to match BitMEX standard: O(N) = C(N-1)
  ];
}

/**
 * Returns the $match stage for the given range, sized to full bins.
 * - trades2bins: matches raw `trade` by _id range [from, to) — no timestamp index needed
 * - bins2bins:   matches bin collections by timestamp (from, to]
 */
export function matchDocs(
  transform: (binSize: BinSize) => Document[],
  range:     Range,
  binSize:   BinSize,
): Document[] {
  const from = floorToBin(range.from, binSize);
  const to   = floorToBin(range.to,   binSize);

  return transform === trades2bins
    ? [{ $match: {
        _id:  { $gte: startOfDayMongoId(from), $lt: startOfDayMongoId(to) },
        side: { $in: ['Buy', 'Sell'] },
      } }]
    : [{ $match: { timestamp: { $gt:  from, $lte: to } } }];
}

export const floorToBin = (ts: string, binSize: BinSize): string => {
  const d = new Date(ts);

  if (binSize === '1m')      d.setUTCSeconds(0, 0);
  else if (binSize === '5m') d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 5) * 5, 0, 0);
  else if (binSize === '1h') d.setUTCMinutes(0, 0, 0);
  else if (binSize === '1d') d.setUTCHours(0, 0, 0, 0);

  return d.toISOString();
};

/* -------------------------------------------------------------------- */
/*  Internals                                                           */
/* -------------------------------------------------------------------- */

/**
 * BitMEX defines `open` as the price at the exact start of the period — i.e. the
 * previous bin's close — rather than the first trade's price (standard OHLCV convention).
 * This ensures open === previous close with no gaps between consecutive bins.
 * Bots relying on gap-free data would behave differently without this correction.
 */
function fixOpen(): Document[] {
  return [
    {
      $setWindowFields: {
        partitionBy: '$symbol',
        sortBy:      { timestamp: 1 },
        output: {
          _prevClose: { $shift: { output: '$close', by: -1 } },
        },
      },
    },
    { $set:   { open: { $ifNull: ['$_prevClose', '$open'] } } },
    { $unset: '_prevClose' },
  ];
}

/**
 * Trade timestamps are mid-period (e.g. 00:05:00.000Z falls into the next bin).
 */
const groupTrades = (binSize: BinSize): Document => {
  const { unit, amount } = BIN_CONFIG[binSize];

  return {
    $dateTrunc: {
      date: { $toDate: '$timestamp' },
      unit,
      binSize: amount,
    },
  };
};

/**
 * Bin timestamps are period-end (e.g. 00:05:00.000Z falls into the previous bin).
 * Shifting the date back 1ms ensures boundaries fall into the correct bin.
 */
const groupBins = (binSize: BinSize): Document => {
  const { unit, amount } = BIN_CONFIG[binSize];

  return {
    $dateTrunc: {
      date: { $dateSubtract: { startDate: { $toDate: '$timestamp' }, unit: 'millisecond', amount: 1 } },
      unit,
      binSize: amount,
    },
  };
};

const periodToTimestamp = (period: string, binSize: BinSize): Document => {
  const { unit, amount } = BIN_CONFIG[binSize];

  return {
    $dateToString: {
      format: '%Y-%m-%dT%H:%M:%S.000Z',
      date:   { $dateAdd: { startDate: period, unit, amount } },
    },
  };
};
