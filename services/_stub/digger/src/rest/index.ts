import type { Service, ExpressServerHandle } from '@devvir/service-kit';
import { buildRestRouter } from './server';
import type { Provider } from '../provider';

/** Bring up the BitMEX-compatible REST server (mounted at `/api/v1`). */
export const startRest = async (service: Service, provider: Provider): Promise<void> => {
  const server = service.servers.get('rest') as ExpressServerHandle;

  server.addRoutes(buildRestRouter(provider));

  await server.start();
};
