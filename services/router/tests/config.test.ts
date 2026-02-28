import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../src/config';
import { buildTopology } from '../src/rabbitmq';

describe('Router Config Parser', () => {
  afterEach(() => {
    delete process.env.RABBITMQ_URL;
    delete process.env.ROUTER_RULES;
  });

  describe('Simple rules — bare queues (default exchange)', () => {
    it('parses single source > single destination', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > writer';

      const config = loadConfig();

      expect(config.routes).toHaveLength(1);
      expect(config.routes[0].source).toEqual({ queue: 'feed' });
      expect(config.routes[0].destination).toEqual({ queue: 'writer' });
    });

    it('declares standalone queues in topology', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > writer';

      const config = loadConfig();

      expect(buildTopology(config.routes)).toEqual({
        queues: {
          feed: { durable: true },
          writer: { durable: true },
        },
      });
    });
  });

  describe('Queue bindings to explicit exchanges', () => {
    it('parses queue with explicit exchange', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > writer@fanout:output';

      const config = loadConfig();

      expect(config.routes[0].destination).toEqual({
        queue: 'writer',
        exchange: { name: 'output', type: 'fanout' },
      });
    });

    it('parses queue binding without specifying type', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > output@archive';

      const config = loadConfig();

      expect(config.routes[0].destination).toEqual({
        queue: 'output',
        exchange: { name: 'archive' },
      });
    });

    it('parses source queue binding to explicit exchange', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'inbound@fanout:events > writer';

      const config = loadConfig();

      expect(config.routes[0].source).toEqual({
        queue: 'inbound',
        exchange: { name: 'events', type: 'fanout' },
      });
    });

    it('parses source binding with type', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'inbound@topic:events > writer';

      const config = loadConfig();

      expect(config.routes[0].source).toEqual({
        queue: 'inbound',
        exchange: { name: 'events', type: 'topic' },
      });
    });

    it('declares exchange topology with queue bindings', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'inbound@fanout:events > writer';

      const config = loadConfig();
      const topology = buildTopology(config.routes);

      expect(topology.exchanges?.events).toEqual({
        type: 'fanout',
        queues: { inbound: { durable: true } },
      });
      expect(topology.queues?.writer).toEqual({ durable: true });
    });

    it('accepts default as exchange type', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed@default:events > writer@default:output';

      const config = loadConfig();

      expect(config.routes[0].source.exchange).toEqual({ name: 'events', type: 'default' });
      expect(config.routes[0].destination.exchange).toEqual({ name: 'output', type: 'default' });
    });

    it('maps default exchange type to direct in topology', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed@default:events > writer';

      const config = loadConfig();

      expect(buildTopology(config.routes).exchanges?.events?.type).toBe('direct');
    });
  });

  describe('Multiple destinations (fan-out)', () => {
    it('normalizes to flat routes (one per source×destination)', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > writer & archive & replay';

      const config = loadConfig();

      expect(config.routes).toHaveLength(3);
      expect(config.routes[0]).toEqual({ source: { queue: 'feed' }, destination: { queue: 'writer' } });
      expect(config.routes[1]).toEqual({ source: { queue: 'feed' }, destination: { queue: 'archive' } });
      expect(config.routes[2]).toEqual({ source: { queue: 'feed' }, destination: { queue: 'replay' } });
    });

    it('parses destinations with different exchange types', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > w@fanout:writer & a@topic:audit & r@direct:replay';

      const config = loadConfig();

      expect(config.routes[0].destination.exchange?.type).toBe('fanout');
      expect(config.routes[1].destination.exchange?.type).toBe('topic');
      expect(config.routes[2].destination.exchange?.type).toBe('direct');
    });
  });

  describe('Multiple sources', () => {
    it('normalizes to flat routes', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed & reader > writer';

      const config = loadConfig();

      expect(config.routes).toHaveLength(2);
      expect(config.routes[0]).toEqual({ source: { queue: 'feed' }, destination: { queue: 'writer' } });
      expect(config.routes[1]).toEqual({ source: { queue: 'reader' }, destination: { queue: 'writer' } });
    });

    it('cross-products multiple sources and destinations', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed & reader > writer & archive';

      const config = loadConfig();

      expect(config.routes).toHaveLength(4);
      expect(config.routes.map((r) => `${r.source.queue}>${r.destination.queue}`)).toEqual([
        'feed>writer',
        'feed>archive',
        'reader>writer',
        'reader>archive',
      ]);
    });

    it('parses multiple sources with mixed bindings', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'input@fanout:events & reader > writer';

      const config = loadConfig();

      expect(config.routes[0].source).toEqual({
        queue: 'input',
        exchange: { name: 'events', type: 'fanout' },
      });
      expect(config.routes[1].source).toEqual({ queue: 'reader' });
    });
  });

  describe('Complex rules', () => {
    it('parses with all options combined', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'in@topic:events & reader > w@fanout:writer & audit@topic:audit & replay';

      const config = loadConfig();

      // 2 sources × 3 destinations = 6 routes
      expect(config.routes).toHaveLength(6);
      expect(config.routes[0].source).toEqual({ queue: 'in', exchange: { name: 'events', type: 'topic' } });
      expect(config.routes[0].destination).toEqual({ queue: 'w', exchange: { name: 'writer', type: 'fanout' } });
      expect(config.routes[2].destination).toEqual({ queue: 'replay' });
    });
  });

  describe('Multi-rule configurations', () => {
    it('parses pipe-separated rules on single line', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = '| feed > writer | reader > archive';

      const config = loadConfig();

      expect(config.routes).toHaveLength(2);
      expect(config.routes[0]).toEqual({ source: { queue: 'feed' }, destination: { queue: 'writer' } });
      expect(config.routes[1]).toEqual({ source: { queue: 'reader' }, destination: { queue: 'archive' } });
    });

    it('parses multi-line YAML literal block format', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = `
        | codec.feed@fanout:feed > writer
        | codec.reader@fanout:reader > writer
      `;

      const config = loadConfig();

      expect(config.routes).toHaveLength(2);
      expect(config.routes[0].source.queue).toBe('codec.feed');
      expect(config.routes[1].source.queue).toBe('codec.reader');
    });

    it('parses newline-separated rules (treated as single rule set)', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = `| feed > writer
| reader > archive`;

      const config = loadConfig();

      expect(config.routes).toHaveLength(2);
      expect(config.routes[0].source.queue).toBe('feed');
      expect(config.routes[1].source.queue).toBe('reader');
    });

    it('parses complex multi-rule with types and exchanges', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = `
        | in@topic:events > notify & audit@topic:audit
        | feed & reader > output@fanout:writer & replay
      `;

      const config = loadConfig();

      // Rule 1: 1 source × 2 dests = 2.  Rule 2: 2 sources × 2 dests = 4.  Total = 6.
      expect(config.routes).toHaveLength(6);
    });
  });

  describe('Real-world module examples', () => {
    it('parses Collector module', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > codec.feed & writer';

      const config = loadConfig();

      expect(config.routes).toHaveLength(2);
      expect(config.routes[0].destination).toEqual({ queue: 'codec.feed' });
      expect(config.routes[1].destination).toEqual({ queue: 'writer' });
    });

    it('parses Archivist module with explicit exchanges', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > codec.feed@fanout:feed & writer & archive@fanout:archive';

      const config = loadConfig();

      expect(config.routes).toHaveLength(3);
      expect(config.routes[0].destination.exchange?.name).toBe('feed');
      expect(config.routes[1].destination.exchange).toBeUndefined();
      expect(config.routes[2].destination.exchange?.name).toBe('archive');
    });

    it('parses complex multi-module orchestration', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = `
        | feed > codec.feed & writer & backup & audit
        | reader > codec.reader & writer & replay
      `;

      const config = loadConfig();

      // Rule 1: 4 dests.  Rule 2: 3 dests.  Total = 7.
      expect(config.routes).toHaveLength(7);
    });
  });

  describe('Exchange-only destinations', () => {
    it('parses exchange-only destination (fanout broadcast)', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'broadcast@topic:feed > @fanout:broadcast';

      const config = loadConfig();

      expect(config.routes[0].destination).toEqual({
        exchange: { name: 'broadcast', type: 'fanout' },
      });
    });

    it('declares exchange-only destination in topology (no queues bound)', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'broadcast@topic:source > @fanout:output';

      const config = loadConfig();

      expect(buildTopology(config.routes).exchanges?.output).toEqual({
        type: 'fanout',
        queues: {},
      });
    });

    it('parses exchange-only destination with routing key', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed@topic:feed > @topic:output(key:message:collect)';

      const config = loadConfig();

      expect(config.routes[0].destination).toEqual({
        exchange: { name: 'output', type: 'topic' },
        routingKey: { value: 'message', replace: 'collect' },
      });
    });

    it('parses mixed exchange-only and queue destinations', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > @fanout:broadcast & writer';

      const config = loadConfig();

      expect(config.routes).toHaveLength(2);
      expect(config.routes[0].destination).toEqual({
        exchange: { name: 'broadcast', type: 'fanout' },
      });
      expect(config.routes[1].destination).toEqual({ queue: 'writer' });
    });

    it('rejects exchange-only source (must have queue)', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = '@fanout:events > writer';

      expect(() => loadConfig()).toThrow('Source must have a queue name');
    });
  });

  describe('Malformed exchange detection', () => {
    it('rejects bare destination that looks like exchange spec (has colon, no @)', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > fanout:broadcast';

      expect(() => loadConfig()).toThrow('looks like an exchange spec but is missing "@"');
    });

    it('rejects bare source that looks like exchange spec (has colon, no @)', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'topic:feed > writer';

      expect(() => loadConfig()).toThrow('looks like an exchange spec but is missing "@"');
    });

    it('rejects invalid exchange type', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > writer@invalid:exchange';

      expect(() => loadConfig()).toThrow('Invalid exchange type');
    });
  });

  describe('Validation and error handling', () => {
    it('rejects rules without > separator', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed writer';

      expect(() => loadConfig()).toThrow("Rule missing '>'");
    });

    it('rejects rules with multiple > separators', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > writer > archive';

      expect(() => loadConfig()).toThrow('must have exactly one');
    });

    it('rejects rules with no sources', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = ' > writer';

      expect(() => loadConfig()).toThrow('No sources');
    });

    it('rejects rules with no destinations', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > ';

      expect(() => loadConfig()).toThrow('No destinations');
    });

    it('rejects missing RABBITMQ_URL env var', () => {
      delete process.env.RABBITMQ_URL;
      process.env.ROUTER_RULES = 'feed > writer';

      expect(() => loadConfig()).toThrow('RABBITMQ_URL is required');
    });

    it('rejects missing ROUTER_RULES env var', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      delete process.env.ROUTER_RULES;

      expect(() => loadConfig()).toThrow('Router rules are required');
    });
  });

  describe('Edge cases and whitespace handling', () => {
    it('handles extra whitespace around operators', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed   >   writer & archive';

      const config = loadConfig();

      expect(config.routes).toHaveLength(2);
      expect(config.routes[0].source.queue).toBe('feed');
      expect(config.routes[0].destination.queue).toBe('writer');
      expect(config.routes[1].destination.queue).toBe('archive');
    });

    it('handles leading and trailing whitespace', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = '  feed > writer  ';

      const config = loadConfig();

      expect(config.routes[0].source.queue).toBe('feed');
      expect(config.routes[0].destination.queue).toBe('writer');
    });

    it('ignores empty lines in multi-rule format', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = `
        | feed > writer

        | reader > writer
      `;

      const config = loadConfig();

      expect(config.routes).toHaveLength(2);
    });

    it('handles queue names with dots and numbers', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > queue.123 & router.456';

      const config = loadConfig();

      expect(config.routes[0].destination.queue).toBe('queue.123');
      expect(config.routes[1].destination.queue).toBe('router.456');
    });

    it('handles exchange names with dots and hyphens', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed@fanout:feed.v1 > writer@fanout:writer-2 & q@fanout:archive.main';

      const config = loadConfig();

      expect(config.routes[0].source.exchange?.name).toBe('feed.v1');
      expect(config.routes[0].destination.exchange?.name).toBe('writer-2');
      expect(config.routes[1].destination.exchange?.name).toBe('archive.main');
    });
  });

  describe('Key syntax — binding keys and routing key transforms', () => {
    describe('Source binding keys', () => {
      it('parses source with explicit binding key', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'collect@topic:feed(key:trade.*) > writer';

        const config = loadConfig();

        expect(config.routes[0].source).toEqual({
          queue: 'collect',
          exchange: { name: 'feed', type: 'topic' },
          bindingKey: 'trade.*',
        });
      });

      it('parses source with catch-all binding key', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'collect@topic:feed(key:#) > writer';

        const config = loadConfig();

        expect(config.routes[0].source.bindingKey).toBe('#');
      });

      it('source without key on topic exchange defaults bindingKey to undefined (topology defaults to #)', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'collect@topic:feed > writer';

        const config = loadConfig();

        expect(config.routes[0].source.bindingKey).toBeUndefined();
      });

      it('rejects (key:match:replace) on source', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'collect@topic:feed(key:message:collect) > writer';

        expect(() => loadConfig()).toThrow('only valid on destinations');
      });

      it('uses # as default binding key for topic exchanges in topology', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'collect@topic:feed > writer';

        const config = loadConfig();

        expect(buildTopology(config.routes).exchanges?.broadcast?.queues?.collect).toEqual({
          durable: true,
          routingKey: '#',
        });
      });

      it('uses explicit binding key in topology', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'collect@topic:feed(key:trade.*) > writer';

        const config = loadConfig();

        expect(buildTopology(config.routes).exchanges?.broadcast?.queues?.collect).toEqual({
          durable: true,
          routingKey: 'trade.*',
        });
      });
    });

    describe('Destination static routing key', () => {
      it('parses destination with static routing key', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'feed > writer@topic:writer(key:collect)';

        const config = loadConfig();

        expect(config.routes[0].destination).toEqual({
          queue: 'writer',
          exchange: { name: 'writer', type: 'topic' },
          routingKey: { value: 'collect' },
        });
      });

      it('parses destination with static routing key on bare queue', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'feed > writer(key:collect.trade)';

        const config = loadConfig();

        expect(config.routes[0].destination).toEqual({
          queue: 'writer',
          routingKey: { value: 'collect.trade' },
        });
      });
    });

    describe('Destination routing key replacement', () => {
      it('parses destination with key replacement', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'collect@topic:feed > collect@topic:writer(key:message:collect)';

        const config = loadConfig();

        expect(config.routes[0].destination).toEqual({
          queue: 'collect',
          exchange: { name: 'writer', type: 'topic' },
          routingKey: { value: 'message', replace: 'collect' },
        });
      });

      it('allows exchange-only destination with key replacement', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'collect@topic:feed > @topic:writer(key:message:collect)';

        const config = loadConfig();

        expect(config.routes[0].destination).toEqual({
          exchange: { name: 'writer', type: 'topic' },
          routingKey: { value: 'message', replace: 'collect' },
        });
      });

      it('allows empty replace string in key replacement (strips prefix)', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'feed > writer@topic:writer(key:prefix:)';

        const config = loadConfig();

        // empty replace is treated as no-replace by the parser
        expect(config.routes[0].destination.routingKey).toEqual({
          value: 'prefix',
        });
      });
    });

    describe('Key syntax with fan-out', () => {
      it('parses multiple destinations with different key configs', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'collect@topic:feed > archive@topic:writer(key:message:archive) & collect@topic:writer(key:message:collect)';

        const config = loadConfig();

        expect(config.routes).toHaveLength(2);
        expect(config.routes[0].destination.routingKey).toEqual({ value: 'message', replace: 'archive' });
        expect(config.routes[1].destination.routingKey).toEqual({ value: 'message', replace: 'collect' });
      });

      it('mixes destinations with and without key config', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'feed > writer@topic:writer(key:message:collect) & backup';

        const config = loadConfig();

        expect(config.routes[0].destination.routingKey).toEqual({ value: 'message', replace: 'collect' });
        expect(config.routes[1].destination.routingKey).toBeUndefined();
      });
    });

    describe('Key syntax validation', () => {
      it('rejects unclosed key parenthesis', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'feed > writer@topic:writer(key:collect';

        expect(() => loadConfig()).toThrow();
      });

      it('rejects empty key value', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'feed > writer@topic:writer(key:)';

        expect(() => loadConfig()).toThrow();
      });

      it('rejects empty match in key replacement', () => {
        process.env.RABBITMQ_URL = 'amqp://localhost';
        process.env.ROUTER_RULES = 'feed > writer@topic:writer(key::replace)';

        expect(() => loadConfig()).toThrow();
      });
    });
  });

  describe('Topology', () => {
    it('merges exchange declarations from sources and destinations', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'collect@topic:feed > collect@topic:writer';

      const config = loadConfig();

      expect(buildTopology(config.routes)).toEqual({
        exchanges: {
          feed: { type: 'topic', queues: { collect: { durable: true, routingKey: '#' } } },
          writer: { type: 'topic', queues: { collect: { durable: true } } },
        },
      });
    });

    it('handles mixed standalone and exchange-bound queues', () => {
      process.env.RABBITMQ_URL = 'amqp://localhost';
      process.env.ROUTER_RULES = 'feed > @fanout:broadcast & writer';

      const config = loadConfig();

      expect(buildTopology(config.routes)).toEqual({
        exchanges: {
          broadcast: { type: 'fanout', queues: {} },
        },
        queues: {
          feed: { durable: true },
          writer: { durable: true },
        },
      });
    });
  });
});
