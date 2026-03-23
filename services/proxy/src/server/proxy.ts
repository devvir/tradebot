import type { Request, Response } from 'express';
import { logger } from '@devvir/service-kit';
import { resolveBitmexUrls } from '@tradebot/utils';
import { getAccount, getAccountByApiKey, signRest } from '../bouncer';
import type { Config } from '../types';

const STRIPPED_HEADERS = new Set([
  'x-account-id', 'host', 'connection', 'transfer-encoding',
  // fetch() auto-decompresses, so these no longer match the body
  'content-encoding', 'content-length',
]);

export async function forwardRequest(req: Request, res: Response, config: Config): Promise<void> {
  const accountId  = req.headers['x-account-id']  as string | undefined;
  const apiKey     = req.headers['api-key']        as string | undefined;
  const apiSig     = req.headers['api-signature']  as string | undefined;
  const apiExpires = req.headers['api-expires']    as string | undefined;

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

      await forward(req, res, account.type, {
        'api-key':       apiKey,
        'api-signature': apiSig,
        ...(apiExpires ? { 'api-expires': apiExpires } : {}),
      });
    } else if (! accountId && ! apiKey) {
      // ── Case: guest (unauthenticated) ──────────────────────────────────
      // Forward to live BitMEX with no auth. Testnet is not accessible as guest.
      await forward(req, res, 'live', {});
    } else {
      // ── Case: resolve account + sign via Bouncer ──────────────────────────
      // x-account-id takes precedence; otherwise api-key IS the account id.
      const id = (accountId ?? apiKey)!;

      const account = await getAccount(config.bouncerUrl, config.bouncerToken, id);

      if (! account) {
        res.status(401).json({ error: `Account '${id}' not found` });
        return;
      }

      const rawBody  = req.body instanceof Buffer ? req.body.toString() : '';
      const { restUrl } = resolveBitmexUrls(account.type as never);
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
  accountType: string,
  authHeaders: Record<string, string>,
): Promise<void> {
  const { restUrl } = resolveBitmexUrls(accountType as never);
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

