import type { Db }                                          from 'mongodb';
import { logger }                                              from '@devvir/service-kit';
import type { Service }                                        from '@devvir/service-kit';

import type { Accumulator, InstrumentItem, InstrumentMsg, StreamItem } from './types';
import { applyMessage, applyUpdate, rebuildCaches, snapshot }   from './accumulator';
import { synthesizeEvent, deriveFields }                        from './synthesizer';
import { computeBoundary }                                      from './boundary';
import { Reader }                                               from './reader';
import type { Provider }                                        from './provider';
import type { Writer }                                          from './writer';
import { INSTRUMENT_KEYS, INSTRUMENT_TYPES, INSTRUMENT_FILTER }  from './schema';

const HOUR_MS = 3_600_000;
const IDLE_MS = 30_000;

/**
 * Drives the hour loop. Owns the instrument accumulator: applies every real and
 * synthetic document, seals each hour with an anchor, and commits via the
 * Writer. Walks forward epoch by epoch, idling at the universe boundary.
 */
export class Walker {
  private readonly db:       Db;
  private readonly service:  Service;
  private readonly vaultUrl: string;
  private readonly provider: Provider;
  private readonly writer:   Writer;
  private readonly acc:      Accumulator;

  private hour:        string;
  private cachesDirty = false;

  constructor(
    db: Db, service: Service, vaultUrl: string,
    provider: Provider, writer: Writer, acc: Accumulator, startHour: string,
  ) {
    this.db       = db;
    this.service  = service;
    this.vaultUrl = vaultUrl;
    this.provider = provider;
    this.writer   = writer;
    this.acc      = acc;
    this.hour     = startHour;
  }

  /** Walk hours forward, epoch by epoch, until the service stops. */
  async run(): Promise<void> {
    this.service.increment('distillers');
    logger.info({ from: this.hour }, 'instrument: walking');

    while (! this.service.state('stopping')) {
      const boundary = await computeBoundary(this.vaultUrl);

      if (this.hour.slice(0, 10) >= boundary) {
        await sleep(IDLE_MS);

        continue;
      }

      // A fresh Reader per epoch — stale prefetch past the old boundary is dropped.
      this.provider.attach(new Reader(this.db, this.hour));

      while (this.hour.slice(0, 10) < boundary && ! this.service.state('stopping')) {
        await this.processHour(this.hour);

        this.hour = nextHour(this.hour);
      }
    }

    this.service.decrement('distillers');
    logger.info('instrument: walk stopped');
  }

  /* ---------------------------------------------------------------- */
  /*  Internals                                                        */
  /* ---------------------------------------------------------------- */

  /** Process one hour: walk its stream, apply every document, seal, commit. */
  private async processHour(hour: string): Promise<void> {
    const date      = hour.slice(0, 10);
    const hourEndMs = Date.parse(`${hour}:00:00.000Z`) + HOUR_MS;

    this.cachesDirty = true;

    const stream = await this.provider.getHourlyData(hour);

    let maxConsumedId: number | null = null;
    let i = 0;

    while (i < stream.length) {
      const ms    = stream[i]!.ms;
      const batch: StreamItem[] = [];

      while (i < stream.length && stream[i]!.ms === ms) batch.push(stream[i++]!);

      const consumed = await this.applyBatch(batch, ms, date);

      if (consumed !== null) maxConsumedId = Math.max(maxConsumedId ?? 0, consumed);
    }

    const seal: Omit<InstrumentMsg, '_id'> = {
      action:    'partial',
      timestamp: new Date(hourEndMs).toISOString(),
      keys:      INSTRUMENT_KEYS,
      types:     INSTRUMENT_TYPES,
      filter:    INSTRUMENT_FILTER,
      data:      snapshot(this.acc),
    };

    const anchorId = await this.writer.add(seal, false, date);

    await this.writer.commit(anchorId, maxConsumedId);
  }

  /**
   * Apply one millisecond's batch — real documents are applied and passed
   * through as processed; proxy rows are synthesized per symbol. Returns the
   * largest original `_id` consumed, or `null` if the batch held no real data.
   */
  private async applyBatch(batch: StreamItem[], ms: number, date: string): Promise<number | null> {
    let maxConsumedId: number | null = null;

    for (const item of batch) {
      if (item.kind !== 'real') continue;

      applyMessage(this.acc, item.doc);
      this.cachesDirty = true;
      maxConsumedId    = Math.max(maxConsumedId ?? 0, item.doc._id);

      const { action, timestamp, keys, types, filter, data } = item.doc;

      await this.writer.add({ action, timestamp, keys, types, filter, data }, true, date);
    }

    if (! batch.some(item => item.kind !== 'real')) return maxConsumedId;

    // The caches must reflect the accumulator as of the last real document.
    if (this.cachesDirty) {
      rebuildCaches(this.acc);
      this.cachesDirty = false;
    }

    const bySymbol = new Map<string, Partial<InstrumentItem>>();

    for (const item of batch) {
      if (item.kind === 'event') {
        for (const [sym, fields] of synthesizeEvent(item.source, item.row, this.acc)) {
          merge(bySymbol, sym, fields);
        }
      } else if (item.kind === 'rolling') {
        if (this.acc.settled.has(item.symbol)) continue;

        merge(bySymbol, item.symbol, item.fields);
      }
    }

    const tsString = new Date(ms).toISOString();

    for (const sym of [...bySymbol.keys()].sort()) {
      if (! this.acc.knownSymbols.has(sym)) continue;

      const fields = bySymbol.get(sym)!;

      deriveFields(this.acc, sym, fields);
      applyUpdate(this.acc, sym, fields);

      await this.writer.add(
        { action: 'update', timestamp: tsString, data: [{ ...fields, symbol: sym, timestamp: tsString }] },
        false, date,
      );
    }

    return maxConsumedId;
  }
}

/* ------------------------------------------------------------------ */

/** Merge a proxy contribution into the per-symbol field map. */
function merge(map: Map<string, Partial<InstrumentItem>>, sym: string, fields: Partial<InstrumentItem>): void {
  const existing = map.get(sym);

  map.set(sym, existing ? { ...existing, ...fields } : { ...fields });
}

/** The next `YYYY-MM-DDTHH` hour key. */
function nextHour(hour: string): string {
  const d = new Date(`${hour}:00:00.000Z`);

  d.setUTCHours(d.getUTCHours() + 1);

  return d.toISOString().slice(0, 13);
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
