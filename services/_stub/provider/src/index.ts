import { type Service, type ExpressServerHandle, type FetchClientHandle } from '@devvir/service-kit';
import SK from './service';
import { buildRouter } from './server';
import { Librarian } from './librarian';

/**
 * Boot: take the librarian fetch client and the express server from the Net
 * plugin, mount the routes, start listening. Stateless — no mongo, no clock.
 */
SK.run(async (service: Service) => {
  const client    = service.clients.get('librarian') as FetchClientHandle;
  const librarian = new Librarian(client);

  const api = service.servers.get('api') as ExpressServerHandle;

  api.addRoutes(buildRouter(librarian));

  await api.start();
});
