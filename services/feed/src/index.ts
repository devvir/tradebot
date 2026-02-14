import 'dotenv/config';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import logger from './logger';
import { loadConfig, validateConfig, type Config } from './config';
import { fetchAllSymbols, resolveChannels, buildSubscriptionTopics } from './bitmex';
import { connectWithRetry, publishToQueue, RabbitMQConnection } from './rabbitmq';
import { startHealthCheck } from './health';
import { subscribeToTopics } from './subscriptions';
import { setupCommandListener } from './commands';
import {
  type FeedState,
  type HealthState,
  type BitmexRawMessage,
  type BitmexWSMessage,
  isSubscriptionMessage,
  isUnsubscriptionMessage,
  isInfoMessage,
} from './types';


let state: FeedState = {
  ws: null,
  channel: null,
  reconnectDelay: 0,
  isShuttingDown: false,
  lastMessageTime: Date.now(),
  apiVersion: null,
  pingInterval: null,
};

let config: Config;
let rabbitmqConnection: RabbitMQConnection | null = null;

// Event emitter for subscription lifecycle events
const subscriptionEvents = new EventEmitter();

const main = async (): Promise<void> => {
  try {
    logger.info('Starting BitMEX Feed Service...');

    config = loadAndValidateConfig();
    await resolveSubscriptions(config);

    const idleReason = shouldStartIdleMode(config);
    if (idleReason) {
      logger.warn({ role: config.role, reason: idleReason }, 'Service entering idle mode');
      startHealthCheck(config.healthPort, getHealthState);
      return;
    }

    logger.info({
      role: config.role,
      channels: config.channels.length,
      symbols: config.symbols.length,
      subscriptions: buildSubscriptionTopics(config.channels, config.symbols).length,
    }, 'Will subscribe to topics');

    await initializeRabbitMQ(config);

    initializeBitMEX();
    startHealthCheck(config.healthPort, getHealthState);

    logger.info('Service started successfully');
  } catch (error) {
    logger.error({ error }, 'Failed to start service');
    process.exit(1);
  }
};

/**
 * Start periodic ping to keep connection alive
 */
const startHeartbeat = (ws: WebSocket): NodeJS.Timeout => {
  return setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      logger.debug('Sending ping to BitMEX');
      ws.ping();
    }
  }, 30000);
};

const connectBitMEX = (): void => {
  if (state.isShuttingDown) return;

  logger.info({ url: config.bitmexWsUrl }, 'Connecting to BitMEX WebSocket');
  state.ws = new WebSocket(config.bitmexWsUrl);

  setupWebSocketHandlers(state.ws);
};

const setupWebSocketHandlers = (ws: WebSocket): void => {
  ws.on('open', () => handleOpen(ws));
  ws.on('ping', handlePing);
  ws.on('pong', handlePong);
  ws.on('message', handleMessage);
  ws.on('error', handleError);
  ws.on('close', handleClose);
};

const handleOpen = (ws: WebSocket): void => {
  logger.info('Connected to BitMEX WebSocket');
  state.reconnectDelay = config.reconnectDelayMs;
  state.lastMessageTime = Date.now();

  const topics = buildSubscriptionTopics(config.channels, config.symbols);
  subscribeToTopics(ws, topics, config.batchSizeChannels, config.batchDelayMs);

  state.pingInterval = startHeartbeat(ws);
};

const handlePing = (): void => {
  logger.debug('Received ping from BitMEX, sending pong');
  state.ws?.pong();
};

const handlePong = (): void => {
  logger.debug('Received pong from BitMEX');
};

const handleMessage = async (message: Buffer): Promise<void> => {
  state.lastMessageTime = Date.now();

  try {
    const data: unknown = JSON.parse(message.toString());

    if (isSubscriptionMessage(data)) {
      logger.debug({ subscribe: data.subscribe, success: data.success }, 'Subscription confirmed');
      subscriptionEvents.emit('subscribed', data.subscribe);
      return;
    }

    if (isUnsubscriptionMessage(data)) {
      logger.debug({ unsubscribe: data.unsubscribe, success: data.success }, 'Unsubscription confirmed');
      subscriptionEvents.emit('unsubscribed', data.unsubscribe);
      return;
    }

    if (isInfoMessage(data)) {
      state.apiVersion = data.version;
      logger.info({ apiVersion: state.apiVersion, info: data.info }, 'Captured BitMEX API version');
      return;
    }

    const rawMessage = data as BitmexRawMessage;

    if (rawMessage.table && rawMessage.action) {
      if (state.channel) {
        const enrichedData: BitmexWSMessage = { ...rawMessage, _apiVersion: state.apiVersion || undefined };
        await publishToQueue(state.channel, enrichedData, config.messageTtlMs);
      }
    } else {
      logger.warn({ data }, 'Received unexpected message format');
    }
  } catch (error) {
    logger.error({ error, message: message.toString() }, 'Error processing WebSocket message');
  }
};

