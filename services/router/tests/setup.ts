import { loadTestingEnv } from '@tradebot/utils/testing';

// config.ts calls loadConfig() at module level, so env vars must exist before import.
loadTestingEnv(__dirname);
