# Health Check Server Utility

The `startHealthCheckServer` utility provides a minimal HTTP health check server commonly needed for container orchestration platforms (Docker, Kubernetes) and monitoring systems.

## Location

- **Package**: `@devvir/service`
- **Module**: `healthcheck.ts`

## Overview

This utility starts an HTTP server that responds to GET requests at `/health` with JSON responses. It supports optional custom health logic through a callback and optional port configuration.

## API

The function has multiple overload signatures supporting flexible argument combinations:

```typescript
startHealthCheckServer(): HealthCheckService
startHealthCheckServer(onPing: OnPingCallback): HealthCheckService
startHealthCheckServer(port: number): HealthCheckService
startHealthCheckServer(onPing: OnPingCallback, port: number): HealthCheckService
```

### Parameters

Both parameters are optional:

- `onPing` (optional): Callback function to handle custom health check logic
  - Called when a GET request arrives at `/health`
  - Responsible for crafting the entire response (status code, headers, body)
  - Signature: `(req: http.IncomingMessage, res: http.ServerResponse) => void`
  - If not provided, returns generic `{ status: 'Ok' }` response

- `port` (optional): Port number to listen on
  - Type: `number`
  - Default: `3000`
  - When both parameters are provided, `onPing` must come first

### Argument Handling

When passing both arguments, **order matters**: callback first, then port. The function intelligently discriminates arguments:
- `startHealthCheckServer()` → uses default port 3000
- `startHealthCheckServer(3001)` → uses port 3001, no custom callback
- `startHealthCheckServer(onPing)` → uses custom callback on port 3000
- `startHealthCheckServer(onPing, 3001)` → uses custom callback on port 3001

### Return Value

A `HealthCheckService` object with the following methods:

```typescript
interface HealthCheckService {
  /**
   * Get current status of the health check server.
   */
  status(): HealthCheckStatus;

  /**
   * Gracefully close the health check server.
   */
  close(): Promise<void>;
}

interface HealthCheckStatus {
  listening: boolean;
  port: number;
}
```

- `status()`: Returns current server state (listening status and port)
- `close()`: Gracefully shuts down the server, returns a promise that resolves when closed

## Usage

### Basic Usage (No Custom Logic)

```typescript
import { startHealthCheckServer } from '@devvir/service';

// Use default port 3000
const healthCheck = startHealthCheckServer();

// Or specify a custom port
const healthCheck = startHealthCheckServer(3001);

// GET /health returns:
// HTTP 200
// { "status": "Ok" }

// Check server status
console.log(healthCheck.status()); // { listening: true, port: 3000 } or { listening: true, port: 3001 }

// Gracefully close
await healthCheck.close();
```

### With Custom Health Logic

```typescript
import { startHealthCheckServer } from '@devvir/service';

interface ServiceState {
  mongoConnected: boolean;
  brokerConnected: boolean;
  messagesProcessed: number;
}

let serviceState: ServiceState = {
  mongoConnected: false,
  brokerConnected: false,
  messagesProcessed: 0,
};

const healthCheck = startHealthCheckServer((req, res) => {
  const isHealthy = serviceState.mongoConnected && serviceState.brokerConnected;
  const statusCode = isHealthy ? 200 : 503;

  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: isHealthy ? 'healthy' : 'unhealthy',
    mongo: serviceState.mongoConnected,
    broker: serviceState.brokerConnected,
    processed: serviceState.messagesProcessed,
  }));
});

// GET /health now returns custom health data on port 3000
await healthCheck.close(); // Graceful shutdown
```

With custom port:

```typescript
// Custom health logic on port 3001
const healthCheck = startHealthCheckServer((req, res) => {
  // ... custom response logic
}, 3001);
```

### Graceful Shutdown

Always close the health check server during service shutdown:

```typescript
import { startHealthCheckServer, setupShutdownHandlers } from '@devvir/service';

let healthCheck: HealthCheckService | null = null;

const main = async () => {
  healthCheck = startHealthCheckServer();
  // ... rest of service initialization
};

setupShutdownHandlers(async () => {
  if (healthCheck) {
    await healthCheck.close();
  }
  // ... other cleanup
});

main();
```

## Behavior

### Endpoints

| Method | Path   | Response | Status |
|--------|--------|----------|--------|
| GET    | /health | Custom or `{ "status": "Ok" }` | 200 (default) |
| Any    | Other  | Empty    | 404    |

### Custom Callback

When you provide an `onPing` callback, you have full control:
- Determine HTTP status code (200, 503, etc.)
- Set response headers
- Return any JSON body

The callback receives the raw `http.IncomingMessage` and `http.ServerResponse` objects, allowing unlimited customization.

### Logging

- Server start is logged at INFO level with the listening port
- No request-level logging (keep logs clean for health checks)

## Examples

### Example 1: MongoDB + RabbitMQ Health

```typescript
import { startHealthCheckServer } from '@devvir/service';

const getHealthState = () => ({
  mongoConnected: state.mongoConnection !== null,
  brokerConnected: state.broker?.getState() === 'connected',
});

const healthCheck = startHealthCheckServer((req, res) => {
  const health = getHealthState();
  const isHealthy = health.mongoConnected && health.brokerConnected;

  res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(health));
});
```

### Example 2: Bidirectional Activity Check

```typescript
const healthCheck = startHealthCheckServer((req, res) => {
  const timeSinceLastMessage = Date.now() - lastMessageTime;
  const isHealthy = timeSinceLastMessage < 30000; // 30 second threshold

  res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: isHealthy ? 'healthy' : 'stale',
    lastActivity: timeSinceLastMessage,
  }));
});
```

## Design Notes

### Service Handle API

This utility returns a `HealthCheckService` object with explicit methods, not the underlying `http.Server` object. This:
- Prevents accidental direct manipulation of the server
- Makes the contract explicit: "I run the server; use these methods to interact with it"
- Provides introspection via `status()` if needed for debugging
- Simplifies maintenance and future changes

## Common Patterns

### Pattern: Conditional Health Based on Metrics

```typescript
const healthCheck = startHealthCheckServer((req, res) => {
  const cpuUsage = process.cpuUsage();
  const memUsage = process.memoryUsage();
  const isHealthy = memUsage.heapUsed / memUsage.heapTotal < 0.85;

  res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    healthy: isHealthy,
    memory: {
      heapUsedPercent: ((memUsage.heapUsed / memUsage.heapTotal) * 100).toFixed(2),
    },
  }));
});
```

### Pattern: Simple Service State

```typescript
const getHealthState = (): HealthState => ({
  mongoConnected: state.mongoConnection !== null,
  mqConnected: state.broker?.getState() === 'connected',
  messagesPublished: state.messagesPublished,
  lastPublishedTime: state.lastPublishedTime,
});

const healthCheck = startHealthCheckServer((req, res) => {
  const health = getHealthState();
  const isHealthy = health.mongoConnected && health.mqConnected;

  res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(health));
});
```

## Troubleshooting

### "Health check server listening" not logged

The server must have successfully bound to port 3000. Check:
- No other process is using port 3000
- Service has permissions to bind to port 3000
- Service initialization completes without errors

### Connection refused when testing

```bash
curl http://localhost:3000/health
```

Ensure:
- Service is running
- Port 3000 is not blocked by firewall
- You're testing from the correct machine/container
