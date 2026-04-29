/**
 * WS message parsing tests.
 *
 * Connection lifecycle is covered by integration testing against a real
 * endpoint; here we just pin the message-shape filter that decides what
 * counts as a deliverable table message vs a control frame.
 */

import { describe, it, expect } from 'vitest';
import { _test_parseWsMessage as parseWsMessage, _test_TABLE_MAP as TABLE_MAP } from '../src/source/ws';

describe('parseWsMessage', () => {
  it('returns the message for a well-formed table frame', () => {
    const raw = JSON.stringify({ table: 'quote', action: 'update', data: [{ symbol: 'XBTUSD' }] });
    const msg = parseWsMessage(raw);

    expect(msg?.table).toBe('quote');
    expect(msg?.action).toBe('update');
    expect(msg?.data).toHaveLength(1);
  });

  it('returns null for non-JSON', () => {
    expect(parseWsMessage('not json at all')).toBeNull();
  });

  it('returns null for non-object payloads', () => {
    expect(parseWsMessage('123')).toBeNull();
    expect(parseWsMessage('"hello"')).toBeNull();
    expect(parseWsMessage('null')).toBeNull();
  });

  it('returns null for control frames (welcome / subscribe ack)', () => {
    expect(parseWsMessage(JSON.stringify({ info: 'Welcome', version: '2.0.0' }))).toBeNull();
    expect(parseWsMessage(JSON.stringify({ success: true, subscribe: 'quote:XBTUSD' }))).toBeNull();
  });

  it('returns null when table is not a string', () => {
    expect(parseWsMessage(JSON.stringify({ table: 42, data: [] }))).toBeNull();
  });

  it('returns null when data is not an array', () => {
    expect(parseWsMessage(JSON.stringify({ table: 'quote', data: 'oops' }))).toBeNull();
  });
});

describe('TABLE_MAP', () => {
  it('maps every DataDependency to a BitMEX table name', () => {
    expect(TABLE_MAP).toEqual({
      quote:      'quote',
      instrument: 'instrument',
      orders:     'order',
      position:   'position',
      trades:     'trade',
    });
  });
});
