import { logger, Service } from '@devvir/service-kit';
import SK from './service';
import { createServer, startServer } from './server';

const API_PORT = 80;

SK.run(async (service: Service) => {
  const app = createServer(service);
  const server = startServer(app, API_PORT);

  service.on('shutdown', async () => {
    await server.close(() => logger.info('Rest Server closed'));
  });
});
