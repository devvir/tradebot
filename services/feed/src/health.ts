import http from 'http';
import logger from './logger';

export interface HealthState {
  wsConnected: boolean;
  lastMessageTime: number;
}

export const startHealthCheck = (port: number, getState: () => HealthState): void => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const state = getState();
      const isHealthy = state.wsConnected && Date.now() - state.lastMessageTime < 30000;
      const statusCode = isHealthy ? 200 : 503;
      const body = JSON.stringify({
        status: isHealthy ? 'healthy' : 'unhealthy',
        wsConnected: state.wsConnected,
        lastMessage: Date.now() - state.lastMessageTime,
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
