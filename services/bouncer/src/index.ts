import SK from './service';
import { startServer } from './server';
import { Config } from './types';

SK.run((service) => {
  const config = service.config() as Config;
  const http = startServer(config);

  service.on('shutdown', () => http.close());
});
