import http from 'node:http';
import { promisify } from 'node:util';
import logger from './logger';

const DEFAULT_PORT = 3000;

/**
 * Optional callback to handle custom `/health` ping requests.
 * Called when a GET request arrives at `/health`.
 *
 * If provided, the callback is responsible for the entire response.
 * If not provided, a generic 200 response with { status: 'Ok' } is sent.
 */
export type OnPingCallback = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/**
 * Status information for the health check server.
 */
export interface HealthCheckStatus {
  listening: boolean;
  port: number;
}

/**
 * Service handle for the health check server.
 */
export interface HealthCheckService {
  status(): HealthCheckStatus;
  close(): Promise<void>;
}

/**
 * Start an HTTP health check server on the standard port (3000).
 *
 * Endpoint: GET /health
 * - Returns 200 with generic response { status: 'Ok' } by default
 * - If onPing callback is provided, delegates to the callback
 *
 * Other endpoints return 404.
 */
export const startHealthCheckServer = (onPing?: OnPingCallback | number, port = DEFAULT_PORT): HealthCheckService => {
  if (typeof onPing === 'number') {
    [ port, onPing ] = [ onPing, undefined ];
  }

  onPing ??= (_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Ok' }));
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      onPing(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'Health check server listening');
  });

  return {
    close: promisify(server.close.bind(server)),

    status: (): HealthCheckStatus => ({
      listening: server.listening,
      port,
    }),
  };
};
