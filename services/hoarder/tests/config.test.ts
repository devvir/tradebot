import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VENUE_NAMES } from '../src/venues';

// The config is read once, on import: each test sets the environment and
// imports a fresh copy.
const load = async (env: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else                     process.env[key] = value;
  }

  vi.resetModules();

  const { logger } = await import('@devvir/service-kit');
  const config     = (await import('../src/config')).default;

  return { config, logger };
};

const KEYS = ['QUEUE_URL', 'HOARDER_VENUES', 'HOARDER_QUEUE', 'HOARDER_QUEUE_MAX_LENGTH'];

const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else                     process.env[key] = value;
  }
});

describe('config', () => {
  it('requires QUEUE_URL', async () => {
    await expect(load({ QUEUE_URL: undefined })).rejects.toThrow('QUEUE_URL is required');
    await expect(load({ QUEUE_URL: '' })).rejects.toThrow('QUEUE_URL is required');
  });

  it('collects every known venue when HOARDER_VENUES is unset or blank', async () => {
    expect((await load({ QUEUE_URL: 'amqp://h' })).config.venues).toEqual(VENUE_NAMES);
    expect((await load({ QUEUE_URL: 'amqp://h', HOARDER_VENUES: ' , ' })).config.venues).toEqual(VENUE_NAMES);
  });

  it('reads HOARDER_VENUES as a comma list, trimmed, lowercased and deduplicated', async () => {
    const { config } = await load({ QUEUE_URL: 'amqp://h', HOARDER_VENUES: ' OKX, binance ,okx,' });

    expect(config.venues).toEqual(['okx', 'binance']);
  });

  it('refuses an unknown venue, naming the valid ones', async () => {
    await expect(load({ QUEUE_URL: 'amqp://h', HOARDER_VENUES: 'okx,nowhere' }))
      .rejects.toThrow(`HOARDER_VENUES: unknown venue "nowhere". Valid: ${VENUE_NAMES.join(', ')}`);
  });

  it('buffers frames in hoarder.raw, capped at a million, by default', async () => {
    const { config } = await load({ QUEUE_URL: 'amqp://h', HOARDER_QUEUE: ' ', HOARDER_QUEUE_MAX_LENGTH: '' });

    expect(config.queue).toEqual({ name: 'hoarder.raw', maxLength: 1_000_000 });
  });

  it('reads the queue name and cap from HOARDER_QUEUE and HOARDER_QUEUE_MAX_LENGTH', async () => {
    const { config } = await load({ QUEUE_URL: 'amqp://h', HOARDER_QUEUE: ' frames ', HOARDER_QUEUE_MAX_LENGTH: ' 2500 ' });

    expect(config.queue).toEqual({ name: 'frames', maxLength: 2500 });
  });

  it.each(['0', '-5', '1.5', '1e6', 'lots'])('refuses HOARDER_QUEUE_MAX_LENGTH=%s', async (value) => {
    await expect(load({ QUEUE_URL: 'amqp://h', HOARDER_QUEUE_MAX_LENGTH: value }))
      .rejects.toThrow(`HOARDER_QUEUE_MAX_LENGTH must be a positive integer, got "${value}"`);
  });

  // A password that is not valid percent-encoding must not reach the log either.
  it('never logs the credentials of the queue URL', async () => {
    const { config, logger } = await load({ QUEUE_URL: 'amqp://u:p%zz@h:5672', HOARDER_VENUES: 'okx' });

    const logged = JSON.stringify(Object.values(logger).flatMap(fn => (fn as ReturnType<typeof vi.fn>).mock.calls));

    expect(logged).not.toContain('p%zz');
    expect(logged).toContain('amqp://*****:*****@h:5672');
    expect(JSON.stringify(config)).not.toContain('p%zz');
  });
});
