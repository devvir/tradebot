import type { Db }                                          from 'mongodb';
import { logger }                                              from '@devvir/service-kit';
import type { Service }                                        from '@devvir/service-kit';
import { startOfDayMongoId }                                   from '@tradebot/utils';

import type { Accumulator, InstrumentItem, InstrumentMsg, StreamItem } from './types';
import { applyMessage, applyUpdate, rebuildCaches, snapshot, isReferenceSymbol } from './accumulator';
import { synthesizeEvent, deriveFields, isMarkFallback }        from './synthesizer';
import { merge }                                                from './merger';
import { Conflator, splitConflated }                            from './conflator';
import { computeBoundary }                                      from './boundary';
import { Reader }                                               from './reader';
import { recordSymbols, recordMarkFallback, startRecording, stopRecording } from './record';
import type { Provider }                                        from './provider';
import type { Writer }                                          from './writer';
import { INSTRUMENT_KEYS, INSTRUMENT_TYPES, INSTRUMENT_FILTER }  from './schema';

const HOUR_MS = 3_600_000;
const IDLE_MS = 30_000;

/** Conflated deltas (order book + references) are emitted on this grid (BitMEX's ≈5s cadence). */
const TICK_MS = 5_000;

/**
 * Drives the hour loop. Owns the instrument accumulator: applies every real and
 * synthetic document, seals each hour with an anchor, and commits via the
 * Writer. Walks forward epoch by epoch, idling at the universe boundary.
 */
export class Walker {
  private readonly db:       Db;
  private readonly service:  Service;
  private readonly provider: Provider;
  private readonly writer:   Writer;
  private readonly acc:      Accumulator;

  private servedThrough: string;
  private readonly coldStartId: number;
  private cachesDirty = false;

  /** Throttles synthesized conflated deltas to the 5s grid (see `Conflator`). */
  private readonly conflator = new Conflator();

  /**
   * Whether the stream is currently inside a gap (synthesizing). Tracked across
   * hours: it drives the real→gap re-base (`Conflator.reset`) and gates the tick
   * flush + seal so the Conflator only acts while there is synth to emit.
   */
  private inGap = false;

  constructor(
    db: Db, service: Service,
    provider: Provider, writer: Writer, acc: Accumulator, servedThrough: string, coldStartId: number,
  ) {
    this.db            = db;
    this.service       = service;
    this.provider      = provider;
    this.writer        = writer;
    this.acc           = acc;
    this.servedThrough = servedThrough;
    this.coldStartId   = coldStartId;
  }

  /** Walk hours forward, epoch by epoch, until the service stops. */
  async run(): Promise<void> {
    this.service.increment('distillers');
    startRecording();

    while (! this.service.state('stopping')) {
      const boundary = await computeBoundary();

      // A fresh Reader per epoch — stale prefetch past the old boundary is dropped.
      // It resumes from the start of the last served day; already-served hours
      // are re-read and dropped, so no per-table cursor needs persisting.
      this.provider.attach(new Reader(this.db, this.readFromId(), this.servedThrough));

      let walked = false;

      while (! this.service.state('stopping')) {
        const served = await this.provider.getHourlyData();

        // Drained within reach, or the next hour is past the settled boundary —
        // either way, end the epoch and re-evaluate after an idle wait.
        if (! served || served.hour.slice(0, 10) >= boundary) break;

        await this.processHour(served.hour, served.items);
        this.servedThrough = served.hour;
        walked             = true;
      }

      if (! walked) await sleep(IDLE_MS);
    }

    stopRecording();
    this.service.decrement('distillers');
    logger.info('Instrument distiller: stopped');
  }

  /**
   * The `_id` a fresh Reader streams from. Before anything is served it's the
   * cold-start floor (start of the first complete day); afterwards it's the
   * start of the last served day, so a re-created Reader resumes there and the
   * already-served hours are skipped by `servedThrough`.
   */
  private readFromId(): number {
    if (this.servedThrough === '') return this.coldStartId;

    // Start at the day of the NEXT hour to serve, not the last-served day: an
    // end-of-day resume then skips the completed prior day entirely, while a
    // mid-day resume still re-reads its day from the start (needed to reach the
    // resume hour across symbol clusters).
    const next = new Date(`${this.servedThrough}:00:00.000Z`);

    next.setUTCHours(next.getUTCHours() + 1);

    return startOfDayMongoId(next.toISOString().slice(0, 10));
  }

  /* ---------------------------------------------------------------- */
  /*  Internals                                                        */
  /* ---------------------------------------------------------------- */

