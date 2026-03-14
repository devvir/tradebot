import { SKFactory } from '@tradebot/utils';
import type { Service } from '@devvir/service-kit';
import type { ServerResponse } from 'node:http';
import config from './config';

const HEALTH_INACTIVITY_MS = 300_000; // 5 min — polling service

export default SKFactory({ name: 'reader', rabbitmq: true, mongodb: true })
  .declare({
    config,
    state: {
      messagesPublished: 0,
      lastPublishedAt: null,
    },
  })
  .bind({
    onHealthCheck: (service: Service, res: ServerResponse) => {
      const messagesPublished = service.state('messagesPublished') as number;
      const lastPublishedAt   = service.state('lastPublishedAt')   as number | null;

      const healthy = lastPublishedAt !== null
        && Date.now() - lastPublishedAt < HEALTH_INACTIVITY_MS;

      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        messagesPublished,
        lastProcessedTime: lastPublishedAt !== null ? Date.now() - lastPublishedAt : null,
      }));
    },
  });
