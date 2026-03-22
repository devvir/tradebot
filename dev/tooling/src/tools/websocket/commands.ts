import WebSocket from 'ws';
import readline from 'node:readline';
import { info, warn, error, section, spacer } from '../../shared/ui/logger';

export function printHelp(platform = false): void {
  section('Available Commands');
  console.log('  sub <channel> [<symbol>]   - Subscribe (e.g., sub trade XBTUSD, sub order)');
  console.log('  unsub <channel> [<symbol>] - Unsubscribe (e.g., unsub trade XBTUSD)');
  if (! platform) {
    console.log('  quotes <symbol>            - Subscribe to quotes (e.g., quotes XBTUSD)');
    console.log('  trades <symbol>            - Subscribe to trades (e.g., trades XBTUSD)');
    console.log('  orders                     - Subscribe to orders (auth required)');
    console.log('  positions                  - Subscribe to positions (auth required)');
  }
  console.log('  list                       - List current subscriptions');
  console.log('  ping                       - Send ping');
  console.log('  help                       - Show this help');
  console.log('  exit                       - Disconnect and exit');
  spacer();
}

export function startREPL(ws: WebSocket, guest: boolean, platform = false): void {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });

  const subscriptions = new Set<string>();

  // Patch stdout so incoming WebSocket messages don't clobber the input line.
  // Before any write: clear the prompt line. After: redraw the prompt.
  const originalWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
  let writing = false;

  (process.stdout as any).write = (chunk: any, encoding?: any, callback?: any): boolean => {
    if (writing) return originalWrite(chunk, encoding, callback);
    writing = true;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    const result = originalWrite(chunk, encoding, callback);
    rl.prompt(true);
    writing = false;
    return result;
  };

  const restoreStdout = (): void => {
    (process.stdout as any).write = originalWrite;
  };

  rl.prompt();

  rl.on('line', (line) => {
    const [cmd, ...args] = line.trim().split(/\s+/);

    switch (cmd?.toLowerCase()) {
      case 'sub': {
        const channel = args[0];
        const symbol  = args[1];
        if (! channel) { warn('Usage: sub <channel> [<symbol>]  e.g., sub trade XBTUSD'); break; }
        const topic = symbol ? `${channel}:${symbol}` : channel;
        ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
        subscriptions.add(topic);
        info(`Subscribing to ${topic}...`);
        break;
      }

      case 'unsub': {
        const channel = args[0];
        const symbol  = args[1];
        if (! channel) { warn('Usage: unsub <channel> [<symbol>]  e.g., unsub trade XBTUSD'); break; }
        const topic = symbol ? `${channel}:${symbol}` : channel;
        ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] }));
        subscriptions.delete(topic);
        info(`Unsubscribing from ${topic}...`);
        break;
      }

      case 'quotes': {
        const symbol = args[0];
        if (! symbol) { warn('Specify symbol: quotes XBTUSD'); break; }
        ws.send(JSON.stringify({ op: 'subscribe', args: [`quote:${symbol}`] }));
        subscriptions.add(`quote:${symbol}`);
        info(`Subscribing to quotes for ${symbol}...`);
        break;
      }

      case 'trades': {
        const symbol = args[0];
        if (! symbol) { warn('Specify symbol: trades XBTUSD'); break; }
        ws.send(JSON.stringify({ op: 'subscribe', args: [`trade:${symbol}`] }));
        subscriptions.add(`trade:${symbol}`);
        info(`Subscribing to trades for ${symbol}...`);
        break;
      }

      case 'orders': {
        if (guest) { error('Orders require authentication'); break; }
        ws.send(JSON.stringify({ op: 'subscribe', args: ['order'] }));
        subscriptions.add('order');
        info('Subscribing to orders...');
        break;
      }

      case 'positions': {
        if (guest) { error('Positions require authentication'); break; }
        ws.send(JSON.stringify({ op: 'subscribe', args: ['position'] }));
        subscriptions.add('position');
        info('Subscribing to positions...');
        break;
      }

      case 'list': {
        if (subscriptions.size === 0) {
          info('No active subscriptions');
        } else {
          info(`Active subscriptions: ${[...subscriptions].join(', ')}`);
        }
        break;
      }

      case 'ping':
        // BitMEX expects a raw string, not a JSON op
        ws.send('ping');
        break;

      case 'help':
        printHelp(platform);
        break;

      case 'exit':
      case 'quit':
        restoreStdout();
        rl.close();
        ws.close();
        return;

      default:
        if (cmd) warn(`Unknown command: ${cmd}. Type "help" to see commands, "exit" to quit.`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    restoreStdout();
    ws.close();
  });
}

