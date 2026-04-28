import { logger } from '@devvir/service-kit';
import { GENERATOR_NAMES } from './types';
import type { Config, GeneratorName } from './types';

const VALID_GENERATORS = new Set<string>(GENERATOR_NAMES);

export const loadConfig = (): Config => {
  const config: Config = {
    database:   process.env.DB_DATABASE ?? '',
    generators: parseGenerators(process.env.DISTILLER_GENERATORS),
  };

  if (! config.database)
    throw new Error('DB_DATABASE is required');

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseGenerators(raw: string | undefined): GeneratorName[] | null {
  if (! raw || ! raw.trim()) return null;

  const names = raw.split(',').map(s => s.trim()).filter(Boolean);

  for (const name of names) {
    if (! VALID_GENERATORS.has(name)) {
      throw new Error(
        `DISTILLER_GENERATORS: unknown generator "${name}". ` +
        `Valid: ${GENERATOR_NAMES.join(', ')}`,
      );
    }
  }

  return names as GeneratorName[];
}

export default loadConfig();

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_loadConfig    = loadConfig;
export const _test_parseGenerators = parseGenerators;
