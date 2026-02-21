import { EventEmitter } from 'node:events';
import logger from './logger';
import { setupShutdownHandlers } from './shutdown';
import { startHealthCheckServer } from './healthcheck';
import type { OnPingCallback, HealthCheckService } from './healthcheck';

/**
 * Health status reported by a service or dependency.
 */
export interface HealthState {
  healthy: boolean;
  timestamp: number;
  dependencies?: Record<string, boolean>;
  [key: string]: unknown; // Allow custom service-specific properties
}

/**
 * Configuration for defineLifecycle.
 *
 * onInit: Called during initialization. Set up connections, load config, etc.
 * onPing: Called for health checks. Return custom health details to include in response.
 * isHealthy: Optional custom health determination. If not provided, uses dependency status.
 * onFailure: Called when an error occurs during startup or operation.
 * onShutdown: Called during graceful shutdown. Close connections, etc.
 * dependencies: List of dependency names for automatic health check extension.
 */
export interface LifecycleConfig {
  onInit?: () => Promise<void>;
  onPing?: () => Promise<Partial<HealthState>>;
  isHealthy?: () => boolean | Promise<boolean>;
  onFailure?: (error: Error) => Promise<void>;
  onShutdown?: () => Promise<void>;
  dependencies?: string[];
}

/**
 * Lifecycle instance returned by defineLifecycle.
 * Orchestrates service startup, health checks, and shutdown.
 */
export interface LifecycleInstance {
  init(): Promise<void>;
  shutdown(): Promise<void>;
  getHealthState(): Promise<HealthState>;
  on(event: string, listener: (...args: any[]) => void): LifecycleInstance;
  emit(event: string, ...args: any[]): boolean;
}

/**
 * Define a service lifecycle with sensible defaults.
 *
 * Automatically handles:
 * - HTTP health check server (listens on port 3000)
 * - Graceful shutdown on SIGTERM/SIGINT
 * - Dependency health tracking
 * - Event emissions for init, ready, failure, done
 *
 * Service only needs to implement what's special about it.
 *
 * @example
 * const lifecycle = defineLifecycle({
 *   dependencies: ['mongodb', 'rabbitmq'],
 *   onInit: async () => {
 *     state.mongo = await connectMongo();
 *     state.broker = await connectBroker();
 *   },
 *   onPing: async () => ({
 *     messagesProcessed: state.messagesProcessed,
 *     lastActivityTime: Date.now() - state.lastActivity,
 *   }),
 *   isHealthy: async () => {
 *     // Custom logic: dependencies + activity timeout
 *     return state.mongo && state.broker &&
 *       (Date.now() - state.lastActivity < 60000);
 *   },
 *   onShutdown: async () => {
 *     await state.mongo?.client.close();
 *     await state.broker?.disconnect();
 *   },
 * });
 *
 * await lifecycle.init();
 */
export const defineLifecycle = (config: LifecycleConfig): LifecycleInstance => {
  const emitter = new EventEmitter();
  const dependencyHealth = new Map<string, boolean>();

  // Initialize dependency tracking
  if (config.dependencies) {
    for (const dep of config.dependencies) {
      dependencyHealth.set(dep, false);
    }
  }

  let healthCheckService: HealthCheckService | null = null;

  /**
   * Get current health state, merging dependency status with custom details.
   */
  const getHealthState = async (): Promise<HealthState> => {
    const customState = config.onPing ? await config.onPing() : {};
    const deps = Object.fromEntries(dependencyHealth.entries());

    // Determine health: use custom isHealthy if provided, else check all dependencies
    const healthy = config.isHealthy
      ? await config.isHealthy()
      : Array.from(dependencyHealth.values()).every(v => v);

    return {
      healthy,
      timestamp: Date.now(),
      dependencies: Object.keys(deps).length > 0 ? deps : undefined,
      ...customState,
    };
  };

  /**
   * Create the health check callback.
   * Reports both dependency status and custom service details.
   */
  const createHealthCheckCallback = (): OnPingCallback => {
    return (req, res) => {
      if (req.url === '/health') {
        // Call async getHealthState and respond
        getHealthState()
          .then((state) => {
            const statusCode = state.healthy ? 200 : 503;
            const body = JSON.stringify(state);
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(body);
          })
          .catch((error) => {
            logger.error({ error }, 'Error getting health state');
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ healthy: false, error: 'Failed to get health state' }));
          });
      } else {
        res.writeHead(404);
        res.end();
      }
    };
  };

  /**
   * Gracefully shut down the service.
   * Closes health check, calls onShutdown, exits.
   */
  const shutdown = async (): Promise<void> => {
    logger.info('Initiating graceful shutdown...');

    if (healthCheckService) {
      await healthCheckService.close();
    }

    if (config.onShutdown) {
      await config.onShutdown();
    }

    emitter.emit('done');
    process.exit(0);
  };

  /**
   * Initialize the service.
   * Calls onInit, starts health check server, sets up shutdown handlers.
   */
  const init = async (): Promise<void> => {
    try {
      emitter.emit('init');

      if (config.onInit) {
        await config.onInit();
      }

      // Mark all dependencies as ready after init
      for (const dep of dependencyHealth.keys()) {
        dependencyHealth.set(dep, true);
      }

      // Start health check server
      healthCheckService = startHealthCheckServer(createHealthCheckCallback());

      // Set up graceful shutdown
      setupShutdownHandlers(shutdown);

      emitter.emit('ready');
    } catch (error) {
      emitter.emit('failure', error);
      if (config.onFailure) {
        await config.onFailure(error as Error);
      }
      throw error;
    }
  };

  const instance: LifecycleInstance = {
    init,
    shutdown,
    getHealthState,
    on: (event: string, listener: (...args: any[]) => void) => {
      emitter.on(event, listener);
      return instance;
    },
    emit: (event: string, ...args: any[]) => {
      return emitter.emit(event, ...args);
    },
  };

  return instance;
};
