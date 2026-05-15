// Express server entry point.
//
// Responsible for: creating the express app, registering middleware and routes,
// binding the port, and owning the server lifecycle (start, graceful shutdown).
// No business logic, no file ops, no data knowledge.

import express from 'express';
import type { Service } from '@devvir/service-kit';
import { logger } from '@devvir/service-kit';
import { registerRoutes } from './routes';
import { errorMiddleware } from './middleware';

const PORT = 8000;

export const createServer = (service: Service): void => {
  const app = express();

  app.use(express.json({ limit: '50mb' }));

  registerRoutes(app);
  app.use(errorMiddleware);

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Vault HTTP server listening');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'HTTP server error');
    service.shutdown('error');
  });

  service.on('shutdown', async () => {
    logger.info('Shutdown initiated — closing HTTP server');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logger.info('Vault HTTP server closed');
  });
};
