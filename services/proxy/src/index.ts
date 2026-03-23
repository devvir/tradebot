import type { Service } from '@devvir/service-kit';
import SK from './service';
import { startServer } from './server';
import type { Config } from './types';

SK.run((service: Service) => {
  const config = service.config() as Config;
  const server = startServer(config);

  service.on('shutdown', () => server.close());
});
