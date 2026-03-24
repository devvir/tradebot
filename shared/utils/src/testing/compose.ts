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

// ── Port discovery ─────────────────────────────────────────────────────────────

/**
 * Discover the host port Docker assigned to a container port.
 * Use when host ports are left empty in .env.testing so Docker picks random ones.
 */
export const getExposedPort = (projectName: string, service: string, containerPort: number): number => {
  let containerName = `${projectName}-${service}`;
  let output: string;

  try {
    output = execSync(
      `docker port "${containerName}" ${containerPort}`,
      { encoding: 'utf8' },
    ).trim();
  } catch {
    // Docker Compose v2.x suffixes container names with -1
    containerName = `${projectName}-${service}-1`;
    output = execSync(
      `docker port "${containerName}" ${containerPort}`,
      { encoding: 'utf8' },
    ).trim();
  }

  const match = output.match(/:(\d+)/);

  if (! match) {
    throw new Error(`Could not discover host port for ${containerName}:${containerPort}`);
  }

  return parseInt(match[1], 10);
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

export const startMongoDB = (envFile: string): void => {
  startTestServices({
    envFile,
    composeFiles: [resolve(DOCKER_DIR, 'mongodb.yml')],
    projectName: projectName(envFile),
    timeout: 60,
  });
};

export const stopMongoDB = (envFile: string): void => {
  stopTestServices({
    envFile,
    composeFiles: [resolve(DOCKER_DIR, 'mongodb.yml')],
    projectName: projectName(envFile),
  });
};
