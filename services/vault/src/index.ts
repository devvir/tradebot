import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { logger, Service } from '@devvir/service-kit';
import { registerRoutes } from './routes';
import SK from '@devvir/service-kit';

const PORT = 80;

SK.run((service: Service) => {
  const app = express();

  app.use(express.json({ limit: '50mb' }));

  registerRoutes(app);

  // Clients (journalist) occasionally drop connections mid-request when they
  // time out and retry. Express surfaces this as a BadRequestError with
  // type 'request.aborted' — it is not a server error and should not be logged.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err && typeof err === 'object') {
      const e = err as { type?: string; status?: number };

      if (e.type === 'request.aborted') {
        if (! res.headersSent) res.status(499).end();
        return;
      }

      // body-parser rejects non-object/array JSON (strict mode) with a 400 SyntaxError
      if (e.status === 400 && err instanceof SyntaxError) {
        if (! res.headersSent) res.status(400).json({ error: 'Invalid JSON body' });
        return;
      }
    }

    logger.error({ err }, 'Unhandled request error');
    if (! res.headersSent) res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Vault HTTP server listening');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'HTTP server error');
    service.shutdown('error');
  });

  service.on('shutdown', () => server.close());
});
