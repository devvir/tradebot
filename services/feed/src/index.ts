import 'dotenv/config';
import WebSocket from 'ws';
import logger from './logger';
import { Config, loadConfig, validateConfig } from './config';
import { fetchAllSymbols, filterSymbolsByPatterns, filterChannelsByPatterns, matchesPatterns, buildSubscriptionTopics } from './bitmex';
import { connectRabbitMQ, publishToQueue, RabbitMQConnection } from './rabbitmq';
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
    const batchSize = 20;
    for (let i = 0; i < topics.length; i += batchSize) {
      const batch = topics.slice(i, i + batchSize);
      setTimeout(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          logger.debug({ batch: batch.length, total: topics.length }, 'Sending subscription batch');
          state.ws.send(JSON.stringify({ op: 'subscribe', args: batch }));
        }
      }, i / batchSize * 100); // 100ms delay between batches
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

      // Handle new instruments from the instrument channel
      if (data.table === 'instrument' && data.action === 'insert') {
        const dataArray = (data.data as Array<{ symbol?: string }>) || [];
        const newSymbols = dataArray
          .map((inst) => inst.symbol)
          .filter((symbol): symbol is string => Boolean(symbol))
          .filter((symbol) => matchesPatterns(symbol, config.symbolPatterns));

        if (newSymbols.length > 0) {
          logger.info({ newSymbols }, 'New instruments match patterns, subscribing');
          config.symbols = Array.from(new Set([...config.symbols, ...newSymbols]));

          // Subscribe to channels for new symbols
          const newTopics = buildSubscriptionTopics(config.channels, newSymbols);
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ op: 'subscribe', args: newTopics }));
          }
        }
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

const connectWithRetry = async (maxRetries = 10, delayMs = 3000): Promise<void> => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      rabbitmqConnection = await connectRabbitMQ(config.rabbitmqUrl);
      state.channel = rabbitmqConnection.channel;
      logger.info('Successfully connected to RabbitMQ');
      return;
    } catch (error) {
      logger.warn({ error, attempt: i + 1, maxRetries }, 'Failed to connect to RabbitMQ, retrying...');
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(`Failed to connect to RabbitMQ after ${maxRetries} attempts`);
};

const main = async (): Promise<void> => {
  try {
    logger.info('Starting BitMEX Feed Service...');

    config = loadConfig();

    // Store original patterns for matching
    config.channelPatterns = config.channels;
    config.symbolPatterns = config.symbols;

    validateConfig(config);

    // Filter channels matching the patterns
    logger.info({ patterns: config.channelPatterns }, 'Filtering channels by patterns...');
    config.channels = filterChannelsByPatterns(config.channelPatterns);
    logger.info({ patterns: config.channelPatterns, matched: config.channels.length, channels: config.channels }, 'Matched channels against patterns');

    if (config.channels.length === 0) {
      logger.error({ patterns: config.channelPatterns }, 'No channels matched the given patterns');
      process.exit(1);
    }

    // Fetch symbols matching the patterns
    logger.info({ patterns: config.symbolPatterns }, 'Fetching all active symbols from BitMEX REST API...');
    try {
      const allSymbols = await fetchAllSymbols();
      config.symbols = filterSymbolsByPatterns(allSymbols, config.symbolPatterns);
      logger.info({ patterns: config.symbolPatterns, matched: config.symbols.length }, 'Matched symbols against patterns');
    } catch (error) {
      logger.error({ error }, 'Failed to fetch symbols, exiting');
      process.exit(1);
    }

    if (config.symbols.length === 0) {
      logger.error({ patterns: config.symbolPatterns }, 'No symbols matched the given patterns');
      process.exit(1);
    }

    // Build subscription topics and validate
    const topics = buildSubscriptionTopics(config.channels, config.symbols);
    if (topics.length === 0) {
      logger.error({
        channelPatterns: config.channelPatterns,
        symbolPatterns: config.symbolPatterns,
        channels: config.channels,
        symbols: config.symbols
      }, 'No subscription topics generated from the given channel and symbol patterns');
      process.exit(1);
    }

    logger.info({
      channels: config.channels.length,
      symbols: config.symbols.length,
      subscriptions: topics.length
    }, 'Will subscribe to topics');

    await connectWithRetry();

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
