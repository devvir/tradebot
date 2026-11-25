import amqp from 'amqplib';
import { getEnv, getShellEnv } from '../utils/env';
import { discoverService } from '../utils/service-discovery';
import { info, success } from '../ui/logger';

const AMQP_PORT = 5672;
const MGMT_PORT = 15672;

export interface RabbitConnection {
  connection: amqp.ChannelModel;
  channel: amqp.Channel;
  url: string;
  /** Base URL of the management HTTP API (ends in `/api`); unset when there is none to reach. */
  mgmtUrl?: string;
  /** Why `mgmtUrl` is unset. */
  mgmtUnavailable?: string;
  /** Basic-auth value for the management API: the credentials of `url`. */
  mgmtAuth: string;
}

export interface ConnectRabbitOptions {
  /** AMQP URL to connect to as given, skipping container discovery. */
  url?: string;
}

interface Target {
  url: string;
  source: string;
  mgmtUrl?: string;
  mgmtUnavailable?: string;
}

/**
 * Connect to RabbitMQ, choosing the broker in this order:
 *
 * 1. An explicit URL: `options.url`, else a QUEUE_URL the shell exported. Used as given.
 * 2. A running rabbitmq container, through the host ports it publishes 5672 and 15672 on.
 * 3. QUEUE_URL from the .env files, else `amqp://QUEUE_USER:QUEUE_PASS@localhost:5672`.
 *
 * Discovery comes before the .env QUEUE_URL because that value addresses the broker from inside
 * the compose network, which the host cannot resolve.
 *
 * Without a discovered container, the management API is RABBITMQ_MGMT_URL, else the AMQP host on
 * QUEUE_MGMT_PORT (default 15672). A discovered container that does not publish 15672 has no
 * management API.
 */
export async function connectRabbit(options: ConnectRabbitOptions = {}): Promise<RabbitConnection> {
  const target = await resolveTarget(options);
  const { url } = target;

  info(`Connecting to RabbitMQ: ${redactUrl(url)} (${target.source})`);

  const connection = await amqp.connect(url);
  const channel = await connection.createChannel();
  success('Connected to RabbitMQ');

  return {
    connection,
    channel,
    url,
    mgmtUrl: target.mgmtUrl,
    mgmtUnavailable: target.mgmtUnavailable,
    mgmtAuth: basicAuth(url),
  };
}

async function resolveTarget(options: ConnectRabbitOptions): Promise<Target> {
  if (options.url) return withFallbackMgmt({ url: options.url, source: '--url' });

  const exported = getShellEnv('QUEUE_URL');

  if (exported) return withFallbackMgmt({ url: exported, source: 'QUEUE_URL from the shell' });

  const user = getEnv('QUEUE_USER') || 'guest';
  const pass = getEnv('QUEUE_PASS') || 'guest';

  const discovered = await discoverService(
    'rabbitmq',
    (host, port) => amqpUrl(user, pass, host, port),
    AMQP_PORT,
  );

  if (discovered) {
    const mgmtPort = discovered.ports[MGMT_PORT];

    return {
      url: discovered.url,
      source: `discovered container ${discovered.name}`,
      ...(mgmtPort
        ? { mgmtUrl: `http://${discovered.host}:${mgmtPort}/api` }
        : { mgmtUnavailable: `container ${discovered.name} does not publish the management port ${MGMT_PORT}` }),
    };
  }

  const configured = getEnv('QUEUE_URL');

  if (configured) return withFallbackMgmt({ url: configured, source: 'QUEUE_URL' });

  return withFallbackMgmt({ url: amqpUrl(user, pass, 'localhost', AMQP_PORT), source: 'default' });
}

function withFallbackMgmt(target: Target): Target {
  const explicit = getEnv('RABBITMQ_MGMT_URL');

  if (explicit) return { ...target, mgmtUrl: explicit.replace(/\/+$/, '') };

  let host: string;

  try {
    host = new URL(target.url).hostname;
  } catch {
    return { ...target, mgmtUnavailable: 'the AMQP URL has no host to reach the management API on' };
  }

  const port = getEnv('QUEUE_MGMT_PORT') || String(MGMT_PORT);

  return { ...target, mgmtUrl: `http://${host}:${port}/api` };
}

export function amqpUrl(user: string, pass: string, host: string, port: number): string {
  return `amqp://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

/** `url` with its password replaced by `***`, for logging. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.password) parsed.password = '***';

    return parsed.toString();
  } catch {
    return url.replace(/\/\/([^:@/]*):[^@]*@/, '//$1:***@');
  }
}

/** The basic-auth value for the credentials in `url`, defaulting to RabbitMQ's guest:guest. */
function basicAuth(url: string): string {
  let user = 'guest';
  let pass = 'guest';

  try {
    const parsed = new URL(url);

    if (parsed.username) user = decodeURIComponent(parsed.username);
    if (parsed.password) pass = decodeURIComponent(parsed.password);
  } catch {
    // amqp.connect has already rejected a URL this cannot parse.
  }

  return Buffer.from(`${user}:${pass}`).toString('base64');
}
