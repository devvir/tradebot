import http from 'node:http';
import logger from '@tradebot/logger';
import type { CodecState, HealthState } from './types';

const HEALTH_PORT = 3000;

export const startHealthCheck = (codecState: CodecState): void => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const state = getHealthState(codecState);
      const isHealthy = state.mqConnected && Date.now() - state.lastProcessedTime < 60000;
      const statusCode = isHealthy ? 200 : 503;
      const body = JSON.stringify({
        status: isHealthy ? 'healthy' : 'unhealthy',
        mqConnected: state.mqConnected,
        messagesProcessed: state.messagesProcessed,
        lastProcessedTime: Date.now() - state.lastProcessedTime,
      });
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(HEALTH_PORT, () => {
    logger.info({ port: HEALTH_PORT }, 'Health check server listening');
  });
};

const getHealthState = (state: CodecState): HealthState => {
  return {
    mqConnected: state.rabbitmqBroker !== null && state.rabbitmqBroker.getState() === 'connected',
    messagesProcessed: state.messagesProcessed,
    lastProcessedTime: state.lastProcessedTime,
  };
};
