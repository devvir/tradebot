import type { AccountState, MarginDoc } from '../types';

/**
 * Produce the initial in-memory state for a new account.
 * No I/O — the caller writes the resulting margin doc to MongoDB.
 */
export function initAccount(
  accountId:      string,
  initialSat:     number,
  timestamp:      string,
): AccountState {
  const margin: MarginDoc = {
    accountId,
    currency:        'XBt',
    walletBalance:   initialSat,
    realisedPnl:     0,
    unrealisedPnl:   0,
    marginBalance:   initialSat,
    availableMargin: initialSat,
    initMargin:      0,
    maintMargin:     0,
    timestamp,
  };

  return {
    margin,
    positions: new Map(),
    orders:    new Map(),
  };
}
