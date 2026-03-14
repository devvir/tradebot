import { vi } from 'vitest';
import { loadTestingEnv } from '@tradebot/utils';

// Load env vars from .env.testing before module initialization
loadTestingEnv(__dirname);

// Mock logger to suppress test output; preserve everything else (e.g. RabbitMQ)
vi.mock('@devvir/service-kit', async (importActual) => {
  const actual = await importActual<typeof import('@devvir/service-kit')>();

  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
    },
  };
});
