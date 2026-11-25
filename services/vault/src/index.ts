import SK from '@devvir/service-kit';
import type { Service } from '@devvir/service-kit';
import { createServer } from './server';
import { startTicker } from './data/ticker';
import { shutdownVault } from './shutdown';

SK.run((service: Service) => {
  const http = createServer(service);

  startTicker();

  service.on('shutdown', () => shutdownVault(http));
});
