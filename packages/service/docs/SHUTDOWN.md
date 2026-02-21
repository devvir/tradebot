# Graceful Shutdown Utility

The `setupShutdownHandlers` utility provides a standard pattern for handling process termination signals (SIGTERM, SIGINT) with optional custom cleanup logic.

## Location

- **Package**: `@devvir/service`
- **Module**: `shutdown.ts`

## Overview

This utility registers signal handlers for SIGTERM and SIGINT, allowing services to clean up resources gracefully before exit. It supports optional custom shutdown logic through a callback.

## API

```typescript
export const SIGTERM: Symbol;
export const SIGINT: Symbol;

setupShutdownHandlers(onShutdown?: OnShutdownCallback): void
```

### Exported Constants

- `SIGTERM`: Symbol representing a SIGTERM signal
- `SIGINT`: Symbol representing a SIGINT signal

Use these symbols for type-safe signal comparison instead of string literals.

### Parameters

- `onShutdown` (optional): Async callback to perform custom cleanup
  - Called when SIGTERM or SIGINT is received
  - Receives the signal as a `ShutdownSignal` symbol
  - Errors during cleanup are logged but don't prevent process exit
  - Signature: `(signal: ShutdownSignal) => Promise<void>`

### Return Value

None. Signal handlers are registered with the Node.js process.

## Usage

### Basic Usage (No Custom Logic)

```typescript
import { setupShutdownHandlers } from '@devvir/service';

// Logs signal receipt and exits gracefully
setupShutdownHandlers();
```

### With Custom Cleanup

```typescript
import { setupShutdownHandlers, SIGTERM, SIGINT } from '@devvir/service';

setupShutdownHandlers(async (signal) => {
  if (signal === SIGTERM) {
    console.log('Received SIGTERM, graceful shutdown...');
  } else if (signal === SIGINT) {
    console.log('Received SIGINT, quick shutdown...');
  }

  await closeDatabase();
  await disconnectBroker();
});

// On SIGTERM/SIGINT:
// 1. Logs the signal
// 2. Calls cleanup function with signal symbol
// 3. Exits with code 0
```

### Complete Service Example

```typescript
import { setupShutdownHandlers, startHealthCheckServer, SIGTERM, SIGINT, logger } from '@devvir/service';

let mongoConnection: MongoConnection | null = null;
let broker: Broker | null = null;
let healthCheck: HealthCheckService | null = null;

const main = async () => {
  // Initialize services
  mongoConnection = await connectMongo();
  broker = await connectRabbitMQ();
  healthCheck = startHealthCheckServer();

  // Set up graceful shutdown
  setupShutdownHandlers(async (signal) => {
    const signalName = signal === SIGTERM ? 'SIGTERM' : 'SIGINT';
    logger.info({ signal: signalName }, 'Beginning graceful shutdown');

    if (healthCheck) {
      await healthCheck.close();
    }
    if (broker) {
      await broker.disconnect();
    }
    if (mongoConnection) {
      await mongoConnection.client.close();
    }

    logger.info({ signal: signalName }, 'Shutdown complete');
  });

  // Start processing
  await runPollingLoop();
};

main().catch((error) => {
  logger.error({ error }, 'Failed to start service');
  process.exit(1);
});
```

## Behavior

### Signal Handling

| Signal | Behavior |
|--------|----------|
| SIGTERM | Logs receipt, runs cleanup, exits with code 0 |
| SIGINT | Logs receipt, runs cleanup, exits with code 0 |
| Other | No special handling |

### Cleanup Execution

1. **Signal Received**: Process receives SIGTERM or SIGINT
2. **Logging**: Signal receipt logged at INFO level
3. **Cleanup**: `onShutdown` callback executed (if provided)
4. **Error Handling**: Errors logged but don't prevent exit
5. **Exit**: Process exits with code 0

### Timing

- Cleanup has no timeout—waits indefinitely for completion
- Called sequentially (not in parallel)
- All errors are caught and logged

## Examples

### Example 1: Database Connection Cleanup

```typescript
import { setupShutdownHandlers, SIGTERM, logger } from '@devvir/service';

const mongoConnection = await connectMongo();

setupShutdownHandlers(async (signal) => {
  const isGraceful = signal === SIGTERM;
  logger.info({ graceful: isGraceful }, 'Closing MongoDB connection');
  await mongoConnection.client.close();
});
```

### Example 2: Multiple Resource Cleanup

```typescript
import { setupShutdownHandlers, logger } from '@devvir/service';

setupShutdownHandlers(async (signal) => {
  logger.info('Shutting down all services');

  // Close in reverse order of initialization
  if (broker) {
    logger.info('Disconnecting from RabbitMQ');
    await broker.disconnect();
  }

  if (mongoConnection) {
    logger.info('Closing MongoDB connection');
    await mongoConnection.client.close();
  }

  logger.info('All services shut down');
});
```

### Example 3: Graceful Server Shutdown

```typescript
import { setupShutdownHandlers, startHealthCheckServer, SIGTERM, logger } from '@devvir/service';
import http from 'node:http';

let mainServer: http.Server | null = null;
let healthCheck: HealthCheckService | null = null;

setupShutdownHandlers(async (signal) => {
  const isGraceful = signal === SIGTERM;
  logger.info({ graceful: isGraceful }, 'Closing health check server');

  if (healthCheck) {
    await healthCheck.close();
  }

  if (mainServer) {
    logger.info('Waiting for active connections to close');
    // Stop accepting new connections and wait for existing ones to close
    await new Promise<void>((resolve) => {
      mainServer!.close(() => resolve());
    });
  }
});
```

### Example 4: Flush Pending Work

