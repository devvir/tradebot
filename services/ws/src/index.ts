import { Broker, Service } from '@devvir/service-kit';
import SK from './service';
import { createServer } from './server/websocket';
import { setup } from './subs/subscription';
import { processDelta } from './subs/deltas';
import { createBus } from './events';
import { ClientRegistry } from './subs/clients';
import type { BitmexWsMessage, Config } from './types';

SK.run(async (service: Service) => {
  const config = service.config() as Config;

  /** Create the shared event bus and client registry */
  const bus      = createBus();
  const registry = new ClientRegistry();

  /** Boot up the WebSocket server and start accepting connections */
  const wss = createServer(config.wsPort, bus, registry);

  /** Wire subscription handling (subscribe/unsubscribe ops, snapshot fetch, delta routing) */
  setup(bus, registry, config.snapshotsUrl);

  /** Start consuming deltas from the RabbitMQ deltas queue */
  const broker     = await service.providers.connect('rabbitmq') as Broker;
  const deltaQueue = broker.getQueue()!;

  const consumeCloseHandle = await deltaQueue.consume((message, { ack, metadata }) => {
    const counter = parseInt(metadata.headers?.['x-message-count'] ?? '0');
    const delta   = message as BitmexWsMessage;

    processDelta(delta, counter, bus);

    ack();
    service.emit('message');
  }, { prefetch: 1000 });

  /** Cleanup before shutdown */
  service.on('shutdown', async () => {
    wss?.close();
    if (consumeCloseHandle) await consumeCloseHandle();
  });
});
