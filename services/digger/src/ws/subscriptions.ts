import { logger } from '@devvir/service-kit';
import type { WsServerHandle, WsServerClient } from '@devvir/service-kit';
import type { BitmexTable } from '@tradebot/types';
import * as clock from '../core/clock';
import type { Reader } from '../reader';
import type { WsMessage, DataItem } from '../core/types';

/** `ws` WebSocket.OPEN — inlined to avoid a runtime dependency on `ws`. */
const WS_OPEN = 1;

/**
 * Subscription orchestrator. Tracks per-table subscriber counts (a table is
 * consumed iff ≥1 subscriber) and drives cold-activation / warm partials.
 *
 * Ordering guarantee: a client never receives a delta before its partial. The
 * partial is sent and the client registered for egress in one **synchronous**
 * critical section, and the table's buffer is only made loop-visible (promoted)
 * after that — so the streaming loop, which yields between emits, cannot
 * interleave a delta in between. Concurrent cold subscribes to the same table are
 * serialised through `#activating`.
 */
export class Hub {
  readonly #counts     = new Map<BitmexTable, number>();
  readonly #activating = new Map<BitmexTable, Promise<void>>();

  constructor(private readonly server: WsServerHandle, private readonly reader: Reader) {}

  // ── Commands ────────────────────────────────────────────────────────────────

  async subscribe(client: WsServerClient, channel: string): Promise<void> {
    const subs = client.data.subs as Set<string>;

    if (subs.has(channel)) return;

    const clk = clock.fetch();

    if (clk === null) {
      this.#send(client, { error: 'replay clock not set', request: { op: 'subscribe', args: [channel] } });

      return;
    }

    const table  = channelTable(channel);
    const symbol = channelSymbol(channel);
    const cold   = (this.#counts.get(table) ?? 0) === 0 && ! this.#activating.has(table);

    if (cold) {
      await this.#coldSubscribe(client, channel, table, symbol, clk);
    } else {
      await this.#warmSubscribe(client, channel, table, symbol);
    }
  }

  unsubscribe(client: WsServerClient, channel: string): void {
    const subs = client.data.subs as Set<string>;

    if (! subs.has(channel)) return;

    subs.delete(channel);
    this.#decrement(channelTable(channel));
  }

  disconnect(client: WsServerClient): void {
    const subs = client.data.subs as Set<string> | undefined;

    if (! subs) return;

    for (const channel of subs) this.#decrement(channelTable(channel));

    subs.clear();
  }

  /**
   * Re-prime every subscribed table at the current clock and resend fresh partials
   * to its subscribers. Called by the seek while the loop is paused, so there is no
   * concurrent emission to order against.
   */
  async reprime(): Promise<void> {
    const clk = clock.fetch();

    if (clk === null) return;

    for (const table of [...this.#counts.keys()]) {
      let partial: WsMessage | null = null;

      try {
        partial = await this.reader.activate(table, clk);
        this.reader.promote(table);
      } catch (err) {
        logger.error({ err, table }, 'reprime failed for table');

        continue;
      }

      if (! partial) continue;

      for (const client of this.server.clients()) {
        const subs = client.data.subs as Set<string> | undefined;

        if (! subs) continue;

        for (const channel of subs) {
          if (channelTable(channel) === table) this.#send(client, scope(partial, channelSymbol(channel)));
        }
      }
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async #coldSubscribe(
    client: WsServerClient, channel: string, table: BitmexTable, symbol: string | undefined, atClock: number,
  ): Promise<void> {
    let release!: () => void;

    this.#activating.set(table, new Promise<void>(r => { release = r; }));

    let partial: WsMessage | null;

    try {
      partial = await this.reader.activate(table, atClock);   // stages the buffer
    } catch (err) {
      this.#activating.delete(table);
      release();
      logger.error({ err, channel }, 'subscribe failed');
      this.#send(client, { error: 'subscribe failed', request: { op: 'subscribe', args: [channel] } });

      return;
    }

    // ── critical section (synchronous: partial → register → promote) ──
    if (partial) this.#send(client, scope(partial, symbol));

    (client.data.subs as Set<string>).add(channel);
    this.#counts.set(table, 1);
    this.reader.promote(table);

    this.#activating.delete(table);
    release();
  }

  async #warmSubscribe(
    client: WsServerClient, channel: string, table: BitmexTable, symbol: string | undefined,
  ): Promise<void> {
    const inFlight = this.#activating.get(table);

    if (inFlight) await inFlight;

    // ── critical section (synchronous: build partial → send → register) ──
    const partial = this.reader.partialFor(table);

    if (partial) this.#send(client, scope(partial, symbol));

    (client.data.subs as Set<string>).add(channel);
    this.#counts.set(table, (this.#counts.get(table) ?? 0) + 1);
  }

  #decrement(table: BitmexTable): void {
    const next = (this.#counts.get(table) ?? 0) - 1;

    if (next <= 0) {
      this.#counts.delete(table);
      this.reader.deactivate(table);
    } else {
      this.#counts.set(table, next);
    }
  }

  #send(client: WsServerClient, payload: unknown): void {
    if (client.socket.readyState === WS_OPEN) client.socket.send(JSON.stringify(payload));
  }
}

// ── Channel helpers ─────────────────────────────────────────────────────────

const channelTable  = (channel: string): BitmexTable => channel.split(':')[0] as BitmexTable;
const channelSymbol = (channel: string): string | undefined => channel.split(':')[1];

/** Filter a partial's data to a single symbol for a symbol-scoped subscriber. */
const scope = (msg: WsMessage, symbol: string | undefined): WsMessage => {
  if (! symbol) return msg;

  return { ...msg, data: (msg.data as DataItem[]).filter(d => d.symbol === symbol) };
};
