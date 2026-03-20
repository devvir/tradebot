import type { Application } from 'express';
import { z } from 'zod';
import { logger } from '@devvir/service-kit';
import { wsSign, restSign } from '../auth';
import { listAccounts, getAccount, saveAccount, deleteAccount } from '../store';
import { validateBody, validateQuery, CreateAccountSchema, AccountByIdQuerySchema, SignWsSchema, SignRestSchema } from './middleware';
import type { Config } from '../types';

export function setupRoutes(app: Application, config: Config): void {
  app.get('/accounts', (_req, res) => {
    res.json(listAccounts(config.dataPath));
  });

  app.get('/accounts/:id', validateQuery(AccountByIdQuerySchema), (req, res) => {
    const account = getAccount(config.dataPath, req.params['id'] as string);

    if (! account) {
      res.status(404).json({ error: `Account '${req.params['id']}' not found` });
      return;
    }

    const { expires } = res.locals['query'] as z.infer<typeof AccountByIdQuerySchema>;
    const { apiSecret: _secret, ...summary } = account;

    if (expires !== undefined) {
      res.json({ ...summary, signature: wsSign(account.apiSecret, expires), expires });
      return;
    }

    res.json(summary);
  });

  app.post('/accounts', validateBody(CreateAccountSchema), async (_req, res) => {
    const account = res.locals['body'] as z.infer<typeof CreateAccountSchema>;
    const result  = await saveAccount(config.dataPath, account);

    if (result === 'exists') {
      res.status(409).json({ error: `Account '${account.id}' already exists` });
      return;
    }

    const { apiSecret: _secret, ...summary } = account;

    logger.info({ id: account.id, type: account.type }, 'Account registered');

    res.status(201).json(summary);
  });

  app.delete('/accounts/:id', async (req, res) => {
    const id = req.params['id'] as string;

    await deleteAccount(config.dataPath, id);

    logger.info({ id }, 'Account deleted');

    res.status(204).end();
  });

  app.post('/sign/ws', validateBody(SignWsSchema), (_req, res) => {
    const { accountId, expires } = res.locals['body'] as z.infer<typeof SignWsSchema>;
    const account = getAccount(config.dataPath, accountId);

    if (! account) {
      res.status(404).json({ error: `Account '${accountId}' not found` });
      return;
    }

    res.json({ apiKey: account.apiKey, signature: wsSign(account.apiSecret, expires), expires });
  });

  app.post('/sign/rest', validateBody(SignRestSchema), (_req, res) => {
    const { accountId, verb, path, expires, body } = res.locals['body'] as z.infer<typeof SignRestSchema>;
    const account = getAccount(config.dataPath, accountId);

    if (! account) {
      res.status(404).json({ error: `Account '${accountId}' not found` });
      return;
    }

    res.json({ expires, apiKey: account.apiKey, signature: restSign(account.apiSecret, verb, path, expires, body) });
  });
}
