import { vi } from 'vitest';
import { loadTestingEnv } from '@tradebot/utils';

loadTestingEnv(__dirname);

const SK_CONFIG = Symbol('SK_CONFIG');

const _services = new Map<string, any>();

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