  /** Process one hour: walk its stream, apply every document, seal, commit. */
  private async processHour(hour: string, stream: StreamItem[]): Promise<void> {
    const date        = hour.slice(0, 10);
    const hourStartMs = Date.parse(`${hour}:00:00.000Z`);
    const hourEndMs   = hourStartMs + HOUR_MS;

    this.cachesDirty = true;

    let maxConsumedId: number | null = null;
    let i        = 0;
    let nextTick = hourStartMs + TICK_MS;

    while (i < stream.length) {
      const ms    = stream[i]!.ms;
      const batch: StreamItem[] = [];

      // Flush the conflated deltas for every 5s window that closed before this batch —
      // interleaved into the stream at the right place, in timestamp order. Only inside
      // a gap: in a real stretch the Conflator holds nothing of this hour's making.
      while (nextTick <= ms) {
        if (this.inGap) await this.emitTick(nextTick, date);
        nextTick += TICK_MS;
      }

      while (i < stream.length && stream[i]!.ms === ms) batch.push(stream[i++]!);

      const consumed = await this.applyBatch(batch, ms, date);

      if (consumed !== null) maxConsumedId = Math.max(maxConsumedId ?? 0, consumed);
    }

    // The hour-boundary seal partial carries the finest accumulated state, so the final
    // window is reconciled into the baseline, not emitted (no `xx:00:00` tick). Only when
    // mid-gap; a real hour leaves the Conflator untouched (the next gap re-bases it).
    if (this.inGap) this.conflator.seal();

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

    recordSymbols(date, this.acc.knownSymbols.size);
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

      // Real data wins and shortcuts synthesis + conflation entirely — applied to the
      // accumulator and passed through whole (reference series included; BitMEX already
      // throttled them). A following gap re-bases the Conflator from this state.
      if (data.length > 0) {
        await this.writer.add({ action, timestamp, keys, types, filter, data }, true, date);
      }
    }

    if (! batch.some(item => item.kind !== 'real')) {
      this.inGap = false;   // an all-real batch — a real stretch; the Conflator stays idle
      return maxConsumedId;
    }

    // The caches must reflect the accumulator as of the last real document.
    if (this.cachesDirty) {
      rebuildCaches(this.acc);
      this.cachesDirty = false;
    }

    // Real→gap transition: re-base the Conflator from the current real state so this
    // gap's deltas diff against real values, and any window left from a previous gap
    // is discarded. A gap continuing across an hour boundary keeps `inGap` and is not
    // re-based here — the hour seal already reconciled it.
    if (! this.inGap) {
      this.conflator.reset(snapshot(this.acc));
      this.inGap = true;
    }

    const contributions: Array<[string, Partial<InstrumentItem>]> = [];

    for (const item of batch) {
      if (item.kind === 'event') {
        for (const [sym, fields] of synthesizeEvent(item.source, item.row, this.acc)) {
          contributions.push([sym, fields]);
        }
      } else if (item.kind === 'rolling') {
        if (this.acc.settled.has(item.symbol)) continue;

        contributions.push([item.symbol, item.fields]);
      }
    }

    const bySymbol = merge(contributions);

    const tsString = new Date(ms).toISOString();

    for (const sym of [...bySymbol.keys()].sort()) {
      if (! this.acc.knownSymbols.has(sym)) continue;

      const fields = bySymbol.get(sym)!;

      // A reference series: apply now so the seal carries it, but throttle its
      // emission — the Conflator flushes the net change on the next 5s tick.
      if (isReferenceSymbol(sym)) {
        applyUpdate(this.acc, sym, fields);
        this.conflator.accept(sym, fields);
        continue;
      }

      // A markMethod we don't reproduce exactly is active for this symbol (its mark
      // is a same-family fallback) — record that the method appeared today, so the
      // approximation is auditable (a per-day Set, not a per-batch emission count).
      const markMethod = this.acc.symCache.get(sym)?.markMethod;

      if (isMarkFallback(markMethod)) recordMarkFallback(date, markMethod!);

      deriveFields(this.acc, sym, fields);
      applyUpdate(this.acc, sym, fields);

      // Order-book fields ride the 5s grid (throttled via the Conflator); everything
      // else passes through now at its own cadence (lastPrice per-trade, 24h block
      // per-minute, funding/settlement as they occur).
      const { conflated, passthrough } = splitConflated(fields);

      if (Object.keys(conflated).length > 0) this.conflator.accept(sym, conflated);

      if (Object.keys(passthrough).length > 0) {
        await this.writer.add(
          { action: 'update', timestamp: tsString, data: [{ ...passthrough, symbol: sym, timestamp: tsString }] },
          false, date,
        );
      }
    }

    return maxConsumedId;
  }

  /** Emit the conflated deltas whose 5s window closed at `tickMs`, timestamped at the
   *  tick — the net change since the last emission, nothing if unchanged. */
  private async emitTick(tickMs: number, date: string): Promise<void> {
    const ts = new Date(tickMs).toISOString();

    for (const { symbol, fields } of this.conflator.flush()) {
      await this.writer.add(
        { action: 'update', timestamp: ts, data: [{ ...fields, symbol, timestamp: ts }] },
        false, date,
      );
    }
  }
}

/* ------------------------------------------------------------------ */

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
