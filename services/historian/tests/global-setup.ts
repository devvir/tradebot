// Pending Review
import { resolve } from 'node:path';
import { startMongoDB, stopMongoDB } from '@tradebot/utils';

const envFile = resolve(__dirname, '.env.testing');

export const setup = async () => {
  console.log('🚀 Starting test services (MongoDB)...');
  startMongoDB(envFile);
  console.log('✅ Test services started');
};

export const teardown = async () => {
  console.log('🛑 Stopping test services...');
  stopMongoDB(envFile);
  console.log('✅ Test services stopped');
};
