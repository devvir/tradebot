import type { RedisClient } from '@devvir/service-kit';
import SK from './service';
import { runLoop } from './loop';
import { logMetrics } from './metrics';
import { createBrokerPool, installSharedBackpressureGuard, closeBrokerPool } from './brokers';
import type { Config } from './types';

const METRICS_INTERVAL_MS = 5 * 60 * 1_000;

SK.run(async (service) => {
  const config    = service.config() as Config;
  const [ redis ] = await service.providers.connect(['redis']) as [ RedisClient ];
  const brokers   = await createBrokerPool(config.queueUrl, config.fileConcurrency);

  const guard = Object.keys(config.waitIf).length > 0
    ? installSharedBackpressureGuard(brokers, config.queueUrl, config.waitIf)
    : null;

  const stopSignal = { stopped: false };

  service.on('shutdown', async () => {
    stopSignal.stopped = true;
    guard?.stop();
    await closeBrokerPool(brokers);
  });

  setInterval(logMetrics, METRICS_INTERVAL_MS).unref();

  await runLoop(config, brokers, redis, stopSignal);
});
