/**
 * Router Integration Tests
 *
 * These tests spin up a real RabbitMQ instance and verify that the router
 * correctly declares topology and routes messages end-to-end.
 *
 * The test broker is separate from the router broker — it simulates external
 * services publishing to source queues and consuming from destination queues.
 *
 * Message retrieval uses channel.get() (pull-based) instead of queue.consume()
 * (push-based) to avoid lingering consumers between tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RabbitMQ } from '@devvir/service-kit';
import { buildConsumerTopology, buildPublisherTopology } from '../src/topology';
import { consumeAndRepublish } from '../src/consumer';
import { loadConfig } from '../src/config';
import type { Config, Route } from '../src/types';

/** Convenience wrapper for starting the router with separate consumer and publisher brokers. */
const startConsuming = async (consumer: RabbitMQ.Broker, publisher: RabbitMQ.Broker, routes: Route[]): Promise<void> => {
  const config: Config = { rabbitmqUrl: '', routes, maxReady: 0, watchQueues: [] };
  await consumeAndRepublish(consumer, publisher, config, null);
};

const RABBIT_URL = 'amqp://guest:guest@localhost:56731';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a full Config from a ROUTER_RULES string (via loadConfig). */
const parseRules = (rules: string): Config => {
  const prev = { url: process.env.QUEUE_URL, rules: process.env.ROUTER_RULES };
  process.env.QUEUE_URL = RABBIT_URL;
  process.env.ROUTER_RULES = rules;
  try {
    return loadConfig();
  } finally {
    if (prev.url !== undefined) process.env.QUEUE_URL = prev.url;
    else delete process.env.QUEUE_URL;
    if (prev.rules !== undefined) process.env.ROUTER_RULES = prev.rules;
    else delete process.env.ROUTER_RULES;
  }
};

/** Create consumer and publisher brokers with their respective topologies declared. */
const connectRouterBrokers = async (config: Config): Promise<{ consumerBroker: RabbitMQ.Broker; publisherBroker: RabbitMQ.Broker }> => {
  const consumerBroker = await RabbitMQ.keepAlive(RABBIT_URL);
  await consumerBroker.declares(buildConsumerTopology(config.routes) as RabbitMQ.TopologySpec);

  const publisherBroker = await RabbitMQ.keepAlive(RABBIT_URL);
  await publisherBroker.declares(buildPublisherTopology(config.routes) as RabbitMQ.TopologySpec);

  return { consumerBroker, publisherBroker };
};

/**
 * Publish a JSON message to a queue via the default exchange.
 */
const publishToQueue = (broker: RabbitMQ.Broker, queueName: string, message: unknown, headers?: Record<string, any>): void => {
  const channel = broker.getChannel();
  if (! channel) throw new Error('No channel');
  const buffer = Buffer.from(JSON.stringify(message), 'utf-8');
  channel.publish('', queueName, buffer, {
    persistent: true,
    contentType: 'application/json',
    contentEncoding: 'utf-8',
    headers,
  });
};

/**
 * Publish a JSON message to an exchange with a routing key.
 */
const publishToExchange = (
  broker: RabbitMQ.Broker,
  exchangeName: string,
  message: unknown,
  routingKey = '',
  headers?: Record<string, any>,
): void => {
  const channel = broker.getChannel();
  if (! channel) throw new Error('No channel');
  const buffer = Buffer.from(JSON.stringify(message), 'utf-8');
  channel.publish(exchangeName, routingKey, buffer, {
    persistent: true,
    contentType: 'application/json',
    contentEncoding: 'utf-8',
    headers,
  });
};

/**
 * Pull a single message from a queue using channel.get() (pull-based).
 * Retries with polling to allow time for routing.
 */
