import type { Collection, Db } from 'mongodb';import { createTable, BitmexTable as BT } from '@devvir/bitmex-database';
import type { BitmexMessage, Table } from '@devvir/bitmex-database';
import { logger } from '@devvir/service-kit';
import { ensureIndex } from '../utils/indexes';
import { startOfDayMongoId, TABLE_SPECS } from '@tradebot/utils';
import type { TableSpec } from '@tradebot/utils';
import { PartialConfig, StoredPartial } from './types';
import { BitmexAction } from '@tradebot/types';

const COLLECTION = '_partials_';
const BATCH_SIZE = 10_000;

/**
 * One config per supported table. orderBookL2_25 is intentionally skipped.
 */
const CONFIGS: PartialConfig[] = [
  { table: BT.OrderBookL2, collection: 'orderBookL2', shape: 'message' },
  { table: BT.Instrument,  collection: 'instrument',  shape: 'message' },

  { table: BT.Trade,       collection: 'trade',       shape: 'item' },
  { table: BT.Quote,       collection: 'quote',       shape: 'item' },
  { table: BT.Funding,     collection: 'funding',     shape: 'item' },
  { table: BT.Settlement,  collection: 'settlement',  shape: 'item' },
  { table: BT.Insurance,   collection: 'insurance',   shape: 'item' },

  { table: BT.TradeBin1m,  collection: 'tradeBin1m',  shape: 'item',  binFlavor: 'trade' },
  { table: BT.TradeBin5m,  collection: 'tradeBin5m',  shape: 'item',  binFlavor: 'trade' },
  { table: BT.TradeBin1h,  collection: 'tradeBin1h',  shape: 'item',  binFlavor: 'trade' },
  { table: BT.TradeBin1d,  collection: 'tradeBin1d',  shape: 'item',  binFlavor: 'trade' },

  { table: BT.QuoteBin1m,  collection: 'quoteBin1m',  shape: 'item',  binFlavor: 'quote' },
  { table: BT.QuoteBin5m,  collection: 'quoteBin5m',  shape: 'item',  binFlavor: 'quote' },
  { table: BT.QuoteBin1h,  collection: 'quoteBin1h',  shape: 'item',  binFlavor: 'quote' },
  { table: BT.QuoteBin1d,  collection: 'quoteBin1d',  shape: 'item',  binFlavor: 'quote' },
];

export const distillPartials = async (db: Db): Promise<void> => {
  await ensureIndex(db, '_partials_', [
    { timestamp: 1 },
    { action: 1, timestamp: 1 },
    { symbol: 1, timestamp: 1 },
  ]);

  await Promise.all(CONFIGS.map(tableCfg =>
    distillOneTable(db, tableCfg).catch((err: unknown) =>
      logger.error({ err, table: tableCfg.table }, 'Partial generation failed')),
  ));
};

/* ------------------------------------------------------------------ */
/*  Per-table driver                                                  */
/* ------------------------------------------------------------------ */

