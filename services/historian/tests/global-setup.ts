import { resolve } from 'node:path';
import { startMongoDB, stopMongoDB } from '@tradebot/utils';

const envFile = resolve(__dirname, '.env.testing');

let stopped = false;

const stop = () => {
  if (stopped) return;
  stopped = true;
  try { stopMongoDB(envFile); } catch { /* already gone */ }
};

export const setup = async () => {
  // Clean up any containers left by a previous aborted run
  try { stopMongoDB(envFile); } catch { /* nothing to stop */ }
  stopped = false;
  startMongoDB(envFile);
  process.on('exit', stop);
};

export const teardown = async () => {
  stop();
};
