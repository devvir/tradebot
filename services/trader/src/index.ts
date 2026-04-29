import { logger, type Service } from '@devvir/service-kit';
import SK from './service';
import { Connection, DataCache } from './source';
import { HttpRestClient } from './rest';
import { Orchestrator } from './core';
import { loadStrategy } from './strategies';
import type { StrategyConfig } from './core';
import type { Config } from './types';

SK.run(async (service: Service) => {
  const config = service.config() as Config;
  const creds  = { apiKey: config.apiKey, apiSecret: config.apiSecret };

  const { strategy, defaults } = loadStrategy(config.strategy);

  const cfg: StrategyConfig = {
    ...defaults,
    symbol:         config.symbol,
    tickIntervalMs: config.tickIntervalMs,
  };

  const cache        = new DataCache();
  const connection   = new Connection({ wsUrl: config.wsUrl }, creds, cache);
  const restClient   = new HttpRestClient(config.restUrl, creds);
  const orchestrator = new Orchestrator(cache, restClient);

  await connection.connect();
  connection.subscribe(config.symbol, defaults.dependencies);

  orchestrator.setStrategy(strategy, cfg);
  await orchestrator.start();

  logger.info({ strategy: config.strategy, symbol: config.symbol }, 'Trader started');

  service.on('shutdown', async () => {
    await orchestrator.stop();
    await connection.disconnect();
    logger.info('Trader stopped');
  });
});
