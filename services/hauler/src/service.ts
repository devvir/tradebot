import { SKFactory } from '@tradebot/utils';
import config from './config';

/**
 * The one thing hauler serves is its shopping list.
 *
 * What is on disk is the catalog's to report, and whether a partition is
 * finished is a fact in the shared database — both have better places to be
 * asked. What has no other home is *what we intend to fetch*, which is a
 * decision a person makes and changes.
 *
 * Routes are added in `api/`, once the list can be read; the server itself,
 * with its body parsing, logging and `/ping`, comes from the plugin.
 */
export default SKFactory({
  name:   'hauler',
  config,
  servers: { type: 'express', port: config.port },
});
