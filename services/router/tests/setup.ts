import { loadTestingEnv } from '@tradebot/utils';

// config.ts calls loadConfig() at module level, so env vars must exist before import.
loadTestingEnv(__dirname);
