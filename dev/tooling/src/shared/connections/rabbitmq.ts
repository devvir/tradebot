import amqp from 'amqplib';
import { getEnv } from '../utils/env';
import { discoverService } from '../utils/service-discovery';
import { info, success } from '../ui/logger';

export interface RabbitConnection {
  connection: amqp.ChannelModel;
  channel: amqp.Channel;
  url: string;
  mgmtUrl: string;
  mgmtAuth: string;
}

export async function connectRabbit(): Promise<RabbitConnection> {
  const user = getEnv('QUEUE_USER') || 'guest';
  const pass = getEnv('QUEUE_PASS') || 'guest';
  let url = getEnv('QUEUE_URL') || 'amqp://guest:guest@localhost:5672';
  let mgmtUrl = 'http://localhost:15672/api';

  const discovered = await discoverService(
    'rabbitmq',
    (host, port) => `amqp://${user}:${pass}@${host}:${port}`,
  );

  if (discovered) {
    url = discovered.url;
    const mgmtPort = discovered.port === 5672 ? 15672 : discovered.port + 10000;
    mgmtUrl = `http://${discovered.host}:${mgmtPort}/api`;
  }

  info(`Connecting to RabbitMQ: ${url}`);

  const connection = await amqp.connect(url);
  const channel = await connection.createChannel();
  success('Connected to RabbitMQ');

  return {
    connection,
    channel,
    url,
    mgmtUrl,
    mgmtAuth: Buffer.from(`${user}:${pass}`).toString('base64'),
  };
}
