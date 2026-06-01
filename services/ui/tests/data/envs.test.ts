import { describe, it, expect } from 'vitest';
import { ENV_CONFIGS } from '../../src/data/envs';

describe('ENV_CONFIGS.live', () => {
  it('points REST at /api/v1 and WS at BitMEX live', () => {
    expect(ENV_CONFIGS.live.restPath).toBe('/api/v1');
    expect(ENV_CONFIGS.live.wsUrl).toBe('wss://ws.bitmex.com/realtime');
  });

  it('sends no extra headers (proxy default = live)', () => {
    expect(ENV_CONFIGS.live.headers).toEqual({});
  });
});

describe('ENV_CONFIGS.testnet', () => {
  it('points REST at /api/v1 and WS at BitMEX testnet', () => {
    expect(ENV_CONFIGS.testnet.restPath).toBe('/api/v1');
    expect(ENV_CONFIGS.testnet.wsUrl).toBe('wss://ws.testnet.bitmex.com/realtime');
  });

  it('sends x-testnet: true so the proxy targets testnet', () => {
    expect(ENV_CONFIGS.testnet.headers).toEqual({ 'x-testnet': 'true' });
  });
});

describe('ENV_CONFIGS.replay', () => {
  it('points REST at /replay and sends no extra headers', () => {
    expect(ENV_CONFIGS.replay.restPath).toBe('/replay');
    expect(ENV_CONFIGS.replay.headers).toEqual({});
  });

  it('generates a same-origin replay WS URL from window.location', () => {
    /** jsdom defaults to `http://localhost:3000` → expect `ws://...` scheme. */
    expect(ENV_CONFIGS.replay.wsUrl).toMatch(/^ws:\/\/[^/]+\/replay-ws\/realtime$/);
  });
});
