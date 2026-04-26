import express from 'express';
import { logger, type Broker } from '@devvir/service-kit';
import type { MongoClient } from 'mongodb';
import { buildCommandRouter } from '../commands';
import { buildRestRouter } from '../rest';
import type { Config, State } from '../types';

const PORT = 80;

/**
 * Single Express app exposing both digger HTTP surfaces:
 *
 *   /                — control commands (subscribe / unsubscribe / resubscribe)
 *   /api/v1          — BitMEX-compatible REST API replica
 */
export const startHttpServer = (
  state:  State,
  config: Config,
  mongo:  MongoClient,
  broker: Broker,
): void => {
  const app = express()
    .use(express.json())
    .use('/',       buildCommandRouter(state, config, mongo, broker))
    .use('/api/v1', buildRestRouter(config, mongo));

  app.listen(PORT, () => {
    logger.info({ port: PORT }, 'HTTP server listening');
  });
};
