# Bitmex Module: Architecture & Strategic Motivation (In Development)

**Status:** The services described below (Snapshots, Bitmex-WS) are currently disabled/in development and are not part of the active system. This document describes aspirational architecture for a future BitMEX integration module.

## Overview

When completed, the Bitmex module will provide a replacement for direct BitMEX WebSocket connections. It provides:

1. **A BitMEX-compatible WebSocket server** that clients can connect to identically to BitMEX's official API
2. **State aggregation** for delta-based channels (orderBookL2, quotes) into snapshots
3. **Flexible data sources** that can operate at any speed: real-time, accelerated for testing, or from historical databases

## Strategic Motivation

The module serves two strategic purposes:

### 1. Real-Time Market Monitoring (Current)

Clients connect to the Bitmex-WS service instead of BitMEX directly. Data flows at real-time speed through internal services (Feed → Snapshots → Bitmex-WS → Clients).

**Benefits:**
- Centralized data collection (single Feed instance serving many clients)
- Data persisted to MongoDB via Archivist for historical analysis
- Snapshots service provides pre-aggregated market state
- Transparent: clients experience identical API to BitMEX

### 2. Accelerated Testing & Backtesting (Future)

Future modules (backtesting suite) will feed historical data through the same internal pipeline, but at custom speeds (6 months of data streamed in hours).

**Why this matters:**
- **Test strategies on real historical data** without stale mocks or simulations
- **Control data speed** to test strategy performance under different market conditions
- **Identical client interface** means strategies developed on accelerated data work unchanged in production
- **Isolation from external API** means testing doesn't depend on BitMEX availability

**Example flow:**
```
Historical Database → Feed (simulated, 10x speed) → Snapshots → Bitmex-WS → Client Strategy
```

The client strategy sees the same WebSocket API and message flow as in production, but market data is delivered at 10x speed.

## Architecture

### Three-Tier Data Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                   DATA SOURCE ABSTRACTION TIER                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Real-Time:        Accelerated:         Historical:             │
│  BitMEX API        Database + Replayer  Database                 │
│                                                                 │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         v
┌─────────────────────────────────────────────────────────────────┐
│                   FEED SERVICE (Data Normalization)              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Publishes to: bitmex-data (topic exchange)                     │
│                                                                 │
└────────────────────────┬────────────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┬──────────────┐
          │                             │              │
          v                             v              v
    ┌──────────────┐           ┌──────────────┐  ┌──────────────┐
    │ Snapshots    │           │ Archivist    │  │ Consumers    │
    │ (selective   │           │ (all data)   │  │ (real-time   │
    │  binding)    │           │              │  │  monitoring) │
    └──────┬───────┘           └──────────────┘  └──────────────┘
           │
           v
    ┌──────────────────────────┐
    │ bitmex-snapshots         │
    │ (topic exchange)         │
    └──────┬───────────────────┘
           │
           v
    ┌──────────────────────────┐
    │ Bitmex-WS (WebSocket)    │
    │ (subscribes to snapshots)│
    │ (subscribes to deltas)   │
    └──────┬───────────────────┘
           │
           v
    ┌──────────────────────────┐
    │ Client Applications      │
    │ (bots, UI, backtests)    │
    └──────────────────────────┘
