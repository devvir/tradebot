import { type Service, type FetchClientHandle } from '@devvir/service-kit';
import SK from './service';
import config from './config';
import * as clock from './core/clock';
import { Provider } from './provider';
import { Reader } from './reader';
import { startWs } from './ws';
import { startRest } from './rest';
import { startControl } from './management';

/**
 * Boot order:
 *   1. Seed the clock from DIGGER_START_TIME (frozen until a client subscribes;
 *      unset → subscribes 400 until POST /set-clock).
 *   2. Build the provider seam from the two fetch clients.
 *   3. Bring up the ws engine (server + hub + pacer + loop), the rest server, and
 *      the control server.
 */
SK.run(async (service: Service) => {
  if (config.startTime !== undefined) clock.set(config.startTime);

  const providerWs   = service.clients.get('provider-ws')   as FetchClientHandle;
  const providerRest = service.clients.get('provider-rest') as FetchClientHandle;

  const provider = new Provider(providerWs, providerRest);
  const reader   = new Reader(provider, config);

  const ws = await startWs(service, reader, config);

  await startRest(service, provider);
  await startControl(service, ws, reader);
});