const handleError = (error: Error): void => {
  logger.error({ error: error.message || error.toString(), stack: error.stack }, 'WebSocket error');
};

const handleClose = (code: number, reason: string): void => {
  logger.warn({ code, reason: reason.toString() }, 'WebSocket closed, attempting to reconnect...');

  if (state.pingInterval) {
    clearInterval(state.pingInterval);
    state.pingInterval = null;
  }

  if (! state.isShuttingDown) {
    scheduleReconnect();
  }
};

const scheduleReconnect = (): void => {
  setTimeout(connectBitMEX, state.reconnectDelay);
  state.reconnectDelay = Math.min(
    state.reconnectDelay * 2,
    config.maxReconnectDelayMs
  );
};

const getHealthState = (): HealthState => {
  return {
    wsConnected: state.ws !== null && state.ws.readyState === WebSocket.OPEN,
    lastMessageTime: state.lastMessageTime,
  };
};

const shutdown = async (): Promise<void> => {
  logger.info('Shutting down gracefully...');
  state.isShuttingDown = true;

  if (state.ws) {
    state.ws.close();
  }

  if (rabbitmqConnection?.channel) {
    await rabbitmqConnection.channel.close();
  }

  if (rabbitmqConnection?.connection) {
    await rabbitmqConnection.connection.close();
  }

  process.exit(0);
};

const handleRabbitMQReconnect = (conn: RabbitMQConnection): void => {
  logger.info('RabbitMQ reconnected successfully');
  rabbitmqConnection = conn;
  state.channel = conn.channel;
};

/**
 * Load configuration and prepare for resolution
 */
const loadAndValidateConfig = (): Config => {
  const cfg = loadConfig();
  cfg.channelPatterns = cfg.channels;
  cfg.symbolPatterns = cfg.symbols;
  validateConfig(cfg);
  return cfg;
};

/**
 * Resolve channels and symbols based on role and patterns
 */
const resolveSubscriptions = async (cfg: Config): Promise<void> => {
  cfg.channels = resolveChannels(cfg.channelPatterns, cfg.role);
  logger.info({ role: cfg.role, channels: cfg.channels }, 'Resolved channels');

  try {
    cfg.symbols = await fetchAllSymbols(cfg.symbolPatterns, cfg.role);
    logger.info({ role: cfg.role, symbols: cfg.symbols.length }, 'Resolved symbols');
  } catch (error) {
    logger.error({ error }, 'Failed to fetch symbols');
    throw error;
  }
};

/**
 * Determine if service should enter idle mode (no work to do)
 */
const shouldStartIdleMode = (cfg: Config): string | null => {
  if (cfg.channels.length === 0) {
    return 'No channels for this role';
  }
  if (cfg.symbols.length === 0 && cfg.role !== 'GLOBAL') {
    return 'No symbols for this role';
  }
  const topics = buildSubscriptionTopics(cfg.channels, cfg.symbols);
  if (topics.length === 0) {
    return 'No subscription topics';
  }
  return null;
};

/**
 * Connect to RabbitMQ and set up channel
 */
const initializeRabbitMQ = async (cfg: Config): Promise<void> => {
  rabbitmqConnection = await connectWithRetry(
    cfg.rabbitmqUrl,
    handleRabbitMQReconnect,
    () => { state.channel = null; }
  );

  logger.info('Successfully connected to RabbitMQ');
  state.channel = rabbitmqConnection.channel;

  await setupCommandListener(rabbitmqConnection.channel, state, subscriptionEvents, config);
};

/**
 * Connect to BitMEX WebSocket and start streaming
 */
const initializeBitMEX = (): void => {
  connectBitMEX();
  state.reconnectDelay = config.reconnectDelayMs;
};

process.on('SIGTERM', () => {
  shutdown().catch((error) => logger.error({ error }, 'Error during shutdown'));
});

process.on('SIGINT', () => {
  shutdown().catch((error) => logger.error({ error }, 'Error during shutdown'));
});

main().catch((error) => {
  logger.error({ error }, 'Unhandled error in main');
  process.exit(1);
});
