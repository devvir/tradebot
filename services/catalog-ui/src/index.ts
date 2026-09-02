import { setupRoutes } from './api/routes';
import SK from './service';
import type { ExpressServerHandle, Service } from '@devvir/service-kit';

/**
 * A browser for the catalog.
 *
 * **It exists so that what the catalog holds can be checked by looking.** The
 * API answers precisely and at length; a few thousand rows of JSON is not
 * something a person can verify a claim against, and every wrong claim this
 * project has had to unpick came from reading aggregates rather than the thing
 * itself.
 *
 * So it adds nothing and decides nothing. It forwards, and it renders what comes
 * back — which also makes it the cheapest way to find out that an endpoint
 * cannot answer a question somebody actually has.
 */
const main = async (service: Service): Promise<void> => {
  /**
   * **Routes first, then bind**, because `start()` appends the error handler
   * that must stay last — see hauler, which does the same for the same reason.
   */
  const api = service.servers.get() as ExpressServerHandle;

  setupRoutes(api.app);

  await api.start();
};

SK.run(main);
