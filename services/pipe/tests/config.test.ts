import { describe, it, expect, afterEach, vi } from 'vitest';
import config, { loadConfig } from '../src/config';

vi.mock('@devvir/service-kit', () => ({ logger: { info: vi.fn() } }));

// Binding parsing, validation and topology construction are covered in bindings.test.ts.
// This file covers loading the configuration from the environment.

const ENV = { QUEUE_URL: process.env.QUEUE_URL, PIPE_BINDINGS: process.env.PIPE_BINDINGS };

const load = (env: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  return loadConfig();
};

describe('loadConfig', () => {
  afterEach(() => {
    load(ENV);
  });

  it('loads the testing environment at import', () => {
    expect(config.bindings).toHaveLength(1);
    expect(config.topology.exchangeBindings).toEqual([
      { source: 'int.pipe.env.src', destination: 'int.pipe.env.dst' },
    ]);
  });

  it('rejects a missing QUEUE_URL', () => {
    expect(() => load({ QUEUE_URL: undefined })).toThrow('QUEUE_URL is required');
  });

  it('rejects an empty PIPE_BINDINGS', () => {
    expect(() => load({ PIPE_BINDINGS: '' })).toThrow('PIPE_BINDINGS is required');
  });

  it('rejects an invalid binding', () => {
    expect(() => load({ PIPE_BINDINGS: 'bare-queue > fanout:dst' })).toThrow('must be an exchange');
  });

  it('binds a topic source without a key with #', () => {
    const { topology } = load({ PIPE_BINDINGS: 'topic:src > fanout:dst' });

    expect(topology.exchangeBindings).toEqual([{ source: 'src', destination: 'dst', routingKey: '#' }]);
  });

  it('gives an untyped mention the type its name has elsewhere', () => {
    const { topology } = load({ PIPE_BINDINGS: 'topic:x > fanout:y | @x > fanout:z' });

    expect(topology.exchanges!['x']!.type).toBe('topic');
    expect(topology.exchangeBindings).toContainEqual({ source: 'x', destination: 'z', routingKey: '#' });
  });
});
