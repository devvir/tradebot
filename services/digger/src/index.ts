import { type Service, type Broker } from '@devvir/service-kit';
import { type MongoClient } from 'mongodb';
import SK from './service';
import * as clock from './clock';
import { startHttpServer } from './http';
import { runStream } from './websocket';
import type { Config, State } from './types';

/**
 * Boot order:
 *   1. Connect to MongoDB and RabbitMQ.
 *   2. Seed the replay clock from `DIGGER_START_TIME` if provided. Without it,
 *      subscriptions return 400 until `POST /set-clock` is called.
 *   3. Start the HTTP server (commands + REST API).
 *   4. Run the streaming engine. Idles until the first subscribe command;
 *      returns when shutdown is requested.
 *
 * Indexes are owned by distiller — not created here.
 */
SK.run(async (service: Service) => {
  const config = service.config() as Config;
  const state  = service.state()  as State;

  const mongo  = await service.providers.connect('mongodb') as MongoClient;
  const broker = await service.providers.connect('rabbitmq') as Broker;

  state.broker = broker;

  if (config.startTime !== undefined) clock.set(config.startTime);

  startHttpServer(state, config, mongo, broker);

  await runStream(state, config, mongo, broker);
});
