import SK from '@devvir/service-kit';
import type { Service } from '@devvir/service-kit';
import { createServer } from './server';
import { startTicker } from './data/ticker';
import { shutdownVault } from './shutdown';
import { removeStaleUploads } from './fs/writer';

SK.run((service: Service) => {
  removeStaleUploads();

  const http = createServer(service);

  startTicker();

  service.on('shutdown', () => shutdownVault(http));
});
