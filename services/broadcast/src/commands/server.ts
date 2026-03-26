import express from 'express';
import { logger } from '@devvir/service-kit';

type SubscribeHandler   = (channel: string, accountId?: string) => Promise<void>;
type UnsubscribeHandler = (channel: string, accountId?: string) => void;

const COMMAND_SERVER_PORT = 80;

export const startCommandServer = (
  onSubscribe:   SubscribeHandler,
  onUnsubscribe: UnsubscribeHandler,
): void => {
  const app = express();

  app.use(express.json());

  app.post('/subscribe/:channel', async (req, res) => {
    const channel   = req.params.channel;
    const accountId = (req.headers['x-account-id'] as string | undefined) || undefined;

    try {
      await onSubscribe(channel, accountId);

      res.status(201).end();
    } catch (err: any) {
      const status  = (err as any).httpStatus ?? 400;
      const message = err?.message ?? 'Unknown error';

      res.status(status).json({ error: message });
    }
  });

  app.post('/unsubscribe/:channel', (req, res) => {
    const channel   = req.params.channel;
    const accountId = (req.headers['x-account-id'] as string | undefined) || undefined;

    onUnsubscribe(channel, accountId);

    res.status(200).end();
  });

  app.listen(COMMAND_SERVER_PORT, () => {
    logger.info(`Command server listening on port ${COMMAND_SERVER_PORT}`)
  });
};
