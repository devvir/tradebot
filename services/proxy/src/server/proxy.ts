import type { Request, Response } from 'express';
import { logger } from '@devvir/service-kit';
import { resolveBitmexUrls, type AccountType } from '@tradebot/utils';
import { getAccount, getAccountByApiKey, signRest } from '../bouncer';
import type { Config, TestnetHint } from '../types';

const STRIPPED_HEADERS = new Set([
  'x-account-id', 'x-testnet', 'host', 'connection', 'transfer-encoding',
  // fetch() auto-decompresses, so these no longer match the body
  'content-encoding', 'content-length',
]);

/**
 * The caller picks the target BitMEX environment via `x-testnet` (`true|1` →
 * testnet, anything else / absent → live). When auth is also present the
 * account's own `type` already implies the environment; if the explicit header
 * disagrees we 400 rather than silently choosing one.
 */
function parseTestnet(raw: unknown): TestnetHint {
  if (raw === undefined) return { explicit: false, testnet: false };

  const value = String(raw).toLowerCase();

  return { explicit: true, testnet: value === 'true' || value === '1' };
}

function envOf(hint: TestnetHint): AccountType {
  return hint.testnet ? 'testnet' : 'live';
}

function envMismatches(hint: TestnetHint, accountType: AccountType): boolean {
  return hint.explicit && envOf(hint) !== accountType;
}

export async function forwardRequest(req: Request, res: Response, config: Config): Promise<void> {
  const accountId  = req.headers['x-account-id']  as string | undefined;
  const apiKey     = req.headers['api-key']        as string | undefined;
  const apiSig     = req.headers['api-signature']  as string | undefined;
  const apiExpires = req.headers['api-expires']    as string | undefined;

  const testnet = parseTestnet(req.headers['x-testnet']);

  try {
    if (apiKey && apiSig) {
      // ── Case: real credentials supplied by caller ─────────────────────────
      // api-key is the real BitMEX apiKey; look up the matching Bouncer account
      // only to resolve the target URL. No signing happens here.
      const account = await getAccountByApiKey(config.bouncerUrl, config.bouncerToken, apiKey);

      if (! account) {
        res.status(401).json({ error: 'Unknown api-key' });
        return;
      }

      if (envMismatches(testnet, account.type)) {
        res.status(400).json({ error: `x-testnet=${testnet.testnet} disagrees with account env '${account.type}'` });
        return;
      }

      await forward(req, res, account.type, {
        'api-key':       apiKey,
        'api-signature': apiSig,
        ...(apiExpires ? { 'api-expires': apiExpires } : {}),
      });
    } else if (! accountId && ! apiKey) {
      // No auth headers — forward as-is. With no account to derive the
      // environment from, the explicit `x-testnet` header decides (default: live).
      await forward(req, res, envOf(testnet), {});
    } else {
      // ── Case: resolve account + sign via Bouncer ──────────────────────────
      // x-account-id takes precedence; otherwise api-key IS the account id.
      const id = (accountId ?? apiKey)!;

      const account = await getAccount(config.bouncerUrl, config.bouncerToken, id);

      if (! account) {
        res.status(401).json({ error: `Account '${id}' not found` });
        return;
      }

      if (envMismatches(testnet, account.type)) {
        res.status(400).json({ error: `x-testnet=${testnet.testnet} disagrees with account env '${account.type}'` });
        return;
      }

      const rawBody  = req.body instanceof Buffer ? req.body.toString() : '';
      const { restUrl } = resolveBitmexUrls(account.type);
      const apiBasePath = new URL(restUrl).pathname;
      const fullPath    = apiBasePath + req.url;
      const expires     = Math.floor(Date.now() / 1000) + 60;

      const signed = await signRest(
        config.bouncerUrl, config.bouncerToken,
        id, req.method, fullPath, expires, rawBody,
      );

      await forward(req, res, account.type, {
        'api-key':       signed.apiKey,
        'api-expires':   String(signed.expires),
        'api-signature': signed.signature,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('Bouncer')) {
      logger.error({ err }, 'Bouncer error');
      res.status(503).json({ error: 'Signing service unavailable' });
      return;
    }

    throw err;
  }
}

async function forward(
  req:         Request,
  res:         Response,
  accountType: AccountType,
  authHeaders: Record<string, string>,
): Promise<void> {
  const { restUrl } = resolveBitmexUrls(accountType);
  const upstream    = restUrl + req.url;

  const headers: Record<string, string> = { ...authHeaders };

  for (const [name, value] of Object.entries(req.headers)) {
    if (! STRIPPED_HEADERS.has(name.toLowerCase()) && ! (name.toLowerCase() in authHeaders)) {
      headers[name] = value as string;
    }
  }

  logger.debug({ method: req.method, upstream }, 'Forwarding request');

  const upstreamRes = await fetch(upstream, {
    method:  req.method,
    headers,
    body:    req.body instanceof Buffer && req.body.length > 0 ? req.body : undefined,
  });

  res.status(upstreamRes.status);
  upstreamRes.headers.forEach((value, name) => {
    if (! STRIPPED_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
  });

  if (upstreamRes.body) {
    const reader = upstreamRes.body.getReader();
    let chunk = await reader.read();
    while (! chunk.done) {
      res.write(chunk.value);
      chunk = await reader.read();
    }
  }

  res.end();
}

