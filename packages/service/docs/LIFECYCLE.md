# Lifecycle Utility

The `@devvir/service` lifecycle module provides a declarative, event-driven framework for managing service initialization, health checks, and graceful shutdown. It eliminates boilerplate by handling common concerns automatically while allowing services to focus on their core logic.

## Key Features

- **Declarative API**: Define service behavior through callbacks, not imperative code
- **Automatic Management**: HTTP health checks, graceful shutdown, dependency tracking
- **Event-Driven**: Emit and listen to lifecycle events (`init`, `ready`, `failure`, `done`)
- **Dependency Tracking**: Declare dependencies once, health status managed automatically
- **Custom Health Logic**: Override default dependency checking with service-specific criteria

## API

### `defineLifecycle(config: LifecycleConfig): LifecycleInstance`

Create a lifecycle instance with the given configuration.

#### LifecycleConfig

```typescript
interface LifecycleConfig {
  // Called during initialization. Return resources for lifecycle management.
  onInit?: () => Promise<void>;

  // Called for health check requests. Return custom health details.
  onPing?: () => Promise<Partial<HealthState>>;

  // Determine if service is healthy. Default: checks all dependencies.
  isHealthy?: () => boolean | Promise<boolean>;

  // Called when initialization fails.
  onFailure?: (error: Error) => Promise<void>;

  // Called during graceful shutdown. Close connections here.
  onShutdown?: () => Promise<void>;

  // List of dependency names for automatic health tracking.
  dependencies?: string[];
}
```

#### LifecycleInstance

```typescript
interface LifecycleInstance {
  // Start initialization sequence
  init(): Promise<void>;

  // Gracefully shut down the service
  shutdown(): Promise<void>;

  // Get current health state (returns Promise<HealthState>)
  getHealthState(): Promise<HealthState>;

  // Listen to lifecycle events
  on(event: string, listener: (...args: any[]) => void): LifecycleInstance;

  // Emit custom events
  emit(event: string, ...args: any[]): boolean;
}
```

#### HealthState

```typescript
interface HealthState {
  healthy: boolean;              // Overall health status
  timestamp: number;             // When this state was captured
  dependencies?: Record<string, boolean>;  // Status of declared deps
  [key: string]: unknown;        // Service-specific metrics (messagesProcessed, etc.)
}
```

## Lifecycle Events

| Event | Payload | When |
|-------|---------|------|
| `init` | (none) | Initialization starts |
| `ready` | (none) | Service fully initialized and healthy |
| `failure` | `Error` | Initialization failed |
| `done` | (none) | Shutdown complete |

## Usage Patterns

### Pattern 1: Simple Service with Lifecycle Wrapping

**index.ts** (the recipe — what the service does):
```typescript
import { loadConfig, validateConfig } from './config';
import { connectMongoWithRetry, startConsuming } from './persistence';
import { connectToQueue } from './rabbitmq';
import lifecycle from './lifecycle';

lifecycle.run(async () => {
  const config = loadConfig();
  validateConfig(config);

  const mongo = await connectMongoWithRetry(config.mongodbUrl);
  const broker = await connectToQueue(config.rabbitmqUrl);

  const channel = broker.getChannel();
  if (! channel) throw new Error('Failed to get channel from broker');

  await startConsuming(channel, mongo.db, config.batchSize, lifecycle.onMessage);

  return { mongo, broker };
});
```

