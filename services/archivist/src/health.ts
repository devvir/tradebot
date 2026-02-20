import http from 'http';
import logger from '@tradebot/logger';

export interface HealthState {
  mongoConnected: boolean;
  mqConnected: boolean;
  messagesProcessed: number;
  lastProcessedTime: number;
}

export const startHealthCheck = (port: number, getState: () => HealthState): void => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const state = getState();
      const isHealthy = state.mongoConnected && state.mqConnected && Date.now() - state.lastProcessedTime < 60000;
      const statusCode = isHealthy ? 200 : 503;
      const body = JSON.stringify({
        status: isHealthy ? 'healthy' : 'unhealthy',
        mongoConnected: state.mongoConnected,
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

  server.listen(port, () => {
    logger.info({ port }, 'Health check server listening');
  });
};
