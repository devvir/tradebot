// Express server entry point.
//
// Responsible for: creating the express app, registering middleware and routes,
// binding the port, and closing the server on request. No business logic, no
// file ops, no data knowledge.

import express from 'express';
import type { Server } from 'http';
import type { Service } from '@devvir/service-kit';
import { logger } from '@devvir/service-kit';
import { registerRoutes } from './routes';
import { errorMiddleware } from './middleware';

const PORT = 8000;

// How long close() waits for in-flight requests before cutting every
// remaining connection.
const CLOSE_DEADLINE_MS = 7_000;

export interface HttpServer {
  /**
   * Stops accepting connections, closes idle ones, and resolves once every
   * in-flight request has finished or CLOSE_DEADLINE_MS has passed, whichever
   * comes first; at the deadline the remaining connections are destroyed.
   */
  close(): Promise<void>;
}

export const createServer = (service: Service): HttpServer => {
  const app = express();

  app.use(express.json({ limit: '50mb' }));

  registerRoutes(app);
  app.use(errorMiddleware);

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Vault HTTP server listening');
  });

  // Uploads may be arbitrarily large, so there is no whole-request deadline;
  // the upload route bounds inactivity instead.
  server.requestTimeout = 0;

  server.on('error', (err) => {
    logger.error({ err }, 'HTTP server error');
    service.shutdown('error');
  });

  return { close: () => closeServer(server) };
};

// While closing, how often connections that have become idle (a keep-alive
// connection whose request just finished) are closed.
const IDLE_SWEEP_MS = 50;

/**
 * Closes `server` gracefully within `deadlineMs`: idle connections are closed
 * at once and as soon as they become idle, in-flight requests may finish until
 * the deadline, and whatever is still open then is destroyed. Always resolves.
 */
export const closeServer = (server: Server, deadlineMs: number = CLOSE_DEADLINE_MS): Promise<void> => {
  return new Promise<void>((resolve) => {
    const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);

    const deadline = setTimeout(() => {
      logger.warn({ deadlineMs }, 'HTTP close deadline reached — closing remaining connections');
      server.closeAllConnections();
    }, deadlineMs);

    server.close((err) => {
      clearInterval(sweep);
      clearTimeout(deadline);

      if (err) logger.warn({ err }, 'HTTP server was not listening at close');

      resolve();
    });

    server.closeIdleConnections();
  });
};
