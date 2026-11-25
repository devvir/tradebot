import SK from '@devvir/service-kit';
import type { Service } from '@devvir/service-kit';
import { logger } from '@devvir/service-kit';
import { createServer } from './server';
import { startTicker } from './data/ticker';
import { shutdownVault } from './shutdown';
import { removeStaleUploads } from './fs/writer';

SK.run((service: Service) => {
  removeStaleUploads();

  const http = createServer(service);

  startTicker();

  service.on('shutdown', () => shutdownVault(http));

  // An error nothing caught still runs the ordered shutdown, so buffered rows
  // reach their files before the process exits, and the exit code is 1.
  let crashed = false;

  process.on('exit', () => { if (crashed) process.exitCode = 1; });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down');

    crashed = true;
    void service.shutdown('uncaughtException');
  });
});
