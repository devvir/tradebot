import { resolve } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { startMongoDB, stopMongoDB, getExposedPort, parseEnvFile } from '@tradebot/utils';

const envFile  = resolve(__dirname, '.env.testing');
const portsFile = resolve(__dirname, '.ports.json');

let stopped = false;

const stop = () => {
  if (stopped) return;
  stopped = true;
  try { stopMongoDB(envFile); } catch { /* already gone */ }
};

export const setup = async () => {
  try { stopMongoDB(envFile); } catch { /* nothing to stop */ }
  stopped = false;
  startMongoDB(envFile);

  const { COMPOSE_PROJECT_NAME: project } = parseEnvFile(envFile);
  const mongoPort = getExposedPort(project, 'mongodb', 27017);

  writeFileSync(portsFile, JSON.stringify({ mongoPort }));
  process.on('exit', stop);
};

export const teardown = async () => {
  stop();
  try { unlinkSync(portsFile); } catch { /* already gone */ }
};
