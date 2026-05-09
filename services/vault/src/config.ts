import { logger } from '@devvir/service-kit';
import type { Config } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    compressionLevel: parseCompressionLevel(process.env.VAULT_COMPRESSION_LEVEL),
  };

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

const parseCompressionLevel = (raw: string | undefined): number => {
  if (! raw) return 6;

  const n = Number(raw);

  if (! Number.isInteger(n) || n < 1 || n > 9)
    throw new Error(`VAULT_COMPRESSION_LEVEL must be an integer between 1 and 9, got: ${raw}`);

  return n;
};

export default loadConfig();
