/**
 * Pipe Integration Tests
 *
 * Each describe block spins up its own isolated broker pair:
 *   - testBroker  — publishes to source exchanges and consumes from destination queues
 *   - pipeBroker  — created by pipe's connect(); declares E2E exchange bindings then stays idle
 *
 * Message retrieval uses channel.get() (pull-based) to avoid lingering consumers between tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { keepAlive, Broker } from '@devvir/rabbitmq';
import { connect } from '../src/rabbitmq';
import { loadConfig } from '../src/config';
import type { Config } from '../src/types';

const RABBIT_URL = 'amqp://guest:guest@localhost:56732';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a Config from a PIPE_BINDINGS string. */
const parseBindings = (bindings: string): Config => {
  const prev = { url: process.env.RABBITMQ_URL, b: process.env.PIPE_BINDINGS };
  process.env.RABBITMQ_URL = RABBIT_URL;
  process.env.PIPE_BINDINGS = bindings;
  try {
    return loadConfig();
  } finally {
    if (prev.url !== undefined) process.env.RABBITMQ_URL = prev.url;
    else delete process.env.RABBITMQ_URL;
    if (prev.b !== undefined) process.env.PIPE_BINDINGS = prev.b;
    else delete process.env.PIPE_BINDINGS;
  }
};

/** Assert an exclusive queue and bind it to an exchange. */
const bindTestQueue = async (broker: Broker, exchangeName: string, queueName: string, routingKey = '#'): Promise<void> => {
  const channel = broker.getChannel();
  if (! channel) throw new Error('No channel');
  await channel.assertQueue(queueName, { durable: false, exclusive: true, autoDelete: true });
  await channel.bindQueue(queueName, exchangeName, routingKey);
};

/** Publish a JSON message to an exchange. */
const publish = (
  broker: Broker,
  exchangeName: string,
  message: unknown,
  routingKey = '',
  headers?: Record<string, unknown>,
): void => {
  const channel = broker.getChannel();
  if (! channel) throw new Error('No channel');
  channel.publish(exchangeName, routingKey, Buffer.from(JSON.stringify(message), 'utf-8'), {
    contentType: 'application/json',
    contentEncoding: 'utf-8',
    ...(headers ? { headers } : {}),
  });
};

