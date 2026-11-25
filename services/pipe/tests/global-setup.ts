import { resolve } from 'node:path';
import { startRabbitMQ, stopRabbitMQ } from '@tradebot/utils/testing';
import { dockerUnavailable } from './docker';

const envFile = resolve(__dirname, '.env.testing');

let stopped = false;

const stop = () => {
  if (stopped) return;
  stopped = true;
  try { stopRabbitMQ(envFile); } catch { /* already gone */ }
};

/** Starts the test broker; without docker it starts nothing and the integration suite skips. */
export const setup = async () => {
  if (dockerUnavailable) {
    console.warn(`Skipping the pipe integration tests: ${dockerUnavailable}`);
    return;
  }

  // Clean up any containers left by a previous aborted run
  try { stopRabbitMQ(envFile); } catch { /* nothing to stop */ }
  stopped = false;
  startRabbitMQ(envFile);
  process.on('exit', stop);
};

export const teardown = async () => {
  if (! dockerUnavailable) stop();
};
