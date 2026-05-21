import type { FetchClientHandle } from '@devvir/service-kit';
import SK from './service';
import { runLoop } from './loop';

SK.run(async (service) => {
  const vault = service.clients.get('vault') as FetchClientHandle;

  await runLoop(vault);
});
