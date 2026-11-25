import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseEnvFile } from './env';

// Resolved from dist/testing/ at runtime → shared/utils/src/testing/docker/
const DOCKER_DIR = resolve(__dirname, '../../src/testing/docker');

// ── Low-level ─────────────────────────────────────────────────────────────────

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

const composeCmd = (config: TestServicesConfig): string => {
  const files = config.composeFiles.map(f => `-f "${f}"`).join(' ');
  return `docker compose --project-name ${config.projectName} --env-file "${config.envFile}" ${files}`;
};

export const startTestServices = (config: TestServicesConfig): void => {
  const timeout = config.timeout ?? 60;
  const env = { ...process.env, ...parseEnvFile(config.envFile) };
  const cmd = `${composeCmd(config)} up -d --wait --wait-timeout ${timeout}`;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      execSync(cmd, { stdio: 'inherit', env, timeout: (timeout + 30) * 1000 });
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      // Docker's IPAM can fail under concurrent compose starts — brief pause before retry
      execSync(`sleep ${attempt * 2}`);
    }
  }
};

export const stopTestServices = (config: TestServicesConfig): void => {
  const env = { ...process.env, ...parseEnvFile(config.envFile) };

  execSync(
    `${composeCmd(config)} down --volumes`,
    { stdio: 'inherit', env },
  );
};

// ── Per-service helpers ────────────────────────────────────────────────────────

const projectName = (envFile: string): string => {
  const name = parseEnvFile(envFile).COMPOSE_PROJECT_NAME;

  if (! name) throw new Error(`COMPOSE_PROJECT_NAME not found in ${envFile}`);

  return name;
};

export const startRabbitMQ = (envFile: string): void => {
  startTestServices({
    envFile,
    composeFiles: [resolve(DOCKER_DIR, 'rabbitmq.yml')],
    projectName: projectName(envFile),
    timeout: 60,
  });
};

export const stopRabbitMQ = (envFile: string): void => {
  stopTestServices({
    envFile,
    composeFiles: [resolve(DOCKER_DIR, 'rabbitmq.yml')],
    projectName: projectName(envFile),
  });
};
