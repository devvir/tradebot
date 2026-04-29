/**
 * Config loader tests.
 *
 * config.ts runs loadConfig() at import time as the default export. We hoist
 * a baseline env so the module imports cleanly, then exercise loadConfig()
 * and validate() directly with mutated env to verify each required field
 * triggers the expected error.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.TRADER_WS_URL     = 'ws://ws';
  process.env.TRADER_REST_URL   = 'http://rest';
  process.env.TRADER_API_KEY    = 'KEY';
  process.env.TRADER_API_SECRET = 'SECRET';
});

import { _test_loadConfig as loadConfig, _test_validate as validate } from '../src/config';

const REQUIRED_VARS = [
  'TRADER_WS_URL',
  'TRADER_REST_URL',
  'TRADER_API_KEY',
  'TRADER_API_SECRET',
] as const;

const FULL_ENV = {
  TRADER_WS_URL:           'ws://ws',
  TRADER_REST_URL:         'http://rest',
  TRADER_API_KEY:          'KEY',
  TRADER_API_SECRET:       'SECRET',
  TRADER_STRATEGY:         'range',
  TRADER_SYMBOL:           'XBTUSD',
  TRADER_TICK_INTERVAL_MS: '15000',
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };

  for (const k of Object.keys(process.env)) {
    if (k.startsWith('TRADER_')) delete process.env[k];
  }
});

afterEach(() => {
  process.env = savedEnv;
});

describe('loadConfig', () => {
  it('reads all values from env', () => {
    Object.assign(process.env, FULL_ENV);

    const cfg = loadConfig();

    expect(cfg.wsUrl).toBe('ws://ws');
    expect(cfg.restUrl).toBe('http://rest');
    expect(cfg.apiKey).toBe('KEY');
    expect(cfg.apiSecret).toBe('SECRET');
    expect(cfg.strategy).toBe('range');
    expect(cfg.symbol).toBe('XBTUSD');
    expect(cfg.tickIntervalMs).toBe(15000);
  });

  it('applies defaults for the optional fields', () => {
    Object.assign(process.env, {
      TRADER_WS_URL:     'ws://ws',
      TRADER_REST_URL:   'http://rest',
      TRADER_API_KEY:    'KEY',
      TRADER_API_SECRET: 'SECRET',
    });

    const cfg = loadConfig();

    expect(cfg.strategy).toBe('range');
    expect(cfg.symbol).toBe('XBTUSD');
    expect(cfg.tickIntervalMs).toBe(30000);
  });
});

describe('validate', () => {
  for (const required of REQUIRED_VARS) {
    it(`throws when ${required} is missing`, () => {
      Object.assign(process.env, FULL_ENV);
      delete process.env[required];

      expect(() => loadConfig()).toThrow(new RegExp(`${required} is required`));
    });
  }

  it('does not throw when every required field is set', () => {
    expect(() =>
      validate({
        wsUrl:          'ws://ws',
        restUrl:        'http://rest',
        apiKey:         'KEY',
        apiSecret:      'SECRET',
        strategy:       'range',
        symbol:         'XBTUSD',
        tickIntervalMs: 30000,
      }),
    ).not.toThrow();
  });
});
