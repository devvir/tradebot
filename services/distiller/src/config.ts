import { logger } from '@devvir/service-kit';
import { DISTILLER_NAMES } from './types';
import type { Config, DistillerName } from './types';

const VALID_DISTILLERS = new Set<string>(DISTILLER_NAMES);

export const loadConfig = (): Config => {
  const config: Config = {
    database:   process.env.DB_DATABASE ?? '',
    distillers: parseDistillers(process.env.DISTILLER_DISTILLERS),
    vaultUrl:   process.env.VAULT_URL ?? '',
  };

  if (! config.database)
    throw new Error('DB_DATABASE is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDistillers(raw: string | undefined): DistillerName[] | null {
  if (! raw || ! raw.trim()) return null;

  const names = raw.split(',').map(s => s.trim()).filter(Boolean);

  for (const name of names) {
    if (! VALID_DISTILLERS.has(name)) {
      throw new Error(
        `DISTILLER_DISTILLERS: unknown distiller "${name}". ` +
        `Valid: ${DISTILLER_NAMES.join(', ')}`,
      );
    }
  }

  return names as DistillerName[];
}

export default loadConfig();

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_loadConfig      = loadConfig;
export const _test_parseDistillers = parseDistillers;
