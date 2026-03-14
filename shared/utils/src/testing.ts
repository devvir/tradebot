// Pending Review
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// ── Env file parsing ───────────────────────────────────────────────────────────

/**
 * Parse a .env file and return the key-value pairs.
 *
 * Supports:
 *  - `# comments` and blank lines (skipped)
 *  - `KEY=VALUE`
 *  - `KEY="VALUE"` or `KEY='VALUE'` (quotes stripped)
 *  - `${VAR}` interpolation against already-parsed keys, then `process.env`
 */
export const parseEnvFile = (filePath: string): Record<string, string> => {
  const content = readFileSync(filePath, 'utf8');
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (! trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;

    const key = trimmed.slice(0, eqIdx).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Interpolate ${VAR} against already-parsed values, then process.env
    value = value.replace(/\$\{([^}]+)\}/g, (_, name: string) =>
      result[name] ?? process.env[name] ?? '');

    result[key] = value;
  }

  return result;
};

/**
 * Load .env file and set variables into process.env
 * Only sets vars that are not already set in process.env
 */
export const loadEnvFile = (filePath: string): void => {
  try {
    const parsed = parseEnvFile(filePath);
    for (const [key, value] of Object.entries(parsed)) {
      if (! process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    // Silently ignore if file doesn't exist
  }
};

/**
 * Load .env.testing from the tests directory of the current service
 */
export const loadTestingEnv = (testsDir: string): void => {
  const envFile = resolve(testsDir, '.env.testing');
  loadEnvFile(envFile);
};

// ── Docker Compose lifecycle ───────────────────────────────────────────────────

export interface TestServicesConfig {
  /** Absolute path to the .env file that carries credentials and host ports */
  envFile: string;
  /** Absolute paths to the docker-compose files to include */
  composeFiles: string[];
  /** Docker Compose project name — used for container/network/volume naming */
  projectName: string;
  /** Seconds to wait for services to report healthy (default: 60) */
  timeout?: number;
}

const composeCommand = (config: TestServicesConfig): string => {
  const { envFile, composeFiles, projectName } = config;
  const files = composeFiles.map(f => `-f "${f}"`).join(' ');
  return `docker compose --project-name ${projectName} --env-file "${envFile}" ${files}`;
};

/**
 * Start docker-compose services defined in config and wait until healthy.
 * Throws if docker compose exits non-zero.
 */
export const startTestServices = (config: TestServicesConfig): void => {
  const timeout = config.timeout ?? 60;
  const parsed  = parseEnvFile(config.envFile);

  execSync(
    `${composeCommand(config)} up -d --wait --timeout ${timeout}`,
    { stdio: 'inherit', env: { ...process.env, ...parsed } },
  );
};

/**
 * Stop services and remove their volumes.
 * Throws if docker compose exits non-zero.
 */
export const stopTestServices = (config: TestServicesConfig): void => {
  const parsed = parseEnvFile(config.envFile);

  execSync(
    `${composeCommand(config)} down --volumes`,
    { stdio: 'inherit', env: { ...process.env, ...parsed } },
  );
};
// ── Per-service helpers ────────────────────────────────────────────────────────

/**
 * Start MongoDB from the standard compose file.
 * Expects envFile contains COMPOSE_PROJECT_NAME.
 */
export const startMongoDB = (envFile: string): void => {
  const parsed = parseEnvFile(envFile);
  const projectName = parsed.COMPOSE_PROJECT_NAME;
  if (! projectName) {
    throw new Error(`COMPOSE_PROJECT_NAME not found in ${envFile}`);
  }

  const mongoComposeFile = `${__dirname}/../../../services/mongodb/docker/compose.yml`;
  startTestServices({
    envFile,
    composeFiles: [mongoComposeFile],
    projectName,
    timeout: 60,
  });
};

/**
 * Stop MongoDB and remove its volumes.
 */
export const stopMongoDB = (envFile: string): void => {
  const parsed = parseEnvFile(envFile);
  const projectName = parsed.COMPOSE_PROJECT_NAME;
  if (! projectName) {
    throw new Error(`COMPOSE_PROJECT_NAME not found in ${envFile}`);
  }

  const mongoComposeFile = `${__dirname}/../../../services/mongodb/docker/compose.yml`;
  stopTestServices({
    envFile,
    composeFiles: [mongoComposeFile],
    projectName,
  });
};

/**
 * Start RabbitMQ from the standard compose file.
 * Expects envFile contains COMPOSE_PROJECT_NAME.
 */
export const startRabbitMQ = (envFile: string): void => {
  const parsed = parseEnvFile(envFile);
  const projectName = parsed.COMPOSE_PROJECT_NAME;
  if (! projectName) {
    throw new Error(`COMPOSE_PROJECT_NAME not found in ${envFile}`);
  }

  const rabbitComposeFile = `${__dirname}/../../../services/rabbitmq/docker/compose.yml`;
  startTestServices({
    envFile,
    composeFiles: [rabbitComposeFile],
    projectName,
    timeout: 60,
  });
};

/**
 * Stop RabbitMQ and remove its volumes.
 */
export const stopRabbitMQ = (envFile: string): void => {
  const parsed = parseEnvFile(envFile);
  const projectName = parsed.COMPOSE_PROJECT_NAME;
  if (! projectName) {
    throw new Error(`COMPOSE_PROJECT_NAME not found in ${envFile}`);
  }

  const rabbitComposeFile = `${__dirname}/../../../services/rabbitmq/docker/compose.yml`;
  stopTestServices({
    envFile,
    composeFiles: [rabbitComposeFile],
    projectName,
  });
};