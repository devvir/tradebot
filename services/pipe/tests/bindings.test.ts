import { describe, it, expect } from 'vitest';
import parseBindings, { buildTopology, withDefaults } from '../src/bindings';

// Parsing tests (grammar, exchange types, routing keys, multiple bindings,
// whitespace, error cases) live in shared/utils/tests/routes.test.ts.
// This file only covers pipe-specific concerns: validation constraints,
// withDefaults business rules, and buildTopology output.

// ── Pipe-specific validation ──────────────────────────────────────────────────

describe('pipe validation', () => {
  it('rejects bare queue source — pipe sources must be exchanges', () => {
    expect(() => parseBindings('bare-queue > fanout:dst')).toThrow('must be an exchange');
  });

  it('rejects bare queue destination', () => {
    expect(() => parseBindings('fanout:src > bare-queue')).toThrow('must be an exchange');
  });

  it('rejects (key:value:replace) — router-only feature', () => {
    expect(() => parseBindings('fanout:src > fanout:dst(key:old:new)')).toThrow('router-only');
  });

  it('rejects header modifier — router-only feature', () => {
    expect(() => parseBindings('fanout:src > fanout:dst(header:x-h=v)')).toThrow('router-only');
  });

  it('rejects routing key on destination side', () => {
    expect(() => parseBindings('fanout:src > topic:dst(key:trade.*)')).toThrow(
      'Routing key can only be set on the source side',
    );
  });

  it('accepts routing key on source side', () => {
    expect(() => parseBindings('topic:src(key:trade.*) > fanout:dst')).not.toThrow();
  });

  it('accepts queue@exchange destination', () => {
    expect(() => parseBindings('topic:src > journalist@topic:journalist')).not.toThrow();
  });
});

// ── withDefaults ──────────────────────────────────────────────────────────────

describe('withDefaults', () => {
  it('sets routingKey # for topic source without a key', () => {
    const [b] = withDefaults(parseBindings('topic:src > fanout:dst'));
    expect(b!.routingKey).toBe('#');
  });

  it('preserves explicit routing key on topic source', () => {
    const [b] = withDefaults(parseBindings('topic:src(key:trade.btc) > fanout:dst'));
    expect(b!.routingKey).toBe('trade.btc');
  });

  it('throws for direct source without routing key', () => {
    expect(() => withDefaults(parseBindings('direct:src > fanout:dst'))).toThrow(
      'Routing key is required for direct exchange',
    );
  });

  it('direct source with routing key does not throw', () => {
    expect(() => withDefaults(parseBindings('direct:src(key:new) > fanout:dst'))).not.toThrow();
  });

  it('does not touch fanout source (no key required)', () => {
    const [b] = withDefaults(parseBindings('fanout:src > fanout:dst'));
    expect(b!.routingKey).toBeUndefined();
  });
});

// ── buildTopology ─────────────────────────────────────────────────────────────

describe('buildTopology', () => {
  it('creates both src and dst exchanges', () => {
    const topology = buildTopology(withDefaults(parseBindings('fanout:src > fanout:dst')));

    expect(topology.exchanges).toHaveProperty('src');
    expect(topology.exchanges).toHaveProperty('dst');
  });

  it('creates an exchangeBinding between source and destination', () => {
    const topology = buildTopology(withDefaults(parseBindings('fanout:src > fanout:dst')));

    expect(topology.exchangeBindings).toContainEqual({
      source: 'src', destination: 'dst',
    });
  });

  it('includes routingKey in exchangeBinding when specified', () => {
    const topology = buildTopology(withDefaults(parseBindings('topic:source(key:fragment) > fanout:stage-a')));

    expect(topology.exchangeBindings).toContainEqual({
      source: 'source', destination: 'stage-a', routingKey: 'fragment',
    });
  });

  it('topic without key defaults to # in exchangeBinding', () => {
    const topology = buildTopology(withDefaults(parseBindings('topic:src > fanout:dst')));

    expect(topology.exchangeBindings).toContainEqual({
      source: 'src', destination: 'dst', routingKey: '#',
    });
  });

  it('queue@exchange destination adds queue inside dst exchange', () => {
    const topology = buildTopology(withDefaults(parseBindings('topic:broadcast > journalist@topic:journalist')));

    expect(topology.exchanges!['journalist']!.queues).toEqual({
      journalist: { durable: true, routingKey: '#' },
    });
  });

  it('queue@exchange destination still creates the E2E exchangeBinding', () => {
    const topology = buildTopology(withDefaults(parseBindings('topic:broadcast > journalist@topic:journalist')));

    expect(topology.exchangeBindings).toContainEqual({
      source: 'broadcast', destination: 'journalist', routingKey: '#',
    });
  });

  it('exchange-only destination has no queues entry', () => {
    const topology = buildTopology(withDefaults(parseBindings('topic:broadcast > topic:journalist')));

    expect(topology.exchanges!['journalist']!.queues).toBeUndefined();
  });

  it('multiple bindings produce multiple exchangeBindings', () => {
    const topology = buildTopology(withDefaults(parseBindings(
      'fanout:a > fanout:b | fanout:b > fanout:c',
    )));

    expect(topology.exchangeBindings).toHaveLength(2);
  });
});
