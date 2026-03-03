import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  afterEach(() => {
    delete process.env.RABBITMQ_URL;
    delete process.env.PIPE_BINDINGS;
  });

  // ── Topology output ───────────────────────────────────────────────────────────

  describe('Topology output', () => {
    it('declares both source and destination exchanges', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.PIPE_BINDINGS = 'fanout:broadcast > fanout:ingest';

      const { topology } = loadConfig();

      expect(topology.exchanges?.broadcast).toEqual({ type: 'fanout' });
      expect(topology.exchanges?.ingest).toEqual({ type: 'fanout' });
      expect(topology.exchangeBindings).toHaveLength(1);
    });

    it('defaults untyped exchange to fanout', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.PIPE_BINDINGS = 'src > dst';

      const { topology } = loadConfig();

      expect(topology.exchanges?.src).toEqual({ type: 'fanout' });
      expect(topology.exchanges?.dst).toEqual({ type: 'fanout' });
    });

    it('deduplicates shared exchanges across bindings', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.PIPE_BINDINGS = 'fanout:broadcast > fanout:ingest | fanout:broadcast > fanout:archive';

      const { topology } = loadConfig();

      expect(Object.keys(topology.exchanges ?? {})).toHaveLength(3);
      expect(topology.exchangeBindings).toHaveLength(2);
    });

    it('includes explicit routing key in exchange binding', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.PIPE_BINDINGS = 'topic:events(key:trade.*) > fanout:archive';

      const { topology } = loadConfig();

      expect(topology.exchangeBindings![0]).toEqual({
        source: 'events',
        destination: 'archive',
        routingKey: 'trade.*',
      });
    });
  });

  // ── Business rules / defaults ─────────────────────────────────────────────────

  describe('Business rules', () => {
    it('defaults topic source to "#" when no routing key specified', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.PIPE_BINDINGS = 'topic:events > fanout:archive';

      const { topology } = loadConfig();

      expect(topology.exchangeBindings![0]).toEqual({
        source: 'events',
        destination: 'archive',
        routingKey: '#',
      });
    });

    it('keeps an explicit topic routing key unchanged', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.PIPE_BINDINGS = 'topic:events(key:trade.*) > fanout:archive';

      const { topology } = loadConfig();

      expect(topology.exchangeBindings![0].routingKey).toBe('trade.*');
    });

    it('omits routingKey for fanout source (routing key is ignored by broker)', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.PIPE_BINDINGS = 'fanout:src > fanout:dst';

      const { topology } = loadConfig();

      expect(topology.exchangeBindings![0]).not.toHaveProperty('routingKey');
    });

    it('omits routingKey for headers source (broker uses empty binding args = match-all)', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.PIPE_BINDINGS = 'headers:src > fanout:dst';

      const { topology } = loadConfig();

      expect(topology.exchangeBindings![0]).not.toHaveProperty('routingKey');
    });

    it('throws when direct source has no routing key', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.PIPE_BINDINGS = 'direct:orders > fanout:notify';

      expect(() => loadConfig()).toThrow('Routing key is required for direct exchange "orders"');
    });
  });

  // ── Env var validation ────────────────────────────────────────────────────────

  describe('Env var validation', () => {
    it('throws when RABBITMQ_URL is missing', () => {
      process.env.PIPE_BINDINGS = 'fanout:src > fanout:dst';

      expect(() => loadConfig()).toThrow('RABBITMQ_URL is required');
    });

    it('throws when PIPE_BINDINGS is missing', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';

      expect(() => loadConfig()).toThrow('PIPE_BINDINGS is required');
    });

    it('propagates parse errors from bindings string', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.PIPE_BINDINGS = 'fanout:a > fanout:b > fanout:c';

      expect(() => loadConfig()).toThrow("exactly one '>'");
    });
  });
});
