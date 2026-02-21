import http from 'node:http';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startHealthCheck } from '../src/health';
import type { CodecState } from '../src/types';

vi.mock('@tradebot/logger', () => ({ default: { info: vi.fn(), error: vi.fn() } }));

function makeReq(url: string): http.IncomingMessage {
  return { url } as http.IncomingMessage;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: '',
    writeHead: vi.fn((code: number) => {
      res.statusCode = code;
    }),
    end: vi.fn((b: string) => {
      res.body = b;
    }),
  };
  return res;
}

function makeState(overrides: Partial<CodecState> = {}): CodecState {
  return {
    rabbitmqBroker: { getState: vi.fn().mockReturnValue('connected') } as any,
    isShuttingDown: false,
    messagesProcessed: 0,
    lastProcessedTime: Date.now(),
    ...overrides,
  };
}

describe('Health HTTP handler', () => {
  let handler: http.RequestListener;
  let listenMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mockServer = { listen: vi.fn() };
    listenMock = mockServer.listen;
    vi.spyOn(http, 'createServer').mockImplementationOnce((h: any) => {
      handler = h;
      return mockServer as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should start listening on port 3000', () => {
    startHealthCheck(makeState());
    expect(listenMock).toHaveBeenCalledWith(3000, expect.any(Function));
  });

  it('should return 200 when connected and messages are recent', () => {
    startHealthCheck(makeState({ lastProcessedTime: Date.now() - 5000 }));
    const res = makeRes();
    handler(makeReq('/health'), res as any);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('healthy');
  });

  it('should return 503 when broker is disconnected', () => {
    const state = makeState({
      rabbitmqBroker: { getState: vi.fn().mockReturnValue('disconnected') } as any,
    });
    startHealthCheck(state);
    const res = makeRes();
    handler(makeReq('/health'), res as any);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).status).toBe('unhealthy');
  });

  it('should return 503 when broker is null', () => {
    startHealthCheck(makeState({ rabbitmqBroker: null }));
    const res = makeRes();
    handler(makeReq('/health'), res as any);
    expect(res.statusCode).toBe(503);
  });

  it('should return 503 when messages are stale (>60s)', () => {
    startHealthCheck(makeState({ lastProcessedTime: Date.now() - 61000 }));
    const res = makeRes();
    handler(makeReq('/health'), res as any);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).status).toBe('unhealthy');
  });

  it('should include message counter in the response body', () => {
    startHealthCheck(makeState({ messagesProcessed: 42 }));
    const res = makeRes();
    handler(makeReq('/health'), res as any);
    const body = JSON.parse(res.body);
    expect(body.messagesProcessed).toBe(42);
  });

  it('should return 404 for unknown paths', () => {
    startHealthCheck(makeState());
    const res = makeRes();
    handler(makeReq('/metrics'), res as any);
    expect(res.statusCode).toBe(404);
  });

  it('should remain healthy up to 59.9s without messages', () => {
    startHealthCheck(makeState({ lastProcessedTime: Date.now() - 59900 }));
    const res = makeRes();
    handler(makeReq('/health'), res as any);
    expect(res.statusCode).toBe(200);
  });
});

