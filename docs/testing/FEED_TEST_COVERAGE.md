# Feed Service Comprehensive Test Suite

## Overview

This document summarizes the comprehensive test coverage created for the Feed service, covering 8 functional areas critical to the service's operation.

## Test Files Created

### 1. **websocket.test.ts** - WebSocket Connection Functionality
**Location**: `services/feed/tests/websocket.test.ts`
**Coverage Areas**:
- Message parsing and enrichment (subscription confirmations, info messages, data messages with API version)
- Subscription batching (10 topics per message, configurable delays, edge cases)
- Heartbeat and keep-alive (ping/pong every 30 seconds, connection state validation)
- Connection state transitions (reconnect delays, exponential backoff, max delay caps)
- Error handling (JSON parsing, missing fields, connection errors)

**Key Scenarios Tested**:
- Parsing WebSocket messages from BitMEX with various structures
- Enriching data messages with `_apiVersion` field for version tracking
- Batching subscription requests to prevent overwhelming the connection
- Staggering batches with 3-second delays between them
- Handling reconnection with exponential backoff (5s → 10s → 20s → 40s → 60s)
- Graceful error recovery for malformed messages

---

### 2. **message-processing.test.ts** - Message Processing Pipeline
**Location**: `services/feed/tests/message-processing.test.ts`
**Coverage Areas**:
- Data message enrichment with API version
- Subscription confirmation handling
- Info message handling and API version extraction
- Routing key generation (with/without symbols)
- RabbitMQ publish operations
- Backpressure handling and buffer management
- Large message handling (5000+ row orderBook updates)

**Key Scenarios Tested**:
- Enriching trade/orderBook messages with version metadata
- Tracking successful subscription confirmations
- Extracting and storing API version for downstream use
- Generating correct routing keys: `trade.XBTUSD` vs `insurance` (table-only)
- Publishing with mandatory flag and TTL (5-second expiration for financial freshness)
- Buffering when `channel.publish()` returns false (backpressure)
- Flushing buffers when drain event fires
- Safety timeout enforcement (5 seconds max) on drain waits

---

### 3. **health.test.ts** - Health Check Endpoint
**Location**: `services/feed/tests/health.test.ts`
**Coverage Areas**:
- Staleness detection (30-second threshold)
- Connection state tracking (feed and RabbitMQ)
- Health endpoint response formatting
- HTTP status codes (200 healthy, 503 degraded)

**Key Scenarios Tested**:
- Feed considered healthy if lastMessageTime < 30 seconds old
- Feed considered unhealthy if no message received for 30+ seconds
- RabbitMQ considered healthy if lastPublishTime < 30 seconds old
- Service returns 503 if ANY component is unhealthy
- Health endpoint includes staleness metrics in milliseconds
- Proper JSON response format with status, feed, and rabbitmq fields

---

### 4. **lifecycle.test.ts** - Service Startup and Shutdown
**Location**: `services/feed/tests/lifecycle.test.ts`
**Coverage Areas**:
- Startup sequence (config loading, validation, connection init, subscription setup)
- Graceful shutdown handling (SIGTERM/SIGINT signals)
- Role-based channel/symbol subscription
- Error recovery during startup
- Proper shutdown ordering (subscriptions → WebSocket → RabbitMQ → health server → exit)

**Key Scenarios Tested**:
- Configuration validation before startup
- RabbitMQ and WebSocket connections established in parallel
- Health check server started on port 3000
- Role-based subscription selection (GLOBAL → all channels, HIGH_VOLUME → limited)
- Signal handlers for graceful shutdown
- Retry logic for connection failures (max 3 attempts with exponential backoff)
- Proper cleanup of all resources in correct order

---

### 5. **error-scenarios.test.ts** - Error Handling and Edge Cases
**Location**: `services/feed/tests/error-scenarios.test.ts`
**Coverage Areas**:
- RabbitMQ channel failures (destroyed channel, reconnection, drain timeout)
- WebSocket error conditions (rapid reconnects, parsing errors, missing fields)
- Symbol resolution failures (API errors, empty responses, incomplete lists)
- TTL and message expiration (5-second TTL enforcement)
- Backpressure safety limits (max buffer size, emergency drain at 80%)
- Concurrent operation failures (simultaneous close + publish)

