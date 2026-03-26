import { WebSocketServer, WebSocket } from 'ws';
import { type IncomingMessage } from 'node:http';
import { logger } from '@devvir/service-kit';
import { welcome } from './protocol';
import { SUBSCRIPTION, DISCONNECT } from '../events';
import type { Bus, SubscriptionEvent, DisconnectEvent } from '../events';
import type { ClientRegistry } from '../subs/clients';
import { unrecognizedRequest } from './responses';
import type { SubscribeOp } from '../types';

const WS_PORT = 80;

/**
 * Start the WebSocket server.
 *
 * Responsibilities:
 *   - Accept incoming connections and register them in the client registry
 *   - Extract optional ?apiKey= from the connection URL and store it as the account identity
 *   - Greet each client on connect
 *   - Parse incoming messages and dispatch ops as bus events
 *   - Emit disconnect events on close/error so other modules can clean up
 *
 * Does NOT handle subscription logic — that is subs/subscription.ts's job.
 */
export const createServer = (bus: Bus, registry: ClientRegistry): WebSocketServer => {
  const wss = new WebSocketServer({ port: WS_PORT });

  wss.on('connection', (ws, req: IncomingMessage) => {
    const url    = new URL(req.url ?? '/', 'http://x');
    const apiKey = url.searchParams.get('api-key') ?? undefined;

    registry.register(ws);

    if (apiKey) registry.setApiKey(ws, apiKey);

    ws.send(welcome());

    ws.on('message', (data) => handleMessage(ws, data.toString(), bus));

    const onClose = (): void => {
      const event: DisconnectEvent = { ws };
      bus.emit(DISCONNECT, event);
    };

    ws.on('close', onClose);
    ws.on('error', (err) => {
      logger.error({ err }, 'Client error');
      onClose();
    });
  });

  wss.on('listening', () => logger.info({ port: WS_PORT }, 'WebSocket server listening'));
  wss.on('error',     (err) => logger.error({ err }, 'WebSocket server error'));

  return wss;
};

// ---- Message parsing ----------------------------------------------------

type Op = { op?: string; args?: unknown };

const parseMessage = (raw: string): Op | null => {
  try {
    return JSON.parse(raw) as Op;
  } catch {
    return null;
  }
};

const handleMessage = (ws: WebSocket, raw: string, bus: Bus): void => {
  if (raw === 'ping')
    return ws.send('pong');

  const msg = parseMessage(raw);

  // Invalid JSON — echo empty request object, matching BitMEX behaviour
  if (! msg)
    return ws.send(unrecognizedRequest({}));

  if (msg.op === 'subscribe' || msg.op === 'unsubscribe') {
    const event: SubscriptionEvent = { ws, op: msg as SubscribeOp };
    bus.emit(SUBSCRIPTION, event);
    return;
  }

  // No op, or unrecognised op — BitMEX echoes the request but replaces the op
  // value with the literal string "UNKNOWN" when an op was present.
  // For no-op messages, BitMEX only echoes recognised protocol fields (args);
  // unrecognised keys are stripped.
  const request = msg.op
    ? { ...msg, op: 'UNKNOWN' }
    : (msg.args !== undefined ? { args: msg.args } : {});

  ws.send(unrecognizedRequest(request));
};
