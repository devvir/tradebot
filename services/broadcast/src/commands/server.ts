import express from 'express';
import { logger } from '@devvir/service-kit';
import { SubscribeHandler, UnsubscribeHandler } from '../types';

const COMMAND_SERVER_PORT = 80;

export const startCommandServer = (
  onSubscribe: SubscribeHandler,
  onUnsubscribe: UnsubscribeHandler,
): void => {
  const app = express().use(express.json());

  app.post('/subscribe/:channel', async (req, res): Promise<void> => {
    const { channel, accountId } = requestParams(req);

    try { await onSubscribe(channel, accountId); }
    catch (err: any) { return handleSubscriptionError(err, res); }

    res.status(201).end();
  });

  app.post('/resubscribe/:channel', async (req, res) => {
    const { channel, accountId } = requestParams(req);

    onUnsubscribe(channel, accountId, true);

    try { await onSubscribe(channel, accountId); }
    catch (err: any) { return handleSubscriptionError(err, res); }

    res.status(201).end();
  });

  app.post('/unsubscribe/:channel', (req, res) => {
    const { channel, accountId } = requestParams(req);

    onUnsubscribe(channel, accountId);

    res.status(200).end();
  });

  app.listen(COMMAND_SERVER_PORT, () => {
    logger.info(`Command server listening on port ${COMMAND_SERVER_PORT}`)
  });
};

const requestParams = (req: express.Request): { channel: string; accountId?: string } => ({
  channel: req.params.channel as string,
  accountId: req.headers['x-account-id'] as string | undefined,
});

const handleSubscriptionError = (err: any, res: express.Response): void => {
  const status  = (err as any).httpStatus ?? 400;
  const message = err?.message ?? 'Unknown error';

  res.status(status).json({ error: message });
};
