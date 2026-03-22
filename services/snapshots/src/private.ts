import { logger, type Service } from '@devvir/service-kit';
import { createDatabase, type BitmexMessage, type Database } from '@devvir/bitmex-database';
import type { Response } from 'express';
import type { BitmexTable } from '@devvir/bitmex-database';
import type { Config } from './types';

export const PRIVATE_TABLES = new Set([
  'execution', 'order', 'transact',
  'position', 'margin', 'wallet',
  'affiliate',
]);

// ---- Processor -----------------------------------------------------------

export const applyPrivateDelta = (
  service:   Service,
  msg:       BitmexMessage & { filter?: Record<string, unknown> },
  accountId: string,
  counter:   number,
): void => {
  if (msg.action === 'partial' && msg.filter && 'account' in msg.filter) {
    logger.error({ table: msg.table, filter: msg.filter }, 'Received pre-filtered private partial (not supported)');
    return;
  }

  const privateDBs      = service.state('privateDBs')      as Map<string, Database>;
  const privateTables   = service.state('privateTables')   as Map<string, Set<string>>;
  const privateCounters = service.state('privateCounters') as Map<string, Record<string, number>>;

  if (! privateDBs.has(accountId)) {
    privateDBs.set(accountId, createDatabase());
    privateTables.set(accountId, new Set());
    privateCounters.set(accountId, {});
  }

  privateDBs.get(accountId)!.apply(msg);
  privateCounters.get(accountId)![msg.table] = counter;

  if (msg.action === 'partial') {
    privateTables.get(accountId)!.add(msg.table);
  }
};

// ---- Server --------------------------------------------------------------

export const servePrivateSnapshot = async (
  service: Service,
  res:     Response,
  table:   string,
  account: string | undefined,
  symbol:  string | undefined,
): Promise<void> => {
  if (! account) {
    res.status(400).json({ error: `Table '${table}' requires an account parameter` });
    return;
  }

  const privateDBs      = service.state('privateDBs')      as Map<string, Database>;
  const privateTables   = service.state('privateTables')   as Map<string, Set<string>>;
  const privateCounters = service.state('privateCounters') as Map<string, Record<string, number>>;

  const accountDB     = privateDBs.get(account);
  const accountTables = privateTables.get(account);

  if (! accountDB || ! accountTables?.has(table)) {
    const config = service.config() as Config;
    return await respondFromBouncer(res, table, account, config);
  }

  const accountCounters = privateCounters.get(account)!;
  const view            = accountDB.view(table as BitmexTable);
  const snapshot        = accountDB.snapshot(table as BitmexTable);

  const filterBySymbol = symbol && 'symbol' in view.types;

  const data = filterBySymbol
    ? snapshot.filter((item: unknown) => (item as Record<string, unknown>)['symbol'] === symbol)
    : snapshot;

  const filter: Record<string, string> = { account };

  if (filterBySymbol) filter['symbol'] = symbol!;

  res.json({
    table:   view.table,
    keys:    view.keys,
    types:   view.types,
    data,
    counter: accountCounters[table] ?? 0,
    filter,
  });
};

// ---- Bouncer -------------------------------------------------------------

const respondFromBouncer = async (
  res:     Response,
  table:   string,
  account: string,
  config:  Config,
): Promise<void> => {
  if (await accountExists(account, config)) {
    res.status(503).json({ error: `No snapshot yet for table '${table}' (account '${account}')` });
  } else {
    res.status(403).json({ error: `Unknown account: '${account}'` });
  }
};

const accountExists = async (accountId: string, config: Config): Promise<boolean> => {
  try {
    const res = await fetch(`${config.bouncerUrl}/accounts/${accountId}`, {
      headers: { 'Authorization': `Bearer ${config.bouncerToken}` },
    });

    return res.status === 200;
  } catch (err) {
    logger.error({ err, accountId }, 'Bouncer check failed');
    return false;
  }
};
