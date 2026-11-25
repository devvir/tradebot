import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exitOnBrokerLoss, answerHealthCheck } from '../src/lifecycle';

vi.mock('@devvir/service-kit', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeBroker = (state = 'connected') => Object.assign(new EventEmitter(), {
  state,
  getState() { return this.state; },
});

/** A service whose 'healthCheck' listeners receive the service first, as service-kit emits them. */
const makeService = () => {
  const service = new EventEmitter();

  const check = () => {
    const res = { statusCode: 0, body: '', writeHead: vi.fn((code: number) => { res.statusCode = code; }), end: vi.fn((b: string) => { res.body = b; }) };

    service.emit('healthCheck', service, res);

    return res;
  };

  return { service, check };
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('exitOnBrokerLoss', () => {
  let exit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });

  afterEach(() => {
    exit.mockRestore();
  });

  it.each([
    ['consumer', 'disconnect'],
    ['consumer', 'abort'],
    ['publisher', 'abort'],
  ] as const)('exits with code 1 when the %s emits %s', (which, event) => {
    const brokers = { consumer: makeBroker(), publisher: makeBroker() };

    exitOnBrokerLoss(brokers.consumer as any, brokers.publisher as any);
    brokers[which].emit(event, new Error('gone'));

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('keeps running while the publisher reconnects', () => {
    const consumer  = makeBroker();
    const publisher = makeBroker();

    exitOnBrokerLoss(consumer as any, publisher as any);
    publisher.emit('disconnect');
    publisher.emit('connect');

    expect(exit).not.toHaveBeenCalled();
  });
});

describe('answerHealthCheck', () => {
  it('answers 200 while both brokers are connected', () => {
    const { service, check } = makeService();

    answerHealthCheck(service as any, makeBroker() as any, makeBroker() as any);

    const res = check();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ healthy: true, brokers: { consumer: 'connected', publisher: 'connected' } });
  });

  it.each([
    ['disconnected', 'connected'],
    ['connected', 'reconnecting'],
    ['connected', 'disconnected'],
  ])('answers 503 when the consumer is %s and the publisher %s', (consumerState, publisherState) => {
    const { service, check } = makeService();

    answerHealthCheck(service as any, makeBroker(consumerState) as any, makeBroker(publisherState) as any);

    expect(check().statusCode).toBe(503);
  });
});
