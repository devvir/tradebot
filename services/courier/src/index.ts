import SK from './service';
import { runLoop } from './loop';
import type { Config } from './types';

SK.run(async (service) => {
  const { vaultUrl } = service.config() as Config;

  await runLoop(vaultUrl);
});
