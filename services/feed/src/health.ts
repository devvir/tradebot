import http from 'node:http';
import logger from '@tradebot/logger';
import type { HealthState, HealthCheckResult } from './types';

const HEALTH_PORT = 3000;
const STALENESS_THRESHOLD_MS = 30000;

/**
 * Determine if the service is healthy based on WebSocket connection states and message recency.
 * At least one WS must be connected (realtime or platform) and messages must be recent.
 */
export const determineHealth = (state: HealthState, currentTime: number = Date.now()): HealthCheckResult => {
  const timeSinceLastMessage = currentTime - state.lastMessageTime;
  const anyConnected = state.realtimeConnected || state.platformConnected;
  const isHealthy = anyConnected && timeSinceLastMessage < STALENESS_THRESHOLD_MS;

  return {
    isHealthy,
    statusCode: isHealthy ? 200 : 503,
    body: {
      status: isHealthy ? 'healthy' : 'unhealthy',
      realtimeConnected: state.realtimeConnected,
      platformConnected: state.platformConnected,
      lastMessage: timeSinceLastMessage,
    },
  };
};

export const startHealthCheck = (getState: () => HealthState): void => {
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

  server.listen(HEALTH_PORT, () => {
    logger.info({ port: HEALTH_PORT }, 'Health check server listening');
  });
};
