import http from 'http';
import logger from './logger';
import type { HealthState, HealthCheckResult } from './types';

const STALENESS_THRESHOLD_MS = 30000;

/**
 * Determine if the service is healthy based on WebSocket connection state and message recency
 */
export const determineHealth = (state: HealthState, currentTime: number = Date.now()): HealthCheckResult => {
  const timeSinceLastMessage = currentTime - state.lastMessageTime;
  const isHealthy = state.wsConnected && timeSinceLastMessage < STALENESS_THRESHOLD_MS;

  return {
    isHealthy,
    statusCode: isHealthy ? 200 : 503,
    body: {
      status: isHealthy ? 'healthy' : 'unhealthy',
      wsConnected: state.wsConnected,
      lastMessage: timeSinceLastMessage,
    },
  };
};

export const startHealthCheck = (port: number, getState: () => HealthState): void => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const state = getState();
      const result = determineHealth(state);

      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'Health check server listening');
  });
};
