import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VENUE_NAMES, channelsFor, venueFor } from '../src/venues';
import { bitmex, parseChannel } from '../src/venues/bitmex';

// ── Registry ──────────────────────────────────────────────────────────────────

describe('venue registry', () => {
  it('resolves a known venue by name', () => {
    expect(venueFor('bitmex')).toBe(bitmex);
  });

  it('throws for an unknown venue, naming the ones that exist', () => {
    expect(() => venueFor('nasdaq')).toThrow(/Unknown venue 'nasdaq' — known: binance, bitmex, bybit, kraken, okx/);
  });

  // The core dispatches entirely through this interface, so a venue missing a
  // required method would fail at runtime on the first frame rather than here.
  it('every registered venue implements the required surface', () => {
    for (const name of VENUE_NAMES) {
      const v = venueFor(name);

      expect(typeof v.endpoints).toBe('function');
      expect(typeof v.endpointFor).toBe('function');
      expect(typeof v.subscribeFrame).toBe('function');
      expect(typeof v.unsubscribeFrame).toBe('function');
      expect(typeof v.matchAck).toBe('function');
      expect(typeof v.isData).toBe('function');
    }
  });

  it('every venue reports at least one endpoint with a wss URL', () => {
    for (const name of VENUE_NAMES) {
      const endpoints = venueFor(name).endpoints();

      expect(endpoints.length).toBeGreaterThan(0);

      for (const e of endpoints) {
        expect(e.name).toBeTruthy();
        expect(e.url.startsWith('wss://')).toBe(true);
      }
    }
  });
});

// ── BitMEX: data vs control ───────────────────────────────────────────────────

describe('bitmex.isData', () => {
  it('accepts a data frame', () => {
    expect(bitmex.isData({ table: 'trade', action: 'insert', data: [] })).toBe(true);
  });

  it('rejects control frames', () => {
    expect(bitmex.isData({ subscribe: 'trade', success: true })).toBe(false);
    expect(bitmex.isData({ info: 'Welcome', version: '2.0' })).toBe(false);
    expect(bitmex.isData({ nonsense: true })).toBe(false);
  });
});

// ── BitMEX: acks ──────────────────────────────────────────────────────────────

describe('bitmex.matchAck', () => {
  it('confirms a plain channel', () => {
    expect(bitmex.matchAck({ subscribe: 'trade', success: true }, 'trade')).toBe('ok');
  });

  it('reports an explicit failure', () => {
    expect(bitmex.matchAck({ subscribe: 'trade', success: false }, 'trade')).toBe('failed');
  });

  it('ignores frames that are not acks', () => {
    expect(bitmex.matchAck({ table: 'trade', action: 'insert' }, 'trade')).toBeNull();
  });

  it('ignores an ack for a different channel', () => {
    expect(bitmex.matchAck({ subscribe: 'quote', success: true }, 'trade')).toBeNull();
  });

  // BitMEX acks `orderBookL2::Primary` as the bare table plus a `pool` field.
  it('matches a pooled subscription on base channel + pool', () => {
    const ack = { subscribe: 'orderBookL2', pool: 'Primary', success: true };

    expect(bitmex.matchAck(ack, 'orderBookL2::Primary')).toBe('ok');
    expect(bitmex.matchAck(ack, 'orderBookL2::Secondary')).toBeNull();
  });
});

// ── BitMEX: endpoints and socket keys ─────────────────────────────────────────

describe('bitmex endpoint + socket selection', () => {
  it('routes platform channels to the platform endpoint', () => {
    expect(bitmex.endpointFor('announcement')).toBe('platform');
    expect(bitmex.endpointFor('chat')).toBe('platform');
  });

  it('routes everything else to realtime', () => {
    expect(bitmex.endpointFor('trade')).toBe('realtime');
    expect(bitmex.endpointFor('orderBookL2::Primary')).toBe('realtime');
  });

  it('uses the pool as the socket key, so each pool gets its own connection', () => {
    expect(bitmex.socketKey!('orderBookL2::Primary')).toBe('Primary');
    expect(bitmex.socketKey!('trade')).toBe('');
  });
});

// ── BitMEX: endpoints ─────────────────────────────────────────────────────────

describe('bitmex.endpoints', () => {
  // Live only — hoarder is a collector, and testnet data is not worth archiving.
  it('reports the two live endpoints', () => {
    expect(bitmex.endpoints()).toEqual([
      { name: 'realtime', url: 'wss://www.bitmex.com/realtime' },
      { name: 'platform', url: 'wss://www.bitmex.com/realtimePlatform' },
    ]);
  });
});

// ── BitMEX: channel parsing ───────────────────────────────────────────────────

describe('bitmex parseChannel', () => {
  it('splits a pooled arg back into base + pool', () => {
    expect(parseChannel('orderBookL2::Primary')).toEqual({ base: 'orderBookL2', pool: 'Primary' });
    expect(parseChannel('trade')).toEqual({ base: 'trade' });
  });
});

// ── Startup channels ──────────────────────────────────────────────────────────

describe('channelsFor', () => {
  it('returns the venue\'s configured channel list', () => {
    const channels = channelsFor('bitmex');

    expect(channels.length).toBeGreaterThan(0);
    expect(channels).toContain('orderBookL2::Primary');
    expect(channels).toContain('orderBookL2::Secondary');
  });

  it('returns nothing for a venue with no channel list', () => {
    expect(channelsFor('nasdaq')).toEqual([]);
  });

  // Every configured channel has to resolve to a real endpoint and socket, or
  // the subscription fails at startup on a typo nobody would notice until then.
  it('every configured channel resolves to one of its venue\'s endpoints', () => {
    for (const name of VENUE_NAMES) {
      const v         = venueFor(name);
      const endpoints = v.endpoints().map(e => e.name);

      for (const channel of channelsFor(name))
        expect(endpoints).toContain(v.endpointFor(channel));
    }
  });
});
