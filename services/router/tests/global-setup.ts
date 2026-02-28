import { resolve } from 'node:path';
import { startRabbitMQ, stopRabbitMQ } from '@tradebot/utils';

const envFile = resolve(__dirname, '.env.testing');

export const setup = async () => {
  console.log('Starting test RabbitMQ...');
  startRabbitMQ(envFile);
  console.log('Test RabbitMQ started');
};

export const teardown = async () => {
  console.log('Stopping test RabbitMQ...');
  stopRabbitMQ(envFile);
  console.log('Test RabbitMQ stopped');
};
