import http from 'node:http';
import logger from './logger';
import type { HealthState } from './types';

export const startHealthCheck = (port: number, getState: () => HealthState): void => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const state = getState();
      const isHealthy = state.mqConnected && Date.now() - state.lastProcessedTime < 60000;
      const statusCode = isHealthy ? 200 : 503;
      const body = JSON.stringify({
        status: isHealthy ? 'healthy' : 'unhealthy',
        mqConnected: state.mqConnected,
        messagesProcessed: state.messagesProcessed,
        messagesPublished: state.messagesPublished,
        lastProcessedTime: Date.now() - state.lastProcessedTime,
      });
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'Health check server listening');
  });
};
