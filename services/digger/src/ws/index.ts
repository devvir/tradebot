import type { Service, WsServerHandle } from '@devvir/service-kit';
import type { Reader } from '../reader';
import type { Config } from '../types';
import { Pacer } from './pacer';
import { Hub } from './subscriptions';
import { Loop } from './loop';
import { wireServer } from './server';

/** Handles the seek (management) needs to coordinate a clock change. */
export interface WsRuntime {
  hub:   Hub;
  loop:  Loop;
  pacer: Pacer;
}

/**
 * Bring up the WS surface: the BitMEX-shaped server, the subscription hub, the
 * slowest-client pacer, and the streaming loop. Returns the handles the control
 * plane uses to pause/re-prime on a seek.
 */
export const startWs = async (service: Service, reader: Reader, config: Config): Promise<WsRuntime> => {
  const server = service.servers.get('ws') as WsServerHandle;

  const pacer = new Pacer(server, config);
  const hub   = new Hub(server, reader);
  const loop  = new Loop(server, reader, pacer, config.drainBatch);

  wireServer(server, hub);

  await server.start();
  loop.start();

  return { hub, loop, pacer };
};