**lifecycle.ts** (the bookkeeping — how it's managed):
```typescript
import { logger, defineLifecycle } from '@devvir/service';

let mongo = null;
let broker = null;
let messagesProcessed = 0;
let lastProcessedTime = Date.now();

const onMessage = () => {
  messagesProcessed++;
  lastProcessedTime = Date.now();
};

const run = (flow) => {
  const lifecycle = defineLifecycle({
    dependencies: ['mongodb', 'rabbitmq'],

    onInit: async () => {
      const resources = await flow();
      mongo = resources.mongo;
      broker = resources.broker;
    },

    onPing: async () => ({
      messagesProcessed,
      lastProcessedTime: Date.now() - lastProcessedTime,
    }),

    isHealthy: () => {
      const mongoOk = mongo !== null;
      const brokerOk = broker?.getState() === 'connected';
      const recentActivity = Date.now() - lastProcessedTime < 60000;
      return mongoOk && brokerOk && recentActivity;
    },

    onShutdown: async () => {
      if (broker) await broker.disconnect();
      if (mongo?.client) await mongo.client.close();
    },
  });

  lifecycle.init().catch((error) => {
    logger.error({ error }, 'Failed to start service');
    process.exit(1);
  });
};

export default { run, onMessage };
```

**What you see:**
- **index.ts**: "Load config, connect to dependencies, start consuming. Return resources."
- **lifecycle.ts**: "Manage health checks, track activity, handle shutdown."
- **No index.ts boilerplate**: No error handling, event listeners, or lifecycle management code.

### Pattern 2: Listening to Lifecycle Events

```typescript
import { defineLifecycle } from '@devvir/service';

const lifecycle = defineLifecycle({
  dependencies: ['database', 'cache'],
  onInit: async () => {
    // Initialize connections
  },
  onShutdown: async () => {
    // Close connections
  },
});

// Optional: React to lifecycle events
lifecycle
  .on('init', () => console.log('Initializing...'))
  .on('ready', () => console.log('Service ready!'))
  .on('failure', (error) => console.error('Failed:', error))
  .on('done', () => console.log('Shutdown complete'));

await lifecycle.init();
```

### Pattern 3: Custom Health Determination

```typescript
import { defineLifecycle } from '@devvir/service';

const lifecycle = defineLifecycle({
  dependencies: ['mongodb', 'redis'],

  onPing: async () => ({
    queueDepth: await getQueueDepth(),
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime(),
  }),

  isHealthy: () => {
    // Custom logic: check dependencies + application-specific criteria
    const depsHealthy = mongo !== null && redis !== null;
    const queueNotOverloaded = currentQueueDepth < 10000;
    const memoryUnderControl = getMemoryUsagePercent() < 90;

    return depsHealthy && queueNotOverloaded && memoryUnderControl;
  },

  onShutdown: async () => {
    await mongo.client.close();
    await redis.quit();
  },
});
```

### Pattern 4: Health Checks via HTTP

The lifecycle automatically starts an HTTP server on port 3000:

```bash
# Health check endpoint
curl http://localhost:3000/health

# Response when healthy (200):
{
  "healthy": true,
  "timestamp": 1708515000000,
  "dependencies": {
    "mongodb": true,
    "rabbitmq": true
  },
  "messagesProcessed": 150000,
  "lastProcessedTime": 2500
}

# Response when unhealthy (503):
{
  "healthy": false,
  "timestamp": 1708515010000,
  "dependencies": {
    "mongodb": false,
    "rabbitmq": true
  },
  "messagesProcessed": 150000,
  "lastProcessedTime": 65000
}
```

## Design Philosophy

### Separation of Concerns

1. **index.ts** - The Recipe
   - What does the service do?
   - Load config
   - Connect to dependencies
   - Start the core business logic
   - Return resources

2. **lifecycle.ts** - The Plumbing
   - How is it managed?
   - Health checks
   - Activity tracking
   - Graceful shutdown
   - Error handling

When you open **index.ts**, you immediately understand the service's purpose. You don't need to know about retries, state management, or shutdown logic.

### Declarative Configuration

Instead of:
```typescript
// Imperative: Tell the computer HOW to do things
const server = http.createServer(healthCheckHandler);
server.listen(3000);
process.on('SIGTERM', async () => {
  await closeConnections();
  server.close();
  process.exit(0);
});
```

You write:
```typescript
// Declarative: Tell the computer WHAT to do
import { defineLifecycle } from '@devvir/service';

const lifecycle = defineLifecycle({
  onShutdown: async () => {
    await closeConnections();
  },
});
```

The framework handles the SIGTERM listener, health check HTTP server, and process exit.

## Best Practices

### 1. Keep index.ts Focused on Business Logic

❌ Don't:
```typescript
// index.ts with all the plumbing
const state = { connections: {} };
const lifecycle = defineLifecycle({
  onInit: async () => {
    // ... 50+ lines of setup
  },
  // ...
});
```

✅ Do:
```typescript
// index.ts - just the recipe
import lifecycle from './lifecycle';

lifecycle.run(async () => {
  const mongo = await connect();
  await startProcessing(mongo);
  return { mongo };
});
```

### 2. Return Resources for Lifecycle Management

The lifecycle needs access to connections for health checks and shutdown:

```typescript
// Good: Return resources so lifecycle can manage them
return { mongo, broker, cache };

// Bad: Keep resources private in index.ts
// lifecycle can't close them on shutdown
```

### 3. Use Dependencies Declaration

```typescript
// Good: Declare once, status tracked automatically
import { defineLifecycle } from '@devvir/service';

const lifecycle = defineLifecycle({
  dependencies: ['mongodb', 'rabbitmq', 'redis'],
  // Health will check all three are initialized
});

// Bad: No declaration, must check manually
isHealthy: () => {
  // ... have to remember to check each one
}
```

### 4. Implement isHealthy When Logic is Complex

```typescript
// Simple case: All dependencies must be up
// Use default (omit isHealthy)
const lifecycle = defineLifecycle({
  dependencies: ['mongodb', 'rabbitmq'],
});

// Complex case: Dependencies + activity + metrics
isHealthy: () => {
  return mongo && broker &&
    (Date.now() - lastActivity < 60000) &&
    queueDepth < MAX_QUEUE;
}
```

### 5. Always Implement onShutdown

Ensure graceful cleanup:

```typescript
onShutdown: async () => {
  if (broker) await broker.disconnect();
  if (mongo?.client) await mongo.client.close();
  if (cache) await cache.quit();
  // Give time for graceful termination
},
```

## Examples

See service implementations for complete examples:
- [Archivist Service](../../../services/archivist/src/) - Consumes from queue, stores to database
- [Codec Service](../../../services/codec/src/) - Transforms messages between formats
- [Feed Service](../../../services/feed/src/) - Streams WebSocket data to broker

## Related Documentation

- [Health Checks](./HEALTHCHECK.md) - Low-level health check API
- [Shutdown Handlers](./SHUTDOWN.md) - Low-level signal handling API
