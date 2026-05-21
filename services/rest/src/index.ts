import type { Service, ExpressServerHandle } from '@devvir/service-kit';
import SK from './service';
import { buildRouter } from './routes';
import type { Config } from './types';

SK.run(async (service: Service) => {
  const api = service.servers.get('api') as ExpressServerHandle;

  api.addRoutes(buildRouter(service.config() as Config));

  await api.start();
});
