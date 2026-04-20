import { Broker, Service } from '@devvir/service-kit';
import type { BitmexMessage } from '@devvir/bitmex-database';
import SK from './service';
import { createServer } from './server/websocket';
import { setup } from './subs/subscription';
import { processDelta } from './subs/deltas';
import { createSnapshots } from './subs/snapshots';
import { createBus } from './events';
import { ClientRegistry } from './subs/clients';
import type { BitmexWsMessage, Config } from './types';

SK.run(async (service: Service) => {
  const config = service.config() as Config;

  /** Create the shared event bus, client registry, and snapshot store */
  const bus       = createBus();
  const registry  = new ClientRegistry();
  const snapshots = createSnapshots();

  /** Boot up the WebSocket server and start accepting connections */
  const wss = createServer(bus, registry);

  /** Wire subscription handling (subscribe/unsubscribe ops, snapshot lookup, delta routing) */
  setup(bus, config, registry, snapshots);

  /** Start consuming deltas from the RabbitMQ deltas queue */
  const broker     = await service.providers.connect('rabbitmq') as Broker;
  const deltaQueue = broker.getQueue()!;

  const consumeCloseHandle = await deltaQueue.consume((message, { ack, metadata }) => {
    const counter   = parseInt(metadata.headers?.['x-message-count'] ?? '0');
    const accountId = (metadata.headers?.['x-account-id'] as string) || undefined;
    const delta     = message as BitmexWsMessage;

    snapshots.apply(delta as unknown as BitmexMessage, counter);

    processDelta(delta, counter, bus, accountId);

    ack();

    service.emit('message');
  }, { prefetch: 1000 });

  /** Cleanup before shutdown */
  service.on('shutdown', async () => {
    wss?.close();
    if (consumeCloseHandle) await consumeCloseHandle();
  });
});
