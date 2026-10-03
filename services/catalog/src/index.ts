import { logger, type Service, type ExpressServerHandle } from '@devvir/service-kit';
import { mount } from './api';
import { lenses } from './lenses/lens';
import { keepCurrent } from './lenses/members';
import { openCatalog } from './database';
import SK from './service';
import config from './config';

/**
 * The catalog's public face: one place anything outside the module asks what
 * exists and what is still owed, and sends back what it fetched.
 *
 * **It owns no collection.** Prospector surveys the venues and writes every file
 * into the database; this reads that database — through a lens where one is
 * named — and stores the lenses consumers read through. Reports are forwarded to
 * prospector, which settles them, so the one service that writes a file's state
 * stays the one that knows it.
 */
const main = async (service: Service): Promise<void> => {
  const db = await openCatalog(config.dbPath);

  service.on('shutdown', () => db.close());

  const api = service.servers.get() as ExpressServerHandle;

  // Routes first, then bind: `start()` appends the error handler that must come last.
  mount(api.app, db, config.token);

  await api.start();

  // Every lens folds in new series in the background, a slice at a time.
  service.on('shutdown', keepCurrent(db, () => lenses(db)));

  logger.info({ port: config.port, db: config.dbPath }, 'Catalog API listening');
};

SK.run(main);
