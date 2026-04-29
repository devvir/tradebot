import { randomUUID } from 'crypto';
import { logger } from '@devvir/service-kit';
import type { Config, InitialBalance } from './types';

const loadConfig = (): Config => {
  const config: Config = {
    database:       process.env.TELLER_DATABASE  ?? 'teller',
    initialBalance: parseInitialBalance(process.env.TELLER_INITIAL_BALANCE ?? 'XBt:100000000'),
    port:           Number(process.env.TELLER_PORT     ?? 80),
    exchange:       process.env.TELLER_EXCHANGE  ?? 'replay',
    diggerUrl:      process.env.DIGGER_URL        ?? '',
    workerUuid:     randomUUID(),
  };

  validate(config);

  logger.info(config, 'Configuration loaded and validated!');

  return config;
};

const validate = (config: Config): void => {
  if (! config.diggerUrl) throw new Error('DIGGER_URL is required');
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Parse TELLER_INITIAL_BALANCE from format 'currency:amount' (e.g. 'XBt:100000000').
 * Amount is in the currency's base unit — XBt means satoshis (1 XBT = 100_000_000 XBt).
 * Only XBt is supported in v1.
 */
const parseInitialBalance = (raw: string): InitialBalance => {
  const colonIndex = raw.indexOf(':');

  if (colonIndex === -1) {
    throw new Error(`TELLER_INITIAL_BALANCE must be 'currency:amount' (e.g. 'XBt:100000000'), got: ${raw}`);
  }

  const currency = raw.slice(0, colonIndex).trim();
  const amount   = Number(raw.slice(colonIndex + 1).trim());

  if (currency !== 'XBt') {
    throw new Error(`TELLER_INITIAL_BALANCE: only XBt is supported, got: ${currency}`);
  }

  if (! Number.isFinite(amount) || amount < 0) {
    throw new Error(`TELLER_INITIAL_BALANCE: amount must be a non-negative number, got: ${raw.slice(colonIndex + 1)}`);
  }

  return { currency: 'XBt', amount: Math.round(amount) };
};

export default loadConfig();

// ── Test-only ──────────────────────────────────────────────────────────────────

export const _test_parseInitialBalance = parseInitialBalance;