```

### Service Responsibilities

#### Feed Service

**Role:** Data acquisition and normalization

**Current implementation:** The feed service (active) connects to BitMEX WebSocket, maintains subscriptions, and publishes to RabbitMQ for consumption by codec and archivist services

**Future flexibility:** Could be replaced with:
- Database replay service (for backtesting)
- Simulated market data generator
- Integration with other exchanges
- Any source that emits messages in the same format

**Key:** The downstream services (Snapshots, Archivist, Bitmex-WS) are agnostic to where data comes from.

#### Snapshots Service (Python)

**Role:** State aggregation for delta-based channels

**Responsibility:**
- Consume selective feed messages (only aggregation-needed channels)
- Maintain in-memory snapshots per channel:symbol
- Apply deltas idempotently
- Publish snapshots to bitmex-snapshots exchange

**Why separate service:**
- Handles the complexity of delta aggregation
- Runs independently of client connections
- Provides "current state" for fresh connections
- Can scale horizontally (multiple instances maintain independent caches)

#### Bitmex-WS Service (Node.js)

**Role:** Client interface and real-time delivery

**Responsibility:**
- Listen for WebSocket client connections
- Manage client subscriptions
- Serve snapshots on subscription
- Broadcast deltas in real-time
- Provide identical API to BitMEX

**Why separate service:**
- Handles thousands of concurrent client connections
- Node.js async/event-loop model ideal for WebSocket multiplexing
- Decoupled from snapshot generation (doesn't block on aggregation)
- Can scale horizontally (clients distribute across instances)

## Key Design Decisions

### 1. Snapshots Service Filters at Binding

Snapshots service only binds to queues for channels that need aggregation:
- `orderBookL2:*`
- `quote:*`
- `quoteBin*:*`

Non-aggregated channels (`trade`, `liquidation`, etc.) flow directly through bitmex-data exchange to Bitmex-WS, reducing latency.

**Implication:** Snapshots service is lightweight—only processes aggregation-needed channels.

### 2. Snapshot Cache in Memory

Bitmex-WS maintains snapshots in memory (no database queries on subscription).

**Rationale:**
- Microsecond latency for snapshot lookup
- Snapshot data grows slowly (one per channel:symbol pair)
- Typical memory footprint: 10s-100s of MB
- On restart, Snapshots service republishes snapshots

### 3. Eventual Consistency, No Total Order

If messages arrive out of order:
- Snapshots service applies deltas idempotently and corrects itself
- Bitmex-WS serves latest known snapshot (may be slightly stale vs. real-time)

**Acceptable because:**
- Market data is high-frequency; next message arrives within milliseconds
- Out-of-order arrivals happen only during queue backlog or network hiccups (rare in production)
- Clients see "most recent known state" which is sufficient for trading algorithms

### 4. Fire-and-Forget Delta Broadcasting

Bitmex-WS broadcasts deltas to clients without retry or persistence.

**Implication:**
- If a client's WebSocket buffer is full, deltas are dropped
- Client sees gaps but continues receiving future deltas
- Matches BitMEX WebSocket behavior (not a reliable messaging service)

**Acceptable because:**
- Delta loss is detected by client applications (sequence numbers, etc.)
- Next snapshot or delta corrects any inconsistency
- Real NetMEX WebSocket also drops on buffer overflow

### 5. One Feed Service, One Snapshots Service, Many Bitmex-WS Instances

Horizontal scaling strategy:

- **Feed:** Single instance (one connection to BitMEX minimizes rate-limit risk)
- **Snapshots:** Single instance (maintains global snapshot cache; very cheap computationally)
- **Bitmex-WS:** Multiple instances (distribute client connections for throughput)

Clients can load-balance across Bitmex-WS instances transparently.

## Data Format Contracts

### Feed → Snapshots-data Exchange

**Routing key:** `{channel}:{symbol}`

**Message format:**
```json
{
  "table": "orderBookL2",
  "symbol": "XBTUSD",
  "action": "insert|update|delete|snapshot",
  "data": [
    { "id": 8799467, "side": "Buy", "price": 52000, "size": 1000 }
  ],
  "timestamp": "2026-02-14T12:00:00.000Z"
}
```

### Snapshots → Bitmex-snapshots Exchange

**Routing key:** `snapshot:{channel}:{symbol}`

**Message format:**
```json
{
  "table": "orderBookL2",
  "symbol": "XBTUSD",
  "action": "snapshot",
  "data": [
    { "id": 8799467, "side": "Buy", "price": 52000, "size": 1000 },
    { "id": 8799468, "side": "Sell", "price": 52001, "size": 500 }
  ],
  "_snapshotId": "uuid",
  "_processedAt": "2026-02-14T12:00:01.000Z"
}
```

## Extension Points for Future Modules

### Backtesting Module

When a future backtesting module is added, it will:
1. Replace Feed with a **Historical Data Replayer** that reads from DB at custom speed
2. Connect to Snapshots and Bitmex-WS as usual (no changes needed)
3. Subscribe to Bitmex-WS WebSocket identically to production

The backtesting strategy code is identical to production code—only the data source speed changes.

### Multiple Data Sources

If in future we want to subscribe to multiple exchanges:
- Add a second Feed instance (e.g., feed-bybit, feed-okex)
- Have a separate Snapshots service per exchange if needed
- Route clients to the appropriate Bitmex-WS instance per exchange

No refactoring of existing services needed—just composition changes.

## Testing Strategy

Each service is self-contained and testable:

1. **Feed:** Test connection to BitMEX, message parsing, publishing
2. **Snapshots:** Test delta aggregation logic, deduplication, snapshot publishing
3. **Bitmex-WS:** Test client connections, subscriptions, broadcasting

Integration tests validate end-to-end flow with mock RabbitMQ and test data.

## Deployment

### Docker Compose

All three services are defined in docker compose with:
- Service dependencies (Feed → Snapshots → Bitmex-WS)
- Environment variable configuration
- Health check endpoints
- Restart policies

### Environment Variables

No hardcoded dependencies. Each service reads:
- Connection strings (RabbitMQ URL)
- Configuration (channels, symbols, ports)
- Operational parameters (timeouts, batch sizes, log levels)

From `.env` file or environment at runtime.

## Conclusion

The Bitmex module architecture separates concerns while enabling data-source abstraction. By operating independently from the data source (BitMEX, historical DB, simulator), the system can serve multiple use cases:

- **Production:** Real-time monitoring with live BitMEX data
- **Testing:** Accelerated historical data for strategy validation
- **Simulation:** Synthetic data for chaos testing or market mocking

All with identical client-facing interfaces, maximizing code reuse and minimizing friction for strategy developers.
