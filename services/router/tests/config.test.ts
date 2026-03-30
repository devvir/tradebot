import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig, formatRoute } from '../src/config';
import { buildConsumerTopology, buildPublisherTopology } from '../src/topology';

// Parsing tests (grammar, item syntax, fan-out, whitespace, etc.) live in
// shared/utils/tests/routes.test.ts. This file only covers router-specific
// concerns: source validation, bindingKey derivation, topology construction.

describe('Router Config', () => {
  afterEach(() => {
    delete process.env.QUEUE_URL;
    delete process.env.ROUTER_RULES;
    delete process.env.ROUTER_MAX_READY;
    delete process.env.ROUTER_WATCH_QUEUES;
  });

  // ── Config validation ───────────────────────────────────────────────────────

  describe('config validation', () => {
    it('rejects missing QUEUE_URL', () => {
      delete process.env.QUEUE_URL;
      process.env.ROUTER_RULES = 'broadcast > writer';

      expect(() => loadConfig()).toThrow('QUEUE_URL is required');
    });

    it('rejects missing ROUTER_RULES', () => {
      process.env.QUEUE_URL = 'amqp://localhost';
      delete process.env.ROUTER_RULES;

      expect(() => loadConfig()).toThrow('Router rules are required');
    });

    it('rejects ROUTER_MAX_READY > 0 without ROUTER_WATCH_QUEUES', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'broadcast > writer';
      process.env.ROUTER_MAX_READY = '1000';

      expect(() => loadConfig()).toThrow('ROUTER_WATCH_QUEUES is required');
    });
  });

  // ── Router-specific source validation ──────────────────────────────────────

  describe('source validation', () => {
    it('rejects exchange-only source — router sources must have a queue', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = '@fanout:events > writer';

      expect(() => loadConfig()).toThrow('Source must have a queue name');
    });

    it('rejects (key:match:replace) on source — replacement is destinations-only', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'collect@topic:broadcast(key:message:collect) > writer';

      expect(() => loadConfig()).toThrow('only valid on destinations');
    });

    it('accepts type:name shorthand as exchange-only destination', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'broadcast > fanout:output';

      const config = loadConfig();

      expect(config.routes[0]!.destination).toEqual({ exchange: { name: 'output', type: 'fanout' } });
    });
  });

  // ── bindingKey derivation ───────────────────────────────────────────────────

  describe('bindingKey on source', () => {
    it('maps (key:value) on queue+exchange source to bindingKey', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'collect@topic:broadcast(key:trade.*) > writer';

      const config = loadConfig();

      expect(config.routes[0]!.source.bindingKey).toBe('trade.*');
    });

    it('no bindingKey when source has no exchange', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'broadcast(key:trade.*) > writer';

      const config = loadConfig();

      expect(config.routes[0]!.source.bindingKey).toBeUndefined();
    });

    it('no bindingKey when source has exchange but no key', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'collect@topic:broadcast > writer';

      const config = loadConfig();

      expect(config.routes[0]!.source.bindingKey).toBeUndefined();
    });
  });

  // ── Destination routingKey / headers ───────────────────────────────────────

  describe('destination modifiers', () => {
    it('maps (key:value) on destination to routingKey.value', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'broadcast > writer@topic:out(key:collect)';

      const config = loadConfig();

      expect(config.routes[0]!.destination.routingKey).toEqual({ value: 'collect' });
    });

    it('maps (key:value:replace) to routingKey with replace field', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'broadcast > @topic:out(key:message:collect)';

      const config = loadConfig();

      expect(config.routes[0]!.destination.routingKey).toEqual({ value: 'message', replace: 'collect' });
    });

    it('maps header modifier to headers map', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'broadcast > writer(header:x-db=tradebot)';

      const config = loadConfig();

      expect(config.routes[0]!.destination.headers).toEqual({ 'x-db': 'tradebot' });
    });

    it('formatRoute serialises key + header', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'broadcast > @topic:out(key:message:collect,header:x-db=tradebot)';

      const config   = loadConfig();
      const formatted = formatRoute(config.routes[0]!);

      expect(formatted).toContain('key:message:collect');
      expect(formatted).toContain('header:x-db=tradebot');
    });
  });

  // ── Consumer / Publisher topology ───────────────────────────────────────────

  describe('topology construction', () => {
    it('bare queue — consumer queue, publisher queue', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'broadcast > writer';

      const config = loadConfig();

      expect(buildConsumerTopology(config.routes)).toEqual({
        queues: { broadcast: { durable: true } },
      });
      expect(buildPublisherTopology(config.routes)).toEqual({
        queues: { writer: { durable: true } },
      });
    });

    it('queue bound to exchange — consumer exchange+queue, publisher queue', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'inbound@fanout:events > writer';

      const config = loadConfig();

      expect(buildConsumerTopology(config.routes).exchanges?.events).toEqual({
        type: 'fanout',
        queues: { inbound: { durable: true } },
      });
      expect(buildPublisherTopology(config.routes).queues?.writer).toEqual({ durable: true });
    });

    it('topic source without binding key defaults to # in topology', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'collect@topic:broadcast > writer';

      const config = loadConfig();

      expect(buildConsumerTopology(config.routes).exchanges?.broadcast?.queues?.collect).toEqual({
        durable: true, routingKey: '#',
      });
    });

    it('explicit binding key is used in consumer topology', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'collect@topic:broadcast(key:trade.*) > writer';

      const config = loadConfig();

      expect(buildConsumerTopology(config.routes).exchanges?.broadcast?.queues?.collect).toEqual({
        durable: true, routingKey: 'trade.*',
      });
    });

    it('exchange-only destination in publisher topology — exchange with no queues', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'broadcast@topic:src > @fanout:output';

      const config = loadConfig();

      expect(buildPublisherTopology(config.routes).exchanges?.output).toEqual({
        type: 'fanout', queues: {},
      });
    });

    it('default exchange type maps to direct in topology', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'broadcast@default:events > writer';

      const config = loadConfig();

      expect(buildConsumerTopology(config.routes).exchanges?.events?.type).toBe('direct');
    });

    it('full exchange-on-both-sides topology', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'collect@topic:broadcast > collect@topic:writer';

      const config = loadConfig();

      expect(buildConsumerTopology(config.routes)).toEqual({
        exchanges: {
          broadcast: { type: 'topic', queues: { collect: { durable: true, routingKey: '#' } } },
        },
      });
      expect(buildPublisherTopology(config.routes)).toEqual({
        exchanges: {
          writer: { type: 'topic', queues: { collect: { durable: true } } },
        },
      });
    });
  });
});
