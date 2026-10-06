import { logger, type Service, type ExpressServerHandle } from '@devvir/service-kit';
import { mount } from './api';
import { openCatalog } from './database';
import SK from './service';
import config from './config';

/**
 * The catalog's public face: one place anything outside the module asks what
 * exists and what is still owed, and sends back what it fetched.
 *
 * **It writes nothing.** Prospector surveys the venues and is the only thing
 * that writes the database; this reads it — through a lens where one is named —
 * and opens it read-only, so it could not write if it tried. What a caller
 * sends to be stored, a report or a lens, is forwarded to prospector.
 */
const main = async (service: Service): Promise<void> => {
  const db = await openCatalog(config.dbPath);

  service.on('shutdown', () => db.close());

  const api = service.servers.get() as ExpressServerHandle;

  // Routes first, then bind: `start()` appends the error handler that must come last.
  mount(api.app, db, config.token);

  await api.start();

  logger.info({ port: config.port, db: config.dbPath }, 'Catalog API listening');
};

SK.run(main);
