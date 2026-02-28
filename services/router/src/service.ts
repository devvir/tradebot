import { logger, defineLifecycle } from '@devvir/service';
import type { Broker } from '@devvir/rabbitmq';
import type { RouterResources, Route } from './types';
import { formatRoute } from './config';

let broker: Broker | null = null;
let routes: Route[] = [];

const run = (flow: () => Promise<RouterResources>): void => {
  const lifecycle = defineLifecycle({
    dependencies: ['rabbitmq'],

    onInit: async () => {
      const resources = await flow();
      broker = resources.broker;
      routes = resources.routes;
    },

    onPing: async () => {
      if (! broker) return { status: 'down', reason: 'No broker connection' };

      return {
        status: 'up',
        details: {
          routeCount: routes.length,
          routes: routes.map(formatRoute),
        },
      };
    },

    onShutdown: async () => {
      if (broker) {
        logger.info('Closing RabbitMQ connection');
        await broker.close();
      }
    },
  });

  lifecycle.init().catch((error) => {
    logger.error({ err: error }, 'Failed to start Router service');
    process.exit(1);
  });
};

export default { run };
