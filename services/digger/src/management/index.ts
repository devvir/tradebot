import type { Service, ExpressServerHandle } from '@devvir/service-kit';
import { buildControlRouter } from './server';
import type { Reader } from '../reader';
import type { WsRuntime } from '../ws';

/** Bring up the control server (set-clock, clock). */
export const startControl = async (service: Service, ws: WsRuntime, reader: Reader): Promise<void> => {
  const server = service.servers.get('control') as ExpressServerHandle;

  server.addRoutes(buildControlRouter(ws, reader));

  await server.start();
};
