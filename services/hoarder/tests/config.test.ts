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

const saved = { QUEUE_URL: process.env.QUEUE_URL, HOARDER_VENUES: process.env.HOARDER_VENUES };

beforeEach(() => {
  delete process.env.QUEUE_URL;
  delete process.env.HOARDER_VENUES;
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

  // A password that is not valid percent-encoding must not reach the log either.
  it('never logs the credentials of the queue URL', async () => {
    const { config, logger } = await load({ QUEUE_URL: 'amqp://u:p%zz@h:5672', HOARDER_VENUES: 'okx' });

    const logged = JSON.stringify(Object.values(logger).flatMap(fn => (fn as ReturnType<typeof vi.fn>).mock.calls));

    expect(logged).not.toContain('p%zz');
    expect(logged).toContain('amqp://*****:*****@h:5672');
    expect(JSON.stringify(config)).not.toContain('p%zz');
  });
});
