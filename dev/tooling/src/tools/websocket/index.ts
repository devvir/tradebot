import WebSocket from 'ws';
import { info, success, error, section, spacer } from '../../shared/ui/logger';
import { resolveAccount, generateAuthMessage } from './auth';
import { printHelp, startREPL } from './commands';

const BITMEX_WS_LIVE          = 'wss://www.bitmex.com/realtime';
const BITMEX_WS_LIVE_PLATFORM = 'wss://www.bitmex.com/realtimePlatform';
const BITMEX_WS_TESTNET       = 'wss://testnet.bitmex.com/realtime';

interface RunOptions {
  testnet?:  boolean;
  guest?:    boolean;
  platform?: boolean;
}

export async function run(accountArg?: string, options: RunOptions = {}): Promise<void> {
  const { testnet = false, guest = false, platform = false } = options;
  let wsUrl: string;
  let endpointLabel: string;

  if (testnet) {
    wsUrl = BITMEX_WS_TESTNET;
    endpointLabel = 'testnet';
  } else if (platform) {
    wsUrl = BITMEX_WS_LIVE_PLATFORM;
    endpointLabel = 'live (platform)';
  } else {
    wsUrl = BITMEX_WS_LIVE;
    endpointLabel = 'live';
  }

  section('BitMEX WebSocket Tool');
  spacer();

  const { account, key, signature, expires } = await resolveAccount(accountArg, guest);

  if (! guest && account?.type === 'testnet') {
    wsUrl          = BITMEX_WS_TESTNET;
    endpointLabel  = 'testnet';
  }

  info(`Connecting to ${endpointLabel} BitMEX WebSocket...`);
  spacer();

  const ws = new WebSocket(wsUrl);
  let isConnected = false;

  return new Promise((resolve, reject) => {
    let keepAlive: ReturnType<typeof setInterval> | null = null;

    ws.on('open', () => {
      isConnected = true;
      success('Connected to BitMEX WebSocket');
      spacer();

      keepAlive = setInterval(() => ws.send('ping'), 30_000);

      if (! guest && key && signature && expires) {
        ws.send(JSON.stringify(generateAuthMessage(key, expires, signature)));
        info('Sent authentication request...');
      }

      printHelp(platform);
      startREPL(ws, guest, platform);
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.table) {
          const action = msg.action ? ` [${msg.action}]` : '';
          section(`📊 ${msg.table}${action}`);
          if (msg.action === 'partial') {
            console.log(JSON.stringify(msg, null, 2));
          } else {
            console.log(JSON.stringify(msg.data, null, 2));
          }
        } else if (msg.success !== undefined) {
          msg.success ? success('Auth successful') : error(`Auth failed: ${msg.error}`);
        } else {
          spacer();
          console.log(JSON.stringify(msg, null, 2));
          spacer();
        }
      } catch {
        console.log(data.toString());
      }
    });

    ws.on('error', (err: Error) => {
      error(`WebSocket error: ${err.message}`);
      reject(err);
    });

    ws.on('close', () => {
      if (keepAlive) clearInterval(keepAlive);
      if (isConnected) {
        info('Disconnected from BitMEX WebSocket');
        resolve();
      } else {
        reject(new Error('Failed to connect'));
      }
    });

    process.on('SIGINT', () => {
      if (keepAlive) clearInterval(keepAlive);
      info('Shutting down...');
      ws.close();
    });
  });
}
