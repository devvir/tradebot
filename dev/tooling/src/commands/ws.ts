import { Command } from 'commander';
import { run as runWebSocketTool } from '../tools/websocket/index';
import { error } from '../shared/ui/logger';

export function register(program: Command): void {
  program
    .command('ws [account]')
    .alias('websocket')
    .description('Connect to BitMEX WebSocket')
    .option('-t, --testnet', 'Connect to testnet (default: live)', false)
    .option('--guest', 'Connect as guest without authentication')
    .option('-p, --platform', 'Connect to /realtimePlatform endpoint (announcement, chat, connected, publicNotifications, privateNotifications)')
    .action(async (accountArg: string | undefined, options: any) => {
      try {
        if (options.testnet && ! options.guest) {
          throw new Error('--testnet / -t can only be used with --guest. Authenticated accounts have a fixed environment (live or testnet) configured in Bouncer.');
        }

        await runWebSocketTool(accountArg, {
          testnet:  options.testnet,
          guest:    options.guest,
          platform: options.platform,
        });
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
