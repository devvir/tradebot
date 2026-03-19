import { resolve } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { startMongoDB, stopMongoDB, startRabbitMQ, stopRabbitMQ, getExposedPort, parseEnvFile } from '@tradebot/utils';

const envFile = resolve(__dirname, '.env.testing');
const portsFile = resolve(__dirname, '.ports.json');

export const setup = async () => {
  console.log('🚀 Starting test services (MongoDB, RabbitMQ)...');

  const { COMPOSE_PROJECT_NAME: project } = parseEnvFile(envFile);

  try {
    startMongoDB(envFile);
    startRabbitMQ(envFile);
  } catch (err) {
    console.error('Setup failed, tearing down partial infrastructure...');
    try { stopMongoDB(envFile); } catch { /* may not have started */ }
    try { stopRabbitMQ(envFile); } catch { /* may not have started */ }
    throw err;
  }

  const mongoPort = getExposedPort(project, 'mongodb', 27017);
  const rabbitPort = getExposedPort(project, 'rabbitmq', 5672);

  writeFileSync(portsFile, JSON.stringify({ mongoPort, rabbitPort }));
  console.log(`✅ Test services started (mongo:${mongoPort}, rabbit:${rabbitPort})`);
};

export const teardown = async () => {
  console.log('🛑 Stopping test services...');
  stopMongoDB(envFile);
  stopRabbitMQ(envFile);
  try { unlinkSync(portsFile); } catch { /* already gone */ }
  console.log('✅ Test services stopped');
};
