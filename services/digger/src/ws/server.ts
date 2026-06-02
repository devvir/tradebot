import type { WsServerHandle, WsServerClient } from '@devvir/service-kit';
import type { IncomingMessage } from 'node:http';
import type { Hub } from './subscriptions';

/**
 * Wire the Net ws server to the hub: initialise each client's subscription set
 * and `?api-key=` identity, dispatch `subscribe`/`unsubscribe` ops, and clean up
 * on disconnect. The BitMEX realtime protocol — `{ op, args: [channel] }` — maps
 * straight onto Net's `addCommand`.
 */
export const wireServer = (server: WsServerHandle, hub: Hub): void => {
  server.onConnect((client: WsServerClient, req: IncomingMessage) => {
    client.data.subs = new Set<string>();

    const apiKey = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('api-key');

    if (apiKey) client.data.apiKey = apiKey;
  });

  server.addCommand('subscribe', (client, message) => {
    for (const channel of asChannels(message.args)) void hub.subscribe(client, channel);
  });

  server.addCommand('unsubscribe', (client, message) => {
    for (const channel of asChannels(message.args)) hub.unsubscribe(client, channel);
  });

  server.onDisconnect((client) => hub.disconnect(client));
};

const asChannels = (args: unknown): string[] =>
  Array.isArray(args) ? args.map(String) : [];
