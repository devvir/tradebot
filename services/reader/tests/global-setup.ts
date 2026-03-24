import { resolve } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { startMongoDB, stopMongoDB, startRabbitMQ, stopRabbitMQ, getExposedPort, parseEnvFile } from '@tradebot/utils';

const envFile = resolve(__dirname, '.env.testing');
const portsFile = resolve(__dirname, '.ports.json');

let stopped = false;

const stop = () => {
  if (stopped) return;
  stopped = true;
  try { stopMongoDB(envFile); } catch { /* already gone */ }
  try { stopRabbitMQ(envFile); } catch { /* already gone */ }
};

export const setup = async () => {
  // Clean up any containers left by a previous aborted run
  try { stopMongoDB(envFile); } catch { /* nothing to stop */ }
  try { stopRabbitMQ(envFile); } catch { /* nothing to stop */ }
  stopped = false;

  startMongoDB(envFile);
  startRabbitMQ(envFile);

  const { COMPOSE_PROJECT_NAME: project } = parseEnvFile(envFile);
  const mongoPort = getExposedPort(project, 'mongodb', 27017);
  const rabbitPort = getExposedPort(project, 'rabbitmq', 5672);

  writeFileSync(portsFile, JSON.stringify({ mongoPort, rabbitPort }));
  process.on('exit', stop);
};

export const teardown = async () => {
  stop();
  try { unlinkSync(portsFile); } catch { /* already gone */ }
};
