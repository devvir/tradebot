import logger from './logger';

/**
 * Signal constants for graceful shutdown.
 */
export const SIGTERM = Symbol('SIGTERM');
export const SIGINT = Symbol('SIGINT');

/**
 * Type representing a graceful shutdown signal.
 */
export type ShutdownSignal = typeof SIGTERM | typeof SIGINT;

/**
 * Optional callback to perform custom cleanup before process exit.
 * Called when SIGTERM or SIGINT is received, with the signal symbol as parameter.
 */
export type OnShutdownCallback = (signal: ShutdownSignal) => Promise<void>;

/**
 * Register SIGTERM and SIGINT signal handlers for graceful shutdown.
 *
 * On signal:
 * 1. Logs the signal received
 * 2. Calls optional onShutdown callback if provided (passes signal symbol)
 * 3. Exits the process
 *
 * Errors during shutdown are logged but don't prevent process exit.
 */
export const setupShutdownHandlers = (onShutdown?: OnShutdownCallback): void => {
  const handleSignal = (nodeSignal: string, shutdownSignal: ShutdownSignal) => {
    return async () => {
      logger.info({ signal: nodeSignal }, 'Signal received, initiating graceful shutdown');

      try {
        if (onShutdown) await onShutdown(shutdownSignal);
      } catch (error) {
        logger.error({ error, signal: nodeSignal }, 'Error during shutdown');
      }

      process.exit(0);
    };
  };

  process.on('SIGTERM', handleSignal('SIGTERM', SIGTERM));
  process.on('SIGINT', handleSignal('SIGINT', SIGINT));
};