```typescript
import { setupShutdownHandlers, SIGTERM, logger } from '@devvir/service';

let pendingOperations = 0;

setupShutdownHandlers(async (signal) => {
  const isGraceful = signal === SIGTERM;
  logger.info({ graceful: isGraceful, pending: pendingOperations }, 'Waiting for pending operations');

  // Wait for all operations to complete
  while (pendingOperations > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  logger.info('All pending operations completed');
});
```

## Design Notes

### Why This Utility?

Signal handling is repetitive across services:
- Multiple services need the same SIGTERM/SIGINT behavior
- Logging is standardized
- Error handling is consistent
- Reduces boilerplate

### Why No Timeout?

Services should clean up properly without being rushed. A timeout would:
- Mask underlying issues (slow database connections, hung resources)
- Force incomplete cleanup
- Make debugging harder

If you need cleanup timeouts, implement them within your `onShutdown` callback:

```typescript
import { setupShutdownHandlers, logger } from '@devvir/service';

setupShutdownHandlers(async (signal) => {
  const isGraceful = signal === SIGTERM;
  const cleanupWithTimeout = Promise.race([
    performCleanup(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Cleanup timeout')), 5000)
    ),
  ]);

  try {
    await cleanupWithTimeout;
  } catch (error) {
    logger.error({ error, graceful: isGraceful }, 'Cleanup timed out, forcing exit');
  }
});
```

### Exit Code

Always exits with code 0 (success), regardless of cleanup errors. This is intentional:
- Signals indicate the process should stop
- Cleanup failures shouldn't make orchestration think it was an error
- Orchestration will restart if needed
- Errors are logged for debugging

## Common Patterns

### Pattern: Ordered Cleanup

```typescript
import { setupShutdownHandlers, logger } from '@devvir/service';

setupShutdownHandlers(async (signal) => {
  // Close in reverse order of initialization
  logger.info('Stopping message processing');
  processingChannel?.destroy();

  logger.info('Disconnecting from broker');
  await broker?.disconnect();

  logger.info('Closing database connection');
  await database?.close();
});
```

### Pattern: Drain Before Exit

```typescript
import { setupShutdownHandlers, SIGTERM, logger } from '@devvir/service';

setupShutdownHandlers(async (signal) => {
  const isGraceful = signal === SIGTERM;
  logger.info({ graceful: isGraceful }, 'Draining message queue');

  // Stop accepting new messages but finish processing existing ones
  pauseMessageConsumption();

  // Wait for queue to empty
  while (! messageQueue.isEmpty()) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  logger.info('Queue drained, exiting');
  await cleanup();
});
```

### Pattern: Health Check Closure

```typescript
import { startHealthCheckServer, setupShutdownHandlers } from '@devvir/service';

let healthCheck: HealthCheckService | null = null;

const main = async () => {
  healthCheck = startHealthCheckServer();

  setupShutdownHandlers(async (signal) => {
    if (healthCheck) {
      await healthCheck.close();
    }
    // ... other cleanup
  });
};
```

### Pattern: Multi-Layer Cleanup

```typescript
import { setupShutdownHandlers, SIGTERM, logger } from '@devvir/service';

setupShutdownHandlers(async (signal) => {
  const isGraceful = signal === SIGTERM;

  try {
    logger.info({ graceful: isGraceful }, 'Beginning multi-layer shutdown');

    // Layer 1: Stop accepting requests
    logger.info('Stopping request handler');
    requestHandler?.pause();

    // Layer 2: Wait for active work
    logger.info('Waiting for active operations');
    await activeOperations.drain();

    // Layer 3: Close connections
    logger.info('Closing connections');
    await broker?.disconnect();
    await database?.close();
  } catch (error) {
    logger.error({ error, graceful: isGraceful }, 'Error during shutdown');
    // Error is already logged, process will exit anyway
  }
});
```

## Troubleshooting

### Cleanup Never Completes

If the cleanup callback never resolves:
- Check for deadlocks (callbacks waiting on resources that are being cleaned up)
- Verify async operations are properly awaited
- Add logging inside each cleanup step

```typescript
import { setupShutdownHandlers, logger } from '@devvir/service';

setupShutdownHandlers(async (signal) => {
  logger.info('Starting broker disconnect');
  await broker?.disconnect();
  logger.info('Broker disconnected');

  logger.info('Starting database close');
  await database?.close();
  logger.info('Database closed');
});
```

### Errors During Cleanup

Errors are caught and logged automatically. Check service logs for error messages:

```bash
docker logs <container> | grep "Error during shutdown"
```

If cleanup fails silently, ensure you're awaiting all async operations:

```typescript
// ❌ Wrong - doesn't await
setupShutdownHandlers(() => {
  broker?.disconnect(); // Fire and forget
});

// ✅ Correct - awaits cleanup
setupShutdownHandlers(async () => {
  await broker?.disconnect();
});
```

### Process Takes Too Long to Exit

If the process seems stuck after receiving a signal:
- Check if cleanup callback is defined and running
- Look for unresolved promises or timers
- Verify signal handlers are registered (should see INFO log)
- Check service logs for what cleanup is waiting on

## Integration with Other Utilities

### With Health Check Server

```typescript
import {
  type HealthCheckService,
  setupShutdownHandlers,
  startHealthCheckServer,
} from '@devvir/service';

let healthCheck: HealthCheckService | null = null;

const main = async () => {
  healthCheck = startHealthCheckServer();

  setupShutdownHandlers(async (signal) => {
    if (healthCheck) {
      await healthCheck.close();
    }
    // ... other cleanup
  });
};
```

### With Logger

Cleanup is automatically logged through the `@devvir/service` logger:

```typescript
// INFO signal=SIGTERM - Signal received, initiating graceful shutdown
// ERROR signal=SIGTERM - Any cleanup errors are logged
```
