import type { FetchClientHandle } from '@devvir/service-kit';
import SK from './service';
import { runLoop } from './loop';

SK.run(async (service) => {
  const vault = service.clients.get('vault') as FetchClientHandle;

  // Establish the redis connection once; the progress module fetches it from
  // the registry on demand.
  await service.providers.connect('redis');

  await runLoop(vault);
});
