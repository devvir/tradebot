import { describe, it, expect } from 'vitest';
import { VENUE_NAMES, channelsFor, venueFor } from '../src/venues';
import { okx } from '../src/venues/okx';

// ── Registry ──────────────────────────────────────────────────────────────────

describe('venue registry', () => {
  it('resolves a known venue by name', () => {
    expect(venueFor('okx')).toBe(okx);
  });

  it('throws for an unknown venue, naming the ones that exist', () => {
    expect(() => venueFor('nasdaq')).toThrow(/Unknown venue 'nasdaq' — known: binance, bybit, kraken, okx/);
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

// ── Startup channels ──────────────────────────────────────────────────────────

describe('channelsFor', () => {
  it('returns the venue\'s configured channel list', () => {
    for (const name of VENUE_NAMES) expect(channelsFor(name).length).toBeGreaterThan(0);
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
