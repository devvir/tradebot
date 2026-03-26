import type { Service } from '@devvir/service-kit';
import SK from './service';
import { startDeltaConsumer } from './processor';
import { startSnapshotServer } from './server';

SK.run(async (service: Service) => {
  await service.providers.connect('rabbitmq');

  startSnapshotServer(service);

  const stopConsuming = await startDeltaConsumer(service);

  service.on('shutdown', async () => await stopConsuming());
});
