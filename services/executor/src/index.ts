// Pending Review
import SK from './service';
import { createWsPool } from './ws';
import { createRestClient } from './rest';
import { startServer } from './server';
import type { Config } from './types';

SK.run((service) => {
  const config = service.config() as Config;
  const ws     = createWsPool(config);
  const rest     = createRestClient(config);
  const http     = startServer(ws, rest, config);

  service.on('shutdown', () => {
    ws.closeAll();
    http.close();
  });
});
