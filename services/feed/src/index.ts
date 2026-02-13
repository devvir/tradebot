import 'dotenv/config';
import WebSocket from 'ws';
import logger from './logger';
import { loadConfig, validateConfig } from './config';
import type { Config } from './config';
import { fetchAllSymbols, resolveChannels, buildSubscriptionTopics } from './bitmex';
import { connectWithRetry, publishToQueue, RabbitMQConnection } from './rabbitmq';
import { startHealthCheck } from './health';
import type { FeedState, HealthState } from './types';


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

const connectBitMEX = (): void => {
  if (state.isShuttingDown) return;

  logger.info({ url: config.bitmexWsUrl }, 'Connecting to BitMEX WebSocket');

  // Connect without subscriptions in URL to avoid URL length limits
  state.ws = new WebSocket(config.bitmexWsUrl);

  state.ws.on('open', () => {
    logger.info('Connected to BitMEX WebSocket');
    state.reconnectDelay = config.reconnectDelayMs;
    state.lastMessageTime = Date.now();

    // Subscribe after connection is established
    const topics = buildSubscriptionTopics(config.channels, config.symbols);
    logger.info({ topicCount: topics.length }, 'Subscribing to topics in batches');

    // BitMEX has limits on subscriptions - batch them to avoid issues
    for (let i = 0; i < topics.length; i += config.batchSizeChannels) {
      const batch = topics.slice(i, i + config.batchSizeChannels);
      setTimeout(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          logger.debug({ batch: batch.length, total: topics.length }, 'Sending subscription batch');
          state.ws.send(JSON.stringify({ op: 'subscribe', args: batch }));
        }
      }, (i / config.batchSizeChannels) * config.batchDelayMs);
    }

    // Start heartbeat: ping every 30 seconds to keep connection alive
    state.pingInterval = setInterval(() => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        logger.debug('Sending ping to BitMEX');
        state.ws.ping();
      }
    }, 30000);
  });

  state.ws.on('ping', () => {
    logger.debug('Received ping from BitMEX, sending pong');
    state.ws?.pong();
  });

  state.ws.on('pong', () => {
    logger.debug('Received pong from BitMEX');
  });

  state.ws.on('message', async (message: Buffer) => {
    state.lastMessageTime = Date.now();
    try {
      const data = JSON.parse(message.toString()) as Record<string, unknown>;

      if (data.subscribe) {
        logger.debug({ subscribe: data.subscribe }, 'Subscription confirmed');
        return;
      }

      if (data.info || data.version) {
        if (data.version) {
          state.apiVersion = data.version as string;
          logger.info({ apiVersion: state.apiVersion }, 'Captured BitMEX API version');
        }
        logger.debug('Received info message');
        return;
      }

      if (data.table && data.action) {
        if (state.channel) {
          const enrichedData = { ...data, _apiVersion: state.apiVersion };
          await publishToQueue(state.channel, enrichedData, config.messageTtlMs);
        }
      }
    } catch (error) {
      logger.error({ error, message: message.toString() }, 'Error processing WebSocket message');
    }
  });

  state.ws.on('error', (error: Error) => {
    logger.error({ error: error.message || error.toString(), stack: error.stack }, 'WebSocket error');
  });

  state.ws.on('close', (code: number, reason: string) => {
    logger.warn({ code, reason: reason.toString() }, 'WebSocket closed, attempting to reconnect...');

    // Clear ping interval on close
    if (state.pingInterval) {
      clearInterval(state.pingInterval);
      state.pingInterval = null;
    }

    if (!state.isShuttingDown) {
      setTimeout(connectBitMEX, state.reconnectDelay);
      state.reconnectDelay = Math.min(
        state.reconnectDelay * 2,
        config.maxReconnectDelayMs
      );
    }
  });
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

const main = async (): Promise<void> => {
  try {
    logger.info('Starting BitMEX Feed Service...');

    config = loadConfig();

    // Store original patterns for matching
    config.channelPatterns = config.channels;
    config.symbolPatterns = config.symbols;

    validateConfig(config);

    // Resolve channels and symbols for this instance
    config.channels = resolveChannels(config.channelPatterns, config.role);
    logger.info({ role: config.role, channels: config.channels }, 'Resolved channels');

    if (config.channels.length === 0) {
      logger.warn({ role: config.role }, 'No channels for this role, idling');
      startHealthCheck(config.healthPort, getHealthState);
      return;
    }

    try {
      config.symbols = await fetchAllSymbols(config.symbolPatterns, config.role);
      logger.info({ role: config.role, symbols: config.symbols.length }, 'Resolved symbols');
    } catch (error) {
      logger.error({ error }, 'Failed to fetch symbols, exiting');
      process.exit(1);
    }

    if (config.symbols.length === 0 && config.role !== 'GLOBAL') {
      logger.warn({ role: config.role }, 'No symbols for this role, idling');
      startHealthCheck(config.healthPort, getHealthState);
      return;
    }

    // Build subscription topics
    const topics = buildSubscriptionTopics(config.channels, config.symbols);
    if (topics.length === 0) {
      logger.warn({ role: config.role }, 'No subscription topics, idling');
      startHealthCheck(config.healthPort, getHealthState);
      return;
    }

    logger.info({
      role: config.role,
      channels: config.channels.length,
      symbols: config.symbols.length,
      subscriptions: topics.length,
    }, 'Will subscribe to topics');

    rabbitmqConnection = await connectWithRetry(
      config.rabbitmqUrl,
      handleRabbitMQReconnect,
      () => { state.channel = null; }
    );
    state.channel = rabbitmqConnection.channel;

    connectBitMEX();
    state.reconnectDelay = config.reconnectDelayMs;

    startHealthCheck(config.healthPort, getHealthState);
  } catch (error) {
    logger.error({ error }, 'Failed to start service');
    process.exit(1);
  }
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
