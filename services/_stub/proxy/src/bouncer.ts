import type { AccountSummary, SignRestResult } from './types';

/**
 * Looks up an account by its Bouncer id and returns account info
 * including type. No signing happens — used when the caller has already
 * computed a signature themselves.
 */
export async function getAccount(
  bouncerUrl:   string,
  bouncerToken: string,
  accountId:    string,
): Promise<AccountSummary | null> {
  const res = await fetch(`${bouncerUrl}/accounts/${accountId}`, {
    headers: { Authorization: `Bearer ${bouncerToken}` },
  });

  if (res.status === 404) return null;
  if (! res.ok) throw new Error(`Bouncer responded ${res.status} for account lookup`);

  return res.json() as Promise<AccountSummary>;
}

/**
 * Finds an account by its real BitMEX apiKey.
 * Used when the caller supplies real credentials (apiKey + signature) so
 * we can resolve the BitMEX target URL without signing.
 */
export async function getAccountByApiKey(
  bouncerUrl:   string,
  bouncerToken: string,
  apiKey:       string,
): Promise<AccountSummary | null> {
  const res = await fetch(`${bouncerUrl}/accounts`, {
    headers: { Authorization: `Bearer ${bouncerToken}` },
  });

  if (! res.ok) throw new Error(`Bouncer responded ${res.status} listing accounts`);

  const accounts = await res.json() as AccountSummary[];
  return accounts.find((a) => a.apiKey === apiKey) ?? null;
}

/**
 * Signs a REST request via Bouncer. Returns the real apiKey, signature,
 * expires, and account type — everything needed to forward in one trip.
 */
export async function signRest(
  bouncerUrl:   string,
  bouncerToken: string,
  accountId:    string,
  verb:         string,
  path:         string,
  expires:      number,
  body:         string,
): Promise<SignRestResult> {
  const res = await fetch(`${bouncerUrl}/sign/rest`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${bouncerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ accountId, verb, path, expires, body }),
  });

  if (! res.ok) throw new Error(`Bouncer responded ${res.status} when signing request`);

  return res.json() as Promise<SignRestResult>;
}