const distillOneTable = async (db: Db, cfg: PartialConfig): Promise<void> => {
  const spec = TABLE_SPECS[cfg.table as unknown as keyof typeof TABLE_SPECS] as TableSpec | undefined;

  if (! spec)
    return logger.warn({ table: cfg.table }, 'No TABLE_SPECS entry — skipping partial generation');

  logger.info({ table: cfg.collection }, 'Distilling partials');

  const source = db.collection(cfg.collection);
  const target = db.collection<StoredPartial>(COLLECTION);

  const table: Table<any> = createTable(cfg.table as any);

  const last = await latestPartial(target, cfg.table);

  let lastId: number;

  if (last === null) {
    lastId = 0;

    if (cfg.shape === 'item')
      applyDoc(table, cfg, { action: 'partial', data: [] }, spec);
  } else {
    applyDoc(table, cfg, { action: 'partial', data: last.data as Record<string, unknown>[] }, spec);
    lastId = startOfDayMongoId(last.date) - 1;
  }

  let currentDay: string | null = null;

  while (true) {
    const batch = await source
      .find({ _id: { $gt: lastId } } as any)
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .toArray() as Record<string, unknown>[];

    if (batch.length === 0) break;

    for (const doc of batch) {
      const date = (doc['timestamp'] as string)?.slice(0, 10);

      lastId = doc['_id'] as number;

      if (! date) continue;

      if (currentDay && date !== currentDay)
        await emitPartial(target, cfg, spec, table, currentDay);

      applyDoc(table, cfg, doc, spec);

      currentDay = date;
    }
  }
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const applyDoc = (
  accum: Table<any>,
  cfg:   PartialConfig,
  doc:   Record<string, unknown>,
  spec:  TableSpec,
): void => {
  if (cfg.shape === 'message' || doc.action === 'partial') {
    const action = doc.action as BitmexAction;
    const data   = doc.data   as Record<string, unknown>[];

    const msg = action === 'partial'
      ? { table: cfg.table, action, keys: spec.keys, types: spec.types, filter: spec.filter, data }
      : { table: cfg.table, action, data };

    return accum.apply(msg as BitmexMessage<any>, true);
  }

  const { _id: _drop, timestamp, ...item } = doc;
  // Old trade/quote entries from BitMEX official S3 dumps have 9 decimals (invalid)
  const data = [ { ...item, timestamp: (timestamp as string).slice(0, 23) + 'Z' } ];
  const msg: BitmexMessage<any> = { table: cfg.table, action: 'insert', data };

  logger.debug(msg);

  accum.apply(msg, true);
};

const emitPartial = async (
  target: Collection<StoredPartial>,
  cfg:    PartialConfig,
  spec:   TableSpec,
  accum:  Table<any>,
  day:    string,
): Promise<void> => {
  const nd       = nextDay(day);
  const midnight = `${nd}T00:00:00.000Z`;

  let data = accum.snapshot() as Record<string, unknown>[];

  if (cfg.binFlavor)
    data = synthesizeBinMidnight(data, midnight, cfg.binFlavor);

  data = data.map(item =>
    'timestamp' in item ? { ...item, timestamp: midnight } : item,
  );

  const doc: StoredPartial = {
    _id:       `${cfg.table}-${nd}`,
    table:     cfg.table,
    date:      nd,
    keys:      spec.keys,
    types:     spec.types as Record<string, string>,
    data,
  };

  await target.insertOne(doc as any).catch((err: any) => {
    if (err?.code !== 11000) throw err;
  });

  logger.debug({ table: cfg.table, date: nd, count: data.length }, 'Partial written');
};

const latestPartial = async (
  target: Collection<StoredPartial>,
  table:  string,
): Promise<StoredPartial | null> => {
  const doc = await target.findOne(
    { table } as any,
    { sort: { _id: -1 } },
  );

  return doc ? (doc as unknown as StoredPartial) : null;
};

const nextDay = (day: string): string => {
  const d = new Date(`${day}T00:00:00.000Z`);

  d.setUTCDate(d.getUTCDate() + 1);

  return d.toISOString().slice(0, 10);
};

/**
 * For bin tables, replace each item with a midnight entry if its timestamp
 * isn't already midnight:
 *   - trade bins: carry close (O=H=L=C = prev close, V=0, etc.)
 *   - quote bins: carry bid/ask forward
 */
const synthesizeBinMidnight = (
  data:     Record<string, unknown>[],
  midnight: string,
  flavor:   'trade' | 'quote',
): Record<string, unknown>[] => {
  return data.map(row => {
    const symbol = row['symbol'] as string | undefined;

    if (! symbol) return row;

    const ts = row['timestamp'] as string | undefined;

    if (ts === midnight) return row;

    if (flavor === 'trade') {
      const close = (row['close'] ?? row['vwap'] ?? 0) as number;

      return {
        ...row,
        symbol,
        timestamp:       midnight,
        open:            close,
        high:            close,
        low:             close,
        close,
        volume:          0,
        trades:          0,
        turnover:        0,
        homeNotional:    0,
        foreignNotional: 0,
        vwap:            close,
        lastSize:        0,
      };
    }

    return { ...row, symbol, timestamp: midnight };
  });
};

/* ------------------------------------------------------------------ */
/*  Test-only exports                                                 */
/* ------------------------------------------------------------------ */

export const _test_nextDay               = nextDay;
export const _test_synthesizeBinMidnight  = synthesizeBinMidnight;
