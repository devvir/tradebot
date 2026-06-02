import { describe, it, expect } from 'vitest';
import { tableKind, isKnown, isWsServed, isRestServed, restKind, needsGrouping } from '../src/catalog';

// The BitMEX-standard public tables the provider serves: 7 message, 13 flat,
// 2 order book = 22. (`tick`/`compositeIndex` exist in the DB but are not BitMEX
// API tables, so they are excluded — see the "rejects" case below.)
const MESSAGE = ['orderBookL2', 'instrument', 'liquidation', 'connected', 'announcement', 'chat', 'publicNotifications'];
const FLAT    = ['trade', 'quote', 'funding', 'settlement', 'insurance',
                 'tradeBin1m', 'tradeBin5m', 'tradeBin1h', 'tradeBin1d',
                 'quoteBin1m', 'quoteBin5m', 'quoteBin1h', 'quoteBin1d'];
const ORDERBOOK = ['orderBook10', 'orderBookL2_25'];

describe('catalog — classification', () => {
  it('classifies the 7 message tables', () => {
    for (const t of MESSAGE) expect(tableKind(t)).toBe('message');
  });

  it('classifies the 13 flat tables', () => {
    for (const t of FLAT) expect(tableKind(t)).toBe('flat');
  });

  it('classifies the 2 order-book tables', () => {
    for (const t of ORDERBOOK) expect(tableKind(t)).toBe('orderbook');
  });

  it('covers exactly the 22 BitMEX-standard public tables', () => {
    expect(MESSAGE.length + FLAT.length + ORDERBOOK.length).toBe(22);
  });

  it('rejects deferred (tick/compositeIndex), private, and unknown tables', () => {
    for (const t of ['tick', 'compositeIndex', 'order', 'position', 'nope']) {
      expect(tableKind(t)).toBeNull();
      expect(isKnown(t)).toBe(false);
    }
  });
});

describe('catalog — surfaces', () => {
  it('serves every known table on WS', () => {
    for (const t of [...MESSAGE, ...FLAT, ...ORDERBOOK]) expect(isWsServed(t)).toBe(true);
  });

  it('serves REST per BitMEX semantics', () => {
    for (const t of FLAT)                                  expect(restKind(t)).toBe('historical');
    for (const t of ['orderBookL2', 'instrument', 'liquidation']) expect(restKind(t)).toBe('state');
    for (const t of ['chat', 'announcement'])              expect(restKind(t)).toBe('recent');
    // no BitMEX REST endpoint:
    for (const t of ['connected', 'publicNotifications', 'orderBook10', 'orderBookL2_25']) expect(restKind(t)).toBeNull();
  });

  it('isRestServed matches restKind', () => {
    for (const t of [...FLAT, 'orderBookL2', 'instrument', 'liquidation', 'chat', 'announcement']) {
      expect(isRestServed(t)).toBe(true);
    }
    for (const t of ['connected', 'publicNotifications', 'orderBook10', 'nope']) expect(isRestServed(t)).toBe(false);
  });

  it('groups only trade', () => {
    expect(needsGrouping('trade')).toBe(true);
    for (const t of ['quote', 'tradeBin1m', 'orderBookL2']) expect(needsGrouping(t)).toBe(false);
  });
});
