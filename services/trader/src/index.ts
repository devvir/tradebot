import { logger, type Service } from '@devvir/service-kit';
import SK from './service';
import { DataCache, Connection, HttpRestClient } from './source';
import { Orchestrator } from './core';
import { loadStrategy, STRATEGY_CONFIGS } from './strategies';
import type { Config } from './config';

SK.run(async (service: Service) => {
  const config = service.config() as Config;

  const strategyConfig = STRATEGY_CONFIGS[config.strategy];

  if (! strategyConfig) {
    throw new Error(`Unknown strategy: ${config.strategy}`);
  }

  // Override symbol from env so it isn't hardcoded to the registry default
  const activeConfig = { ...strategyConfig, symbol: config.symbol };

  const cache       = new DataCache();
  const connection  = new Connection({ wsUrl: config.wsUrl, restUrl: config.restUrl }, cache);
  const restClient  = new HttpRestClient(config.restUrl, config.accountId);
  const orchestrator = new Orchestrator(cache, restClient);
  const strategy    = loadStrategy(config.strategy, config.symbol);

  await connection.connect();
  await connection.subscribe(config.symbol, activeConfig.dependencies);

  orchestrator.setStrategy(strategy, activeConfig);
  await orchestrator.start();

  logger.info({ strategy: config.strategy, symbol: config.symbol }, 'Trader started');

  service.on('shutdown', async () => {
    await orchestrator.stop();
    await connection.disconnect();
    logger.info('Trader stopped');
  });
});
