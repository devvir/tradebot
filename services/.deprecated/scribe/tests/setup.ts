import { vi } from 'vitest';
import { loadTestingEnv } from '@tradebot/utils';

loadTestingEnv(__dirname);

const SK_CONFIG = Symbol('SK_CONFIG');

const _services = new Map<string, any>();

/**
 * Minimal fetch-client stub: applies an optional `sign`, then delegates to the
 * (test-mocked) global `fetch`. Identity routing and HMAC signing run for real
 * while assertions still observe `global.fetch` calls.
 */
const makeFetchClient = (spec: any = {}) => {
  const request = async (input: string | URL, init: any = {}) => {
    const url    = String(input);
    const signed = spec.sign
      ? await spec.sign({ method: (init.method ?? 'GET').toUpperCase(), url, body: typeof init.body === 'string' ? init.body : '' })
      : {};

    return global.fetch(url, { ...init, headers: { ...spec.headers, ...signed, ...init.headers } });
  };

  return {
    request,
    get: async (path: string, init: any = {}) => {
      const res = await request(path, { ...init, method: 'GET' });

      if (res.ok) return res.json();

      throw Object.assign(new Error(`HTTP ${res.status}`), { httpStatus: res.status });
    },
  };
};

const scribe = {
  spec:    () => ({ name: 'scribe' }),
  config:  () => ({}),
  clients: {
    create: (spec: any) => makeFetchClient(spec),
    get:    () => makeFetchClient(),
  },
};

_services.set('scribe', scribe);

const registry = {
  add:   (service: any) => { _services.set(service.spec().name, service); },
  get:   (name: string, member?: symbol) => {
    const service = _services.get(name);

    if (! service) throw new Error(`[registry] Service "${name}" is not registered`);

    return member === SK_CONFIG ? service.config() : service;
  },
  clear: () => { _services.clear(); },
};

vi.mock('@devvir/service-kit', () => ({
  SK_CONFIG,
  registry,
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));
