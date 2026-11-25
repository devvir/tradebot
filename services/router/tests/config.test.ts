import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../src/config';
import { formatRoute } from '../src/routes';
import { buildConsumerTopology, buildPublisherTopology } from '../src/topology';

// Parsing tests (grammar, item syntax, fan-out, whitespace, etc.) live in
// shared/utils/tests/routes.test.ts. This file only covers router-specific
// concerns: validation, type resolution, bindingKey derivation, topology construction.

const load = (rules: string, env: Record<string, string> = {}) => {
  process.env.QUEUE_URL    = 'amqp://localhost';
  process.env.ROUTER_RULES = rules;
  Object.assign(process.env, env);

  return loadConfig();
};

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

    it('rejects ROUTER_WATCH_QUEUES without ROUTER_MAX_READY', () => {
      expect(() => load('broadcast > writer', { ROUTER_WATCH_QUEUES: 'writer' }))
        .toThrow('ROUTER_MAX_READY is required when ROUTER_WATCH_QUEUES is set');
    });

    it.each([['1000', 1000], ['1e5', 100000]])('reads ROUTER_MAX_READY=%s as %i', (raw, expected) => {
      expect(load('broadcast > writer', { ROUTER_MAX_READY: raw, ROUTER_WATCH_QUEUES: 'writer' }).maxReady).toBe(expected);
    });

    it('leaves backpressure off when ROUTER_MAX_READY is unset', () => {
      expect(load('broadcast > writer').maxReady).toBe(0);
    });

    it.each(['abc', '10k', '-1', '1.5'])('rejects ROUTER_MAX_READY=%s', (raw) => {
      expect(() => load('broadcast > writer', { ROUTER_MAX_READY: raw, ROUTER_WATCH_QUEUES: 'writer' }))
        .toThrow(`ROUTER_MAX_READY must be a non-negative integer, got "${raw}"`);
    });

    it('reports every problem of a configuration in one error', () => {
      expect(() => load('a > a | b > c | b > c')).toThrow(
        /own source queue "a"[\s\S]*"b > c" is given more than once/,
      );
    });
  });

  // ── Self-loops and duplicates ───────────────────────────────────────────────

  describe('loops and duplicates', () => {
    it('rejects a bare destination queue equal to the source queue', () => {
      expect(() => load('a > a')).toThrow('delivers into its own source queue "a"');
    });

    it('rejects a destination queue on an exchange equal to the source queue', () => {
      expect(() => load('collect@topic:broadcast > collect@topic:writer'))
        .toThrow('delivers into its own source queue "collect"');
    });

    it('rejects a destination exchange equal to the source exchange', () => {
      expect(() => load('q@fanout:x > @fanout:x')).toThrow('publishes into its own source exchange "x"');
      expect(() => load('q@topic:x(key:raw.*) > @topic:x(key:raw:clean)')).toThrow('own source exchange "x"');
    });

    it('rejects a rule given twice', () => {
      expect(() => load('a > b | a > b')).toThrow('"a > b" is given more than once');
    });

    it('accepts one source fanned out to several destinations', () => {
      expect(load('a > b & c').routes).toHaveLength(2);
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

    it('rejects the default exchange on a source', () => {
      expect(() => load('q@default:ex > d')).toThrow('The default exchange cannot be bound');
    });

    it('rejects a direct source without a binding key', () => {
      expect(() => load('q@direct:ex > d')).toThrow('Direct exchange "ex" needs an explicit binding key');
    });

    it('rejects (key:) on a bare source queue', () => {
      expect(() => load('broadcast(key:trade.*) > writer')).toThrow('A bare source queue takes no (key:...)');
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

    it('maps (key:value) on a direct source to bindingKey', () => {
      expect(load('q@direct:ex(key:collect) > d').routes[0]!.source.bindingKey).toBe('collect');
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

    it('rejects (key:) on a bare destination queue', () => {
      expect(() => load('broadcast > writer(key:collect)')).toThrow('A bare destination queue');
    });

    it('rejects a queue on a direct destination without a static key', () => {
      expect(() => load('src > w@direct:out')).toThrow('A queue on a direct destination needs a static (key:...)');
      expect(() => load('src > w@direct:out(key:a:b)')).toThrow('needs a static (key:...)');
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

  // ── Exchange types ──────────────────────────────────────────────────────────

  describe('exchange types', () => {
    it('rejects two types for one exchange across sources and destinations', () => {
      expect(() => load('broadcast@topic:broadcast > @fanout:broadcast'))
        .toThrow('Exchange "broadcast" is given two types: topic and fanout');
    });

    it('rejects two types for one exchange across rules', () => {
      expect(() => load('q@topic:e > d | q2@fanout:e > d2')).toThrow('Exchange "e" is given two types');
    });

    it('gives an untyped mention the type the exchange has elsewhere', () => {
      const config = load('q@topic:e > d | q2@e > d2');

      expect(config.routes[1]!.source.exchange).toEqual({ name: 'e', type: 'topic' });
      expect(buildConsumerTopology(config.routes).exchanges?.e).toEqual({
        type: 'topic',
        queues: { q: { durable: true, routingKey: ['#'] }, q2: { durable: true, routingKey: ['#'] } },
      });
    });

    it('treats default and direct as one type', () => {
      const config = load('a > @default:out | b > @direct:out');

      expect(buildPublisherTopology(config.routes).exchanges?.out?.type).toBe('direct');
    });

    it('makes an exchange that is never typed fanout, and formats it so', () => {
      const config = load('src > @out');

      expect(config.routes[0]!.destination.exchange).toEqual({ name: 'out', type: 'fanout' });
      expect(formatRoute(config.routes[0]!)).toBe('src > @fanout:out');
    });
  });

  // ── Shared source queues ────────────────────────────────────────────────────

  describe('shared source queues', () => {
    it('rejects different keys on one queue with different destinations', () => {
      expect(() => load('q@topic:ex(key:trade.*) > d1 | q@topic:ex(key:book.*) > d2'))
        .toThrow('Source queue "q" is bound differently by rules with different destinations');
    });

    it('rejects one queue read from different exchanges', () => {
      expect(() => load('q@topic:ex(key:a) > d1 | q@topic:other(key:a) > d2'))
        .toThrow('Source queue "q" is read from different exchanges');
      expect(() => load('q > d1 | q@fanout:ex > d2')).toThrow('Source queue "q" is read from different exchanges');
    });

    it('accepts one key on one queue for several destinations, bound once', () => {
      const config = load('q@topic:ex(key:a) > d1 & d2');

      expect(buildConsumerTopology(config.routes).exchanges?.ex?.queues?.q).toEqual({ durable: true, routingKey: ['a'] });
    });

    it('accumulates the keys of several sources on one queue with the same destinations', () => {
      const config = load('q@topic:ex(key:a) & q@topic:ex(key:b) > d');

      expect(buildConsumerTopology(config.routes).exchanges?.ex?.queues?.q).toEqual({ durable: true, routingKey: ['a', 'b'] });
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
        durable: true, routingKey: ['#'],
      });
    });

    it('explicit binding key is used in consumer topology', () => {
      process.env.QUEUE_URL    = 'amqp://localhost';
      process.env.ROUTER_RULES = 'collect@topic:broadcast(key:trade.*) > writer';

      const config = loadConfig();

      expect(buildConsumerTopology(config.routes).exchanges?.broadcast?.queues?.collect).toEqual({
        durable: true, routingKey: ['trade.*'],
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
      const config = load('broadcast > @default:events');

      expect(buildPublisherTopology(config.routes).exchanges?.events?.type).toBe('direct');
    });

    it('fanout and headers sources are bound without a key of their own', () => {
      const config = load('a@fanout:f > d | b@headers:h > d');
      const topology = buildConsumerTopology(config.routes);

      expect(topology.exchanges?.f?.queues?.a).toEqual({ durable: true });
      expect(topology.exchanges?.h?.queues?.b).toEqual({ durable: true });
    });

    it('full exchange-on-both-sides topology', () => {
      const config = load('collect@topic:broadcast > writer.in@topic:writer');

      expect(buildConsumerTopology(config.routes)).toEqual({
        exchanges: {
          broadcast: { type: 'topic', queues: { collect: { durable: true, routingKey: ['#'] } } },
        },
      });
      expect(buildPublisherTopology(config.routes)).toEqual({
        exchanges: {
          writer: { type: 'topic', queues: { 'writer.in': { durable: true, routingKey: ['#'] } } },
        },
      });
    });
  });

  // ── Destination queue bindings ──────────────────────────────────────────────

  describe('destination queue bindings', () => {
    const destQueue = (rules: string, exchange: string, queue: string) =>
      buildPublisherTopology(load(rules).routes).exchanges?.[exchange]?.queues?.[queue];

    it('topic without a key binds #, so passed-through keys reach the queue', () => {
      expect(destQueue('src > w@topic:out', 'out', 'w')).toEqual({ durable: true, routingKey: ['#'] });
    });

    it('topic with a static key binds that key', () => {
      expect(destQueue('src > w@topic:out(key:collect)', 'out', 'w')).toEqual({ durable: true, routingKey: ['collect'] });
    });

    it('topic with a replaced key binds #', () => {
      expect(destQueue('src > w@topic:out(key:message:collect)', 'out', 'w')).toEqual({ durable: true, routingKey: ['#'] });
    });

    it('direct with a static key binds that key', () => {
      expect(destQueue('src > w@direct:out(key:collect)', 'out', 'w')).toEqual({ durable: true, routingKey: ['collect'] });
    });

    it('fanout and headers bind an empty key', () => {
      expect(destQueue('src > w@fanout:out', 'out', 'w')).toEqual({ durable: true, routingKey: [''] });
      expect(destQueue('src > w@headers:out', 'out', 'w')).toEqual({ durable: true, routingKey: [''] });
    });

    it('accumulates the keys of several rules into one destination queue', () => {
      expect(destQueue('a > w@topic:out(key:x) | b > w@topic:out(key:y)', 'out', 'w'))
        .toEqual({ durable: true, routingKey: ['x', 'y'] });
    });
  });
});