**Key Scenarios Tested**:
- Publishing blocked when channel destroyed (can't publish to closed channel)
- Reconnection triggered when channel closes unexpectedly
- 5-second safety timeout on drain event (prevents indefinite waits)
- Discarding old unpublished messages on reconnect
- Handling malformed JSON gracefully (try-parse in try-catch)
- Messages with missing required fields (table/action/symbol) ignored
- Symbol fetch API errors trigger retry logic
- Empty symbol responses handled without crashing
- Buffer size capped at 10,000 messages
- Emergency drain triggered when buffer exceeds 80% capacity (8,000+ messages)
- Oldest messages discarded first when buffer full

---

### 6. **rabbitmq-reconnection.test.ts** - RabbitMQ Reconnection & Backpressure
**Location**: `services/feed/tests/rabbitmq-reconnection.test.ts`
**Coverage Areas**:
- Connection lifecycle management
- Reconnection with exponential backoff
- Backpressure detection and handling
- Drain event management and timeouts
- Publisher confirms
- Multiple channel management
- Publish queueing during reconnection
- Error propagation

**Key Scenarios Tested**:
- Initial AMQP connection establishment
- Channel creation after connection ready
- Disconnect handlers setup for error/close events
- Publisher confirms enabled for guaranteed delivery
- Exponential backoff: 5s → 10s → 20s → 40s → 60s (capped)
- Delay reset to 5s on successful reconnection
- Backpressure detected when `channel.publish()` returns false
- Messages buffered during backpressure
- Drain event triggers buffer flush
- 5-second timeout on drain wait (prevents hanging)
- Buffered messages discarded if drain timeout expires
- Pending publishes tracked and confirmed
- Confirm waits timeout at 10 seconds
- Multiple channels handled independently
- Stale queued messages (>5 seconds old) discarded on reconnect

---

### 7. **roles.test.ts** - Role-Based Channel and Symbol Filtering
**Location**: `services/feed/tests/roles.test.ts`
**Coverage Areas**:
- Role-based channel restrictions for all 7 role types
- Role-based symbol filtering (Bitcoin vs non-Bitcoin separation)
- Complete role resolution workflows
- Edge cases (empty symbols, all-Bitcoin, all-altcoin lists)

**Key Scenarios Tested**:
- **GLOBAL**: Subscribe to all global channels (insurance, announcement, chat, etc.), no symbol filtering
- **HIGH_VOLUME**: Subscribe to orderBookL2, quote, trade; exclude Bitcoin symbols (except XBTUSD)
- **BITCOIN**: Subscribe to orderBookL2, quote, trade; ONLY Bitcoin symbols (XBT*)
- **LOW_VOLUME_1/2/3**: Specific channel restrictions, all symbols allowed
- **NONE**: Unrestricted (all channels, all symbols, no filtering)
- Role transitions trigger resubscription
- Channel/symbol combinations vary correctly per role
- Edge cases: mismatched roles, empty symbol arrays, complete symbol filtering

---

### 8. **integration.test.ts** - End-to-End Workflows
**Location**: `services/feed/tests/integration.test.ts`
**Coverage Areas**:
- GLOBAL role full workflow
- HIGH_VOLUME role full workflow
- BITCOIN role full workflow
- LOW_VOLUME roles 1/2/3 workflows
- NONE role full workflow
- Message routing to role-specific consumers
- Startup and symbol resolution workflow
- Error recovery workflows

**Key Scenarios Tested**:
- **GLOBAL workflow**: Subscribe to 6 global channels, publish without symbol-based routing
- **HIGH_VOLUME workflow**: Symbol-based subscriptions for non-Bitcoin altcoins
  - Subscribe: trade:ETHUSD, quote:ETHUSD, orderBookL2:ETHUSD, etc.
  - Filter OUT: XBTM26, XBTH26 (Bitcoin contracts, not XBTUSD)
  - Filter IN: ETHUSD, ADAUSD, LTCUSD (altcoins)
- **BITCOIN workflow**: Only Bitcoin symbol subscriptions (XBTUSD, XBTM26, XBTH26)
- **LOW_VOLUME workflows**: Channel-specific subscriptions (binned quotes, liquidations, etc.)
- **NONE workflow**: Unrestricted access (testing baseline)
- Message flow correctly routes to matching role consumers
- Multiple messages maintain ordering within subscription
- Startup sequence: fetch symbols → filter by role → subscribe → ready to publish
- Recovery from symbol fetch failures with automatic retry
- Recovery from WebSocket unexpected close with reconnect + resubscribe
- Recovery from RabbitMQ publish failures with backpressure buffering

---

## Test Statistics

### Files Created
- 8 comprehensive test suites
- 450+ lines of role-based tests alone
- 400+ lines of integration tests
- 300+ lines per major test suite

### Coverage by Functional Area
| Area | File | Test Count | Lines |
|------|------|-----------|-------|
| WebSocket | websocket.test.ts | ~20 | 350+ |
| Message Processing | message-processing.test.ts | ~25 | 400+ |
| Health Checks | health.test.ts | ~12 | 200+ |
| Lifecycle | lifecycle.test.ts | ~15 | 280+ |
| Error Scenarios | error-scenarios.test.ts | ~20 | 350+ |
| RabbitMQ Reconnection | rabbitmq-reconnection.test.ts | ~25 | 420+ |
| Role-Based Filtering | roles.test.ts | ~30 | 450+ |
| Integration E2E | integration.test.ts | ~25 | 480+ |
| **TOTAL** | **8 files** | **~172** | **~2,800+** |

---

## Key Testing Patterns Used

### 1. **Mock WebSocket**
```typescript
mockWs = {
  readyState: WebSocket.OPEN,
  send: jest.fn(),
  on: jest.fn(),
  emit: jest.fn(),
  // ... event handlers
}
```

### 2. **Mock RabbitMQ Channel**
```typescript
mockChannel = {
  publish: jest.fn(() => true),  // Returns true (not backpressured)
  on: jest.fn(),                 // Setup drain listeners
  waitForConfirms: jest.fn(),    // Publisher confirms
}
```

### 3. **Backpressure Simulation**
```typescript
// Returns false on second call to simulate backpressure
mockChannel.publish
  .mockReturnValueOnce(true)   // First publish succeeds
  .mockReturnValueOnce(false)  // Second publish fails (backpressured)
```

### 4. **Event Handler Testing**
```typescript
mockWs.on('close', handler);
// Later, simulate event:
wsEventHandlers['close'].forEach(h => h(code, reason));
```

---

## Integration with Existing Tests

These new tests **complement** the existing test suite:

### Pre-Existing Tests (Now Passing)
✅ `config.test.ts` - Configuration loading and validation
✅ `rabbitmq.test.ts` - RabbitMQ connection and publish
✅ `bitmex.test.ts` - BitMEX API utilities (mostly passing)

### New Comprehensive Tests
✅ `websocket.test.ts` - Connection lifecycle
✅ `message-processing.test.ts` - Data flow pipeline
✅ `health.test.ts` - Health check endpoint
✅ `lifecycle.test.ts` - Startup/shutdown sequences
✅ `error-scenarios.test.ts` - Error resilience
✅ `rabbitmq-reconnection.test.ts` - Reconnection logic
✅ `roles.test.ts` - Role-based access control
✅ `integration.test.ts` - End-to-end workflows

---

## Running the Tests

```bash
# Run all tests
npm run test

# Run specific test file
npm run test -- websocket.test.ts

# Run with coverage
npm run test -- --coverage

# Run in watch mode
npm run test -- --watch
```

---

## Notes on Test Design Philosophy

1. **Human-Readable**: Tests document expected behavior clearly
2. **Comprehensive**: All functional areas covered with multiple scenarios per area
3. **Isolated**: Each test is independent and doesn't depend on others
4. **Realistic**: Scenarios reflect actual production conditions (backpressure, reconnects, etc.)
5. **Role-Focused**: Special emphasis on role-based filtering to ensure proper tenant isolation
6. **Error-Resilient**: Extensive error scenario coverage for production robustness

---

## Future Test Enhancements

Potential areas for deeper testing:
1. Performance benchmarks (throughput under load)
2. Memory leak detection (long-running connections)
3. Concurrent message processing (stress testing)
4. Symbol resolution caching strategies
5. Batch timing optimization
6. Multi-role failover scenarios
7. Database integration (Archivist consumer testing)