const getMessage = async (
  broker: RabbitMQ.Broker,
  queueName: string,
  timeoutMs = 3000,
): Promise<unknown | null> => {
  const channel = broker.getChannel();
  if (! channel) return null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await channel.get(queueName, { noAck: false });
    if (msg) {
      channel.ack(msg);
      try {
        return JSON.parse(msg.content.toString('utf-8'));
      } catch {
        return msg.content.toString('utf-8');
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

/**
 * Pull a raw message (with headers/properties) from a queue.
 */
const getRawMessage = async (
  broker: RabbitMQ.Broker,
  queueName: string,
  timeoutMs = 3000,
): Promise<{ content: unknown; headers: Record<string, any>; routingKey: string } | null> => {
  const channel = broker.getChannel();
  if (! channel) return null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await channel.get(queueName, { noAck: false });
    if (msg) {
      channel.ack(msg);
      let content: unknown;
      try {
        content = JSON.parse(msg.content.toString('utf-8'));
      } catch {
        content = msg.content.toString('utf-8');
      }
      return {
        content,
        headers: msg.properties.headers || {},
        routingKey: msg.fields.routingKey,
      };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

/**
 * Pull N messages from a queue. Returns what's available within the timeout.
 */
const getMessages = async (
  broker: RabbitMQ.Broker,
  queueName: string,
  count: number,
  timeoutMs = 5000,
): Promise<unknown[]> => {
  const messages: unknown[] = [];
  const deadline = Date.now() + timeoutMs;

  while (messages.length < count && Date.now() < deadline) {
    const channel = broker.getChannel();
    if (! channel) break;

    const msg = await channel.get(queueName, { noAck: false });
    if (msg) {
      channel.ack(msg);
      try {
        messages.push(JSON.parse(msg.content.toString('utf-8')));
      } catch {
        messages.push(msg.content.toString('utf-8'));
      }
    } else {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return messages;
};

/**
 * Check if a queue exists using a throwaway broker (so channel errors don't
 * affect the main broker).
 */
const queueExists = async (queueName: string): Promise<boolean> => {
  let probe: RabbitMQ.Broker | null = null;
  try {
    probe = await RabbitMQ.keepAlive(RABBIT_URL, { retries: 5 });
    const channel = probe.getChannel()!;
    await channel.checkQueue(queueName);
    return true;
  } catch {
    return false;
  } finally {
    if (probe) await probe.close().catch(() => {});
  }
};

// ────────────────────────────────────────────────────────────────────────────────
// Test Suites
// ────────────────────────────────────────────────────────────────────────────────

describe('Router Integration', () => {

  // ── Bare queue routing (default exchange) ──────────────────────────────────

  describe('Bare queue routing (default exchange)', () => {
    let consumerBroker: RabbitMQ.Broker;
    let publisherBroker: RabbitMQ.Broker;
    let testBroker: RabbitMQ.Broker;
    let routes: Route[];

    beforeAll(async () => {
      const config = parseRules('int.bare.src > int.bare.dst');
      routes = config.routes;

      ({ consumerBroker, publisherBroker } = await connectRouterBrokers(config));

      // Declare destination queue from test side (simulates downstream service)
      testBroker = await RabbitMQ.keepAlive(RABBIT_URL, { retries: 5 });
      await testBroker.declares({
        queues: { 'int.bare.dst': { durable: true } },
      });

      await startConsuming(consumerBroker, publisherBroker, routes);
    });

    afterAll(async () => {
      await consumerBroker?.close().catch(() => {});
      await publisherBroker?.close().catch(() => {});
      await testBroker?.close().catch(() => {});
    });

    it('routes a message from source to destination via default exchange', async () => {
      const payload = { test: 'bare-queue', ts: Date.now() };
      publishToQueue(testBroker, 'int.bare.src', payload);

      const received = await getMessage(testBroker, 'int.bare.dst');
      expect(received).toEqual(payload);
    });

    it('routes multiple sequential messages', async () => {
      const messages = [
        { seq: 1, data: 'first' },
        { seq: 2, data: 'second' },
        { seq: 3, data: 'third' },
      ];

      for (const msg of messages) {
        publishToQueue(testBroker, 'int.bare.src', msg);
      }

      const received = await getMessages(testBroker, 'int.bare.dst', 3);
      expect(received).toHaveLength(3);
      expect(received).toEqual(expect.arrayContaining(messages));
    });
  });

  // ── Fan-out routing ────────────────────────────────────────────────────────

  describe('Fan-out routing (one source, multiple destinations)', () => {
    let consumerBroker: RabbitMQ.Broker;
    let publisherBroker: RabbitMQ.Broker;
    let testBroker: RabbitMQ.Broker;
    let routes: Route[];

    beforeAll(async () => {
      const config = parseRules('int.fan.src > int.fan.dst1 & int.fan.dst2 & int.fan.dst3');
      routes = config.routes;

      ({ consumerBroker, publisherBroker } = await connectRouterBrokers(config));

      testBroker = await RabbitMQ.keepAlive(RABBIT_URL, { retries: 5 });
      await testBroker.declares({
        queues: {
          'int.fan.dst1': { durable: true },
          'int.fan.dst2': { durable: true },
          'int.fan.dst3': { durable: true },
        },
      });

      await startConsuming(consumerBroker, publisherBroker, routes);
    });

    afterAll(async () => {
      await consumerBroker?.close().catch(() => {});
      await publisherBroker?.close().catch(() => {});
      await testBroker?.close().catch(() => {});
    });

    it('delivers the same message to ALL destinations (not round-robin)', async () => {
      const payload = { test: 'fan-out', value: 42 };
      publishToQueue(testBroker, 'int.fan.src', payload);

      const [r1, r2, r3] = await Promise.all([
        getMessage(testBroker, 'int.fan.dst1'),
        getMessage(testBroker, 'int.fan.dst2'),
        getMessage(testBroker, 'int.fan.dst3'),
      ]);

      expect(r1).toEqual(payload);
      expect(r2).toEqual(payload);
      expect(r3).toEqual(payload);
    });

    it('fans out multiple messages correctly', async () => {
      const msg1 = { seq: 1 };
      const msg2 = { seq: 2 };

      publishToQueue(testBroker, 'int.fan.src', msg1);
      publishToQueue(testBroker, 'int.fan.src', msg2);

      const [dst1, dst2, dst3] = await Promise.all([
        getMessages(testBroker, 'int.fan.dst1', 2),
        getMessages(testBroker, 'int.fan.dst2', 2),
        getMessages(testBroker, 'int.fan.dst3', 2),
      ]);

      expect(dst1).toHaveLength(2);
      expect(dst2).toHaveLength(2);
      expect(dst3).toHaveLength(2);

      for (const dst of [dst1, dst2, dst3]) {
        expect(dst).toEqual(expect.arrayContaining([msg1, msg2]));
      }
    });
  });

  // ── Explicit exchange binding ──────────────────────────────────────────────

  describe('Explicit exchange binding', () => {
    let consumerBroker: RabbitMQ.Broker;
    let publisherBroker: RabbitMQ.Broker;
    let testBroker: RabbitMQ.Broker;
    let routes: Route[];

    beforeAll(async () => {
      const config = parseRules('int.exch.src@fanout:int.exch.input > int.exch.dst@fanout:int.exch.output');
      routes = config.routes;

      ({ consumerBroker, publisherBroker } = await connectRouterBrokers(config));

      // Bind a test consumer queue to the output exchange
      testBroker = await RabbitMQ.keepAlive(RABBIT_URL, { retries: 5 });
      await testBroker.declares({
        exchanges: {
          'int.exch.output': {
            type: 'fanout',
            queues: { 'int.exch.test-consumer': { durable: true } },
          },
        },
      });

      await startConsuming(consumerBroker, publisherBroker, routes);
    });

    afterAll(async () => {
      await consumerBroker?.close().catch(() => {});
      await publisherBroker?.close().catch(() => {});
      await testBroker?.close().catch(() => {});
    });

    it('binds source queue to source exchange during topology', async () => {
      const exists = await queueExists('int.exch.src');
      expect(exists).toBe(true);
    });

    it('declares and binds destination queue to destination exchange', async () => {
      const exists = await queueExists('int.exch.dst');
      expect(exists).toBe(true);
    });

    it('routes messages published to source exchange through to destination exchange', async () => {
      const payload = { test: 'exchange-routing', exchange: true };

      // Publish to the source exchange (consumer broker declared it)
      publishToExchange(consumerBroker, 'int.exch.input', payload);

      // Test consumer queue (bound to output exchange) should receive it
      const received = await getMessage(testBroker, 'int.exch.test-consumer');
      expect(received).toEqual(payload);
    });
  });

  // ── Mixed destinations (default + explicit exchange) ───────────────────────

  describe('Mixed destinations (default + explicit exchange)', () => {
    let consumerBroker: RabbitMQ.Broker;
    let publisherBroker: RabbitMQ.Broker;
    let testBroker: RabbitMQ.Broker;
    let routes: Route[];

    beforeAll(async () => {
      const config = parseRules('int.mixed.src > int.mixed.bare & int.mixed.bound@fanout:int.mixed.ex');
      routes = config.routes;

      ({ consumerBroker, publisherBroker } = await connectRouterBrokers(config));

      testBroker = await RabbitMQ.keepAlive(RABBIT_URL, { retries: 5 });
      await testBroker.declares({
        queues: {
          'int.mixed.bare': { durable: true },
        },
        exchanges: {
          'int.mixed.ex': {
            type: 'fanout',
            queues: { 'int.mixed.consumer': { durable: true } },
          },
        },
      });

      await startConsuming(consumerBroker, publisherBroker, routes);
    });

    afterAll(async () => {
      await consumerBroker?.close().catch(() => {});
      await publisherBroker?.close().catch(() => {});
      await testBroker?.close().catch(() => {});
    });

    it('routes to both default-exchange and explicit-exchange destinations', async () => {
      const payload = { test: 'mixed', mode: 'both' };
      publishToQueue(testBroker, 'int.mixed.src', payload);

      // Bare destination (default exchange)
      const bareMsg = await getMessage(testBroker, 'int.mixed.bare');
      expect(bareMsg).toEqual(payload);

      // Exchange-bound consumer (fanout)
      const boundMsg = await getMessage(testBroker, 'int.mixed.consumer');
      expect(boundMsg).toEqual(payload);
    });
  });

  // ── Multiple sources ───────────────────────────────────────────────────────

  describe('Multiple sources', () => {
    let consumerBroker: RabbitMQ.Broker;
    let publisherBroker: RabbitMQ.Broker;
    let testBroker: RabbitMQ.Broker;
    let routes: Route[];

    beforeAll(async () => {
      const config = parseRules('int.multi.src1 & int.multi.src2 > int.multi.dst');
      routes = config.routes;

      ({ consumerBroker, publisherBroker } = await connectRouterBrokers(config));

      testBroker = await RabbitMQ.keepAlive(RABBIT_URL, { retries: 5 });
      await testBroker.declares({
        queues: { 'int.multi.dst': { durable: true } },
      });

      await startConsuming(consumerBroker, publisherBroker, routes);
    });

    afterAll(async () => {
      await consumerBroker?.close().catch(() => {});
      await publisherBroker?.close().catch(() => {});
      await testBroker?.close().catch(() => {});
    });

    it('routes messages from different source queues to the same destination', async () => {
      const msg1 = { from: 'src1', data: 'hello' };
      const msg2 = { from: 'src2', data: 'world' };

      publishToQueue(testBroker, 'int.multi.src1', msg1);
      publishToQueue(testBroker, 'int.multi.src2', msg2);

      const received = await getMessages(testBroker, 'int.multi.dst', 2);
      expect(received).toHaveLength(2);
      expect(received).toEqual(expect.arrayContaining([msg1, msg2]));
    });
  });

  // ── Multi-rule configuration ───────────────────────────────────────────────

  describe('Multi-rule configuration', () => {
    let consumerBroker: RabbitMQ.Broker;
    let publisherBroker: RabbitMQ.Broker;
    let testBroker: RabbitMQ.Broker;
    let routes: Route[];

    beforeAll(async () => {
      const config = parseRules(`
        | int.rule1.src > int.rule1.dst1 & int.rule1.dst2
        | int.rule2.src > int.rule2.dst
      `);
      routes = config.routes;

      ({ consumerBroker, publisherBroker } = await connectRouterBrokers(config));

      testBroker = await RabbitMQ.keepAlive(RABBIT_URL, { retries: 5 });
      await testBroker.declares({
        queues: {
          'int.rule1.dst1': { durable: true },
          'int.rule1.dst2': { durable: true },
          'int.rule2.dst': { durable: true },
        },
      });

      await startConsuming(consumerBroker, publisherBroker, routes);
    });

    afterAll(async () => {
      await consumerBroker?.close().catch(() => {});
      await publisherBroker?.close().catch(() => {});
      await testBroker?.close().catch(() => {});
    });

    it('routes messages independently per rule', async () => {
      const msg1 = { rule: 1, data: 'rule-one' };
      const msg2 = { rule: 2, data: 'rule-two' };

      publishToQueue(testBroker, 'int.rule1.src', msg1);
      publishToQueue(testBroker, 'int.rule2.src', msg2);

      // Rule 1: fan-out to two destinations
      const [r1d1, r1d2] = await Promise.all([
        getMessage(testBroker, 'int.rule1.dst1'),
        getMessage(testBroker, 'int.rule1.dst2'),
      ]);
      expect(r1d1).toEqual(msg1);
      expect(r1d2).toEqual(msg1);

      // Rule 2: single destination
      const r2d = await getMessage(testBroker, 'int.rule2.dst');
      expect(r2d).toEqual(msg2);
    });

    it('does not cross-route between rules', async () => {
      const msg = { rule: 1, cross: 'test' };
      publishToQueue(testBroker, 'int.rule1.src', msg);

      // Wait for routing to complete
      await new Promise((r) => setTimeout(r, 500));

      // Rule 2 destination should NOT receive rule 1 messages
      const channel = testBroker.getChannel()!;
      const cross = await channel.get('int.rule2.dst', { noAck: false });

      if (cross) {
        channel.ack(cross);
      }
      expect(cross).toBe(false);
    });
  });

  // ── Routing key transforms ────────────────────────────────────────────────

  describe('Routing key transforms', () => {
    let consumerBroker: RabbitMQ.Broker;
    let publisherBroker: RabbitMQ.Broker;
    let testBroker: RabbitMQ.Broker;
    let routes: Route[];

    beforeAll(async () => {
      // Simulates collector pattern: consume from topic exchange, replace routing key prefix
      const config = parseRules('int.rk.src@topic:int.rk.input > int.rk.dst@topic:int.rk.output(key:message:collect)');
      routes = config.routes;

      ({ consumerBroker, publisherBroker } = await connectRouterBrokers(config));

      // Bind a test consumer queue to the output exchange with catch-all
      testBroker = await RabbitMQ.keepAlive(RABBIT_URL, { retries: 5 });
      await testBroker.declares({
        exchanges: {
          'int.rk.output': {
            type: 'topic',
            queues: { 'int.rk.consumer': { durable: true, routingKey: '#' } },
          },
        },
      });

      await startConsuming(consumerBroker, publisherBroker, routes);
    });

    afterAll(async () => {
      await consumerBroker?.close().catch(() => {});
      await publisherBroker?.close().catch(() => {});
      await testBroker?.close().catch(() => {});
    });

    it('replaces routing key prefix (message.trade → collect.trade)', async () => {
      const payload = { table: 'trade', data: [1, 2, 3] };
      publishToExchange(consumerBroker, 'int.rk.input', payload, 'message.trade');

      const received = await getRawMessage(testBroker, 'int.rk.consumer');
      expect(received).not.toBeNull();
      expect(received!.content).toEqual(payload);
      expect(received!.routingKey).toBe('collect.trade');
    });

    it('replaces routing key in multi-segment keys', async () => {
      const payload = { table: 'orderBookL2', data: [] };
      publishToExchange(consumerBroker, 'int.rk.input', payload, 'message.orderBookL2');

      const received = await getRawMessage(testBroker, 'int.rk.consumer');
      expect(received).not.toBeNull();
      expect(received!.routingKey).toBe('collect.orderBookL2');
    });
  });

  // ── Exchange-only destination (broadcast pattern) ─────────────────────────

  describe('Exchange-only destination (broadcast pattern)', () => {
    let consumerBroker: RabbitMQ.Broker;
    let publisherBroker: RabbitMQ.Broker;
    let testBroker: RabbitMQ.Broker;
    let routes: Route[];

    beforeAll(async () => {
      const config = parseRules('int.bcast.src@topic:int.bcast.input > @fanout:int.bcast.output');
      routes = config.routes;

      ({ consumerBroker, publisherBroker } = await connectRouterBrokers(config));

      // Subscribers bind their own queues to the fanout exchange
      testBroker = await RabbitMQ.keepAlive(RABBIT_URL, { retries: 5 });
      await testBroker.declares({
        exchanges: {
          'int.bcast.output': {
            type: 'fanout',
            queues: {
              'int.bcast.sub1': { durable: true },
              'int.bcast.sub2': { durable: true },
            },
          },
        },
      });

      await startConsuming(consumerBroker, publisherBroker, routes);
    });

    afterAll(async () => {
      await consumerBroker?.close().catch(() => {});
      await publisherBroker?.close().catch(() => {});
      await testBroker?.close().catch(() => {});
    });

    it('broadcasts to all subscriber queues via fanout exchange', async () => {
      const payload = { broadcast: true, data: 'hello subscribers' };
      publishToExchange(consumerBroker, 'int.bcast.input', payload, 'message.trade');

      const [sub1, sub2] = await Promise.all([
        getMessage(testBroker, 'int.bcast.sub1'),
        getMessage(testBroker, 'int.bcast.sub2'),
      ]);

      expect(sub1).toEqual(payload);
      expect(sub2).toEqual(payload);
    });
  });

  // ── Real-world scenario: Collector module ──────────────────────────────────

  describe('Real-world: Collector module pattern', () => {
    let consumerBroker: RabbitMQ.Broker;
    let publisherBroker: RabbitMQ.Broker;
    let testBroker: RabbitMQ.Broker;
    let routes: Route[];

    beforeAll(async () => {
      const config = parseRules('int.coll.broadcast > int.coll.codec & int.coll.writer');
      routes = config.routes;

      ({ consumerBroker, publisherBroker } = await connectRouterBrokers(config));

      testBroker = await RabbitMQ.keepAlive(RABBIT_URL, { retries: 5 });
      await testBroker.declares({
        queues: {
          'int.coll.codec': { durable: true },
          'int.coll.writer': { durable: true },
        },
      });

      await startConsuming(consumerBroker, publisherBroker, routes);
    });

    afterAll(async () => {
      await consumerBroker?.close().catch(() => {});
      await publisherBroker?.close().catch(() => {});
      await testBroker?.close().catch(() => {});
    });

    it('routes broadcast data to both codec and writer', async () => {
      const tradeData = {
        table: 'trade',
        action: 'insert',
        data: [{ symbol: 'XBTUSD', price: 50000, size: 100 }],
      };

      publishToQueue(testBroker, 'int.coll.broadcast', tradeData);

      const [codecMsg, writerMsg] = await Promise.all([
        getMessage(testBroker, 'int.coll.codec'),
        getMessage(testBroker, 'int.coll.writer'),
      ]);

      expect(codecMsg).toEqual(tradeData);
      expect(writerMsg).toEqual(tradeData);
    });
  });

  // ── Header injection ──────────────────────────────────────────────────────

  describe('Header injection', () => {
    let consumerBroker: RabbitMQ.Broker;
    let publisherBroker: RabbitMQ.Broker;
    let testBroker: RabbitMQ.Broker;
    let routes: Route[];

    beforeAll(async () => {
      const config = parseRules('int.hdr.src > int.hdr.dst(header:x-test=hello)');
      routes = config.routes;

      ({ consumerBroker, publisherBroker } = await connectRouterBrokers(config));

      testBroker = await RabbitMQ.keepAlive(RABBIT_URL, { retries: 5 });
      await testBroker.declares({
        queues: { 'int.hdr.dst': { durable: true } },
      });

      await startConsuming(consumerBroker, publisherBroker, routes);
    });

    afterAll(async () => {
      await consumerBroker?.close().catch(() => {});
      await publisherBroker?.close().catch(() => {});
      await testBroker?.close().catch(() => {});
    });

    it('injects static header into republished message', async () => {
      publishToQueue(testBroker, 'int.hdr.src', { data: 'test' });

      const received = await getRawMessage(testBroker, 'int.hdr.dst');
      expect(received).not.toBeNull();
      expect(received!.headers['x-test']).toBe('hello');
    });

    it('merges injected headers with existing message headers', async () => {
      publishToQueue(testBroker, 'int.hdr.src', { data: 'merge' }, { 'x-existing': 'keep' });

      const received = await getRawMessage(testBroker, 'int.hdr.dst');
      expect(received).not.toBeNull();
      expect(received!.headers['x-test']).toBe('hello');
      expect(received!.headers['x-existing']).toBe('keep');
    });
  });

  // ── Message integrity ─────────────────────────────────────────────────────

  describe('Message integrity', () => {
    let consumerBroker: RabbitMQ.Broker;
    let publisherBroker: RabbitMQ.Broker;
    let testBroker: RabbitMQ.Broker;
    let routes: Route[];

    beforeAll(async () => {
      const config = parseRules('int.integrity.src > int.integrity.dst');
      routes = config.routes;

      ({ consumerBroker, publisherBroker } = await connectRouterBrokers(config));

      testBroker = await RabbitMQ.keepAlive(RABBIT_URL, { retries: 5 });
      await testBroker.declares({
        queues: { 'int.integrity.dst': { durable: true } },
      });

      await startConsuming(consumerBroker, publisherBroker, routes);
    });

    afterAll(async () => {
      await consumerBroker?.close().catch(() => {});
      await publisherBroker?.close().catch(() => {});
      await testBroker?.close().catch(() => {});
    });

    it('preserves complex nested JSON structures', async () => {
      const complex = {
        string: 'hello',
        number: 42,
        float: 3.14159,
        boolean: true,
        null: null,
        array: [1, 'two', { three: 3 }],
        nested: {
          deep: { deeper: { deepest: 'value' } },
        },
      };

      publishToQueue(testBroker, 'int.integrity.src', complex);

      const received = await getMessage(testBroker, 'int.integrity.dst');
      expect(received).toEqual(complex);
    });

    it('preserves message headers through routing', async () => {
      const payload = { test: 'headers' };
      const headers = { 'x-custom': 'test-value', 'x-timestamp': 1234567890 };

      publishToQueue(testBroker, 'int.integrity.src', payload, headers);

      const received = await getRawMessage(testBroker, 'int.integrity.dst');
      expect(received).not.toBeNull();
      expect(received!.content).toEqual(payload);
      expect(received!.headers['x-custom']).toBe('test-value');
      expect(received!.headers['x-timestamp']).toBe(1234567890);
    });

    it('handles large messages (~100KB)', async () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({
        index: i,
        data: 'x'.repeat(100),
        timestamp: Date.now(),
      }));

      const payload = { type: 'bulk', records: largeArray };

      publishToQueue(testBroker, 'int.integrity.src', payload);

      const received = await getMessage(testBroker, 'int.integrity.dst', 10000);
      expect(received).toEqual(payload);
    });
  });
});
