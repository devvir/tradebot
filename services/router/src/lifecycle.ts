import type { ServerResponse } from 'node:http';
import { logger } from '@devvir/service-kit';
import type { RabbitMQ, Service } from '@devvir/service-kit';

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * End the process with exit code 1 when a broker connection is lost for good: the consumer
 * broker disconnects or aborts (it does not reconnect), or the publisher gives up reconnecting.
 * A broker that is closed on purpose emits neither event.
 */
export const exitOnBrokerLoss = (consumer: RabbitMQ.Broker, publisher: RabbitMQ.Broker): void => {
  consumer.on('disconnect', () => exit('The consumer lost its RabbitMQ connection; exiting'));
  consumer.on('abort', (err?: Error) => exit('The consumer could not connect to RabbitMQ; exiting', err));
  publisher.on('abort', (err?: Error) => exit('The publisher gave up reconnecting to RabbitMQ; exiting', err));
};

/** Answer the service health check: 200 while both brokers are connected, 503 otherwise. */
export const answerHealthCheck = (service: Service, consumer: RabbitMQ.Broker, publisher: RabbitMQ.Broker): void => {
  service.on('healthCheck', (_service: Service, res: ServerResponse) => {
    const brokers = { consumer: consumer.getState(), publisher: publisher.getState() };
    const healthy = brokers.consumer === 'connected' && brokers.publisher === 'connected';

    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ healthy, brokers }));
  });
};

// ── Private ───────────────────────────────────────────────────────────────────

const exit = (message: string, err?: Error): void => {
  logger.error(err ? { err } : {}, message);
  process.exit(1);
};