/** Poll a queue and return the first parsed message, or null on timeout. */
const getMessage = async (broker: Broker, queueName: string, timeoutMs = 3000): Promise<unknown | null> => {
  const channel = broker.getChannel();
  if (! channel) return null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await channel.get(queueName, { noAck: true });
    if (msg) {
      try { return JSON.parse(msg.content.toString('utf-8')); }
      catch { return msg.content.toString('utf-8'); }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

/** Poll a queue until `count` messages arrive, or timeout. */
const getMessages = async (broker: Broker, queueName: string, count: number, timeoutMs = 5000): Promise<unknown[]> => {
  const messages: unknown[] = [];
  const deadline = Date.now() + timeoutMs;

  while (messages.length < count && Date.now() < deadline) {
    const channel = broker.getChannel();
    if (! channel) break;

    const msg = await channel.get(queueName, { noAck: true });
    if (msg) {
      try { messages.push(JSON.parse(msg.content.toString('utf-8'))); }
      catch { messages.push(msg.content.toString('utf-8')); }
    } else {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return messages;
};

// ── Suites ───────────────────────────────────────────────────────────────────

describe('Pipe integration tests', () => {

  // ── Fanout ─────────────────────────────────────────────────────────────────

  describe('Fanout-to-fanout', () => {
    let testBroker: Broker;
    let pipeBroker: Broker;

    beforeAll(async () => {
      const config = parseBindings('fanout:int.pipe.fanout.src > fanout:int.pipe.fanout.dst');
      testBroker = await keepAlive(RABBIT_URL);
      pipeBroker = await connect(config);
      await bindTestQueue(testBroker, 'int.pipe.fanout.dst', 'int.pipe.fanout.q');
    });

    afterAll(async () => {
      await pipeBroker?.close();
      await testBroker?.close();
    });

    it('forwards messages between two fanout exchanges', async () => {
      publish(testBroker, 'int.pipe.fanout.src', { hello: 'pipe' });
      expect(await getMessage(testBroker, 'int.pipe.fanout.q')).toEqual({ hello: 'pipe' });
    });

    it('forwards multiple messages', async () => {
      publish(testBroker, 'int.pipe.fanout.src', { seq: 1 });
      publish(testBroker, 'int.pipe.fanout.src', { seq: 2 });
      publish(testBroker, 'int.pipe.fanout.src', { seq: 3 });

      const messages = await getMessages(testBroker, 'int.pipe.fanout.q', 3);
      expect(messages).toHaveLength(3);
      expect(messages).toEqual(expect.arrayContaining([{ seq: 1 }, { seq: 2 }, { seq: 3 }]));
    });
  });

  // ── Fan-out to multiple destinations ───────────────────────────────────────

  describe('Fan-out to multiple destinations', () => {
    let testBroker: Broker;
    let pipeBroker: Broker;

    beforeAll(async () => {
      const config = parseBindings(
        'fanout:int.pipe.fan.src > fanout:int.pipe.fan.dst1 | fanout:int.pipe.fan.src > fanout:int.pipe.fan.dst2',
      );
      testBroker = await keepAlive(RABBIT_URL);
      pipeBroker = await connect(config);
      await bindTestQueue(testBroker, 'int.pipe.fan.dst1', 'int.pipe.fan.q1');
      await bindTestQueue(testBroker, 'int.pipe.fan.dst2', 'int.pipe.fan.q2');
    });

    afterAll(async () => {
      await pipeBroker?.close();
      await testBroker?.close();
    });

    it('delivers the same message to all destinations', async () => {
      publish(testBroker, 'int.pipe.fan.src', { x: 1 });

      const [m1, m2] = await Promise.all([
        getMessage(testBroker, 'int.pipe.fan.q1'),
        getMessage(testBroker, 'int.pipe.fan.q2'),
      ]);
      expect(m1).toEqual({ x: 1 });
      expect(m2).toEqual({ x: 1 });
    });
  });

  // ── Chain (A → B → C) ──────────────────────────────────────────────────────

  describe('Chain (A → B → C)', () => {
    let testBroker: Broker;
    let pipeBroker: Broker;

    beforeAll(async () => {
      const config = parseBindings(
        'fanout:int.pipe.chain.a > fanout:int.pipe.chain.b | fanout:int.pipe.chain.b > fanout:int.pipe.chain.c',
      );
      testBroker = await keepAlive(RABBIT_URL);
      pipeBroker = await connect(config);
      await bindTestQueue(testBroker, 'int.pipe.chain.c', 'int.pipe.chain.q');
    });

    afterAll(async () => {
      await pipeBroker?.close();
      await testBroker?.close();
    });

    it('forwards messages through a two-hop chain', async () => {
      publish(testBroker, 'int.pipe.chain.a', { hop: 3 });
      expect(await getMessage(testBroker, 'int.pipe.chain.q')).toEqual({ hop: 3 });
    });
  });

  // ── Topic source ───────────────────────────────────────────────────────────

  describe('Topic source — default "#" binding forwards all messages', () => {
    let testBroker: Broker;
    let pipeBroker: Broker;

    beforeAll(async () => {
      // No routing key specified: pipe defaults to '#' for topic sources
      const config = parseBindings('topic:int.pipe.topic.all.src > fanout:int.pipe.topic.all.dst');
      testBroker = await keepAlive(RABBIT_URL);
      pipeBroker = await connect(config);
      await bindTestQueue(testBroker, 'int.pipe.topic.all.dst', 'int.pipe.topic.all.q');
    });

    afterAll(async () => {
      await pipeBroker?.close();
      await testBroker?.close();
    });

    it('forwards messages regardless of their routing key', async () => {
      publish(testBroker, 'int.pipe.topic.all.src', { type: 'trade' }, 'trade.XBTUSD');
      publish(testBroker, 'int.pipe.topic.all.src', { type: 'order' }, 'order.new');
      publish(testBroker, 'int.pipe.topic.all.src', { type: 'misc' }, 'something.else.entirely');

      const messages = await getMessages(testBroker, 'int.pipe.topic.all.q', 3);
      expect(messages).toHaveLength(3);
      expect(messages).toEqual(expect.arrayContaining([
        { type: 'trade' },
        { type: 'order' },
        { type: 'misc' },
      ]));
    });
  });

  describe('Topic source — explicit routing key filters messages', () => {
    let testBroker: Broker;
    let pipeBroker: Broker;

    beforeAll(async () => {
      const config = parseBindings('topic:int.pipe.topic.rk.src(key:trade.*) > fanout:int.pipe.topic.rk.dst');
      testBroker = await keepAlive(RABBIT_URL);
      pipeBroker = await connect(config);
      await bindTestQueue(testBroker, 'int.pipe.topic.rk.dst', 'int.pipe.topic.rk.q');
    });

    afterAll(async () => {
      await pipeBroker?.close();
      await testBroker?.close();
    });

    it('forwards only messages matching the binding key pattern', async () => {
      publish(testBroker, 'int.pipe.topic.rk.src', { match: true }, 'trade.btc');
      publish(testBroker, 'int.pipe.topic.rk.src', { match: false }, 'market.btc');

      expect(await getMessage(testBroker, 'int.pipe.topic.rk.q')).toEqual({ match: true });

      // Non-matching message must not arrive
      expect(await getMessage(testBroker, 'int.pipe.topic.rk.q', 500)).toBeNull();
    });
  });

  // ── Direct source ──────────────────────────────────────────────────────────

  describe('Direct source — exact routing key filter', () => {
    let testBroker: Broker;
    let pipeBroker: Broker;

    beforeAll(async () => {
      const config = parseBindings('direct:int.pipe.direct.src(key:collect) > fanout:int.pipe.direct.dst');
      testBroker = await keepAlive(RABBIT_URL);
      pipeBroker = await connect(config);
      await bindTestQueue(testBroker, 'int.pipe.direct.dst', 'int.pipe.direct.q');
    });

    afterAll(async () => {
      await pipeBroker?.close();
      await testBroker?.close();
    });

    it('forwards only messages with the exact matching routing key', async () => {
      publish(testBroker, 'int.pipe.direct.src', { match: true }, 'collect');
      publish(testBroker, 'int.pipe.direct.src', { match: false }, 'other');

      expect(await getMessage(testBroker, 'int.pipe.direct.q')).toEqual({ match: true });

      // Non-matching message must not arrive
      expect(await getMessage(testBroker, 'int.pipe.direct.q', 500)).toBeNull();
    });
  });

  // ── Headers source ─────────────────────────────────────────────────────────

  describe('Headers source — all messages forwarded via empty binding args {}', () => {
    let testBroker: Broker;
    let pipeBroker: Broker;

    beforeAll(async () => {
      // Pipe binds headers exchanges with empty args {}, which RabbitMQ treats as match-all.
      // Header-based filtering (binding arguments) is not yet supported.
      const config = parseBindings('headers:int.pipe.hdrs.src > fanout:int.pipe.hdrs.dst');
      testBroker = await keepAlive(RABBIT_URL);
      pipeBroker = await connect(config);
      await bindTestQueue(testBroker, 'int.pipe.hdrs.dst', 'int.pipe.hdrs.q');
    });

    afterAll(async () => {
      await pipeBroker?.close();
      await testBroker?.close();
    });

    it('forwards all messages regardless of their headers', async () => {
      publish(testBroker, 'int.pipe.hdrs.src', { n: 1 }, '', { 'x-type': 'trade' });
      publish(testBroker, 'int.pipe.hdrs.src', { n: 2 }, '', { 'x-type': 'order' });
      publish(testBroker, 'int.pipe.hdrs.src', { n: 3 }); // no headers at all

      const messages = await getMessages(testBroker, 'int.pipe.hdrs.q', 3);
      expect(messages).toHaveLength(3);
      expect(messages).toEqual(expect.arrayContaining([{ n: 1 }, { n: 2 }, { n: 3 }]));
    });
  });

  // ── Recovery ───────────────────────────────────────────────────────────────

  describe('Recovery — reconnects without error after channel drop', () => {
    // Regression: topology re-declaration during recovery previously used this.channel! (null),
    // causing "Cannot read properties of null (reading 'assertExchange')" and an infinite reconnect loop.
    let testBroker: Broker;
    let pipeBroker: Broker;

    beforeAll(async () => {
      const config = parseBindings('fanout:int.pipe.recovery.src > fanout:int.pipe.recovery.dst');
      testBroker = await keepAlive(RABBIT_URL);
      pipeBroker = await connect(config);
      await bindTestQueue(testBroker, 'int.pipe.recovery.dst', 'int.pipe.recovery.q');
    });

    afterAll(async () => {
      await pipeBroker?.close();
      await testBroker?.close();
    });

    it('re-declares exchange binding and continues forwarding after channel drop', async () => {
      const rawChannel = pipeBroker.getChannel();
      if (! rawChannel) throw new Error('Expected open channel before drop');
      await rawChannel.close();

      // Wait for recovery
      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(pipeBroker.getState()).toBe('connected');
      expect(pipeBroker.getChannel()).not.toBeNull();

      publish(testBroker, 'int.pipe.recovery.src', { recovered: true });
      expect(await getMessage(testBroker, 'int.pipe.recovery.q')).toEqual({ recovered: true });
    });
  });
});
