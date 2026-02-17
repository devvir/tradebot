# Feed Service

## Overview

The Feed service is a WebSocket client that connects to BitMEX's real-time market data feed, maintains subscriptions to specified channels and trading symbols, and publishes incoming data to a RabbitMQ message queue for downstream consumption.

The Feed service is a **foundational, multi-consumer hub** designed to be reused across the entire application. Rather than having dozens of independent services directly connected to BitMEX (risking rate-limiting and resource exhaustion), the Feed acts as a single, battle-tested connection that thousands of consumers can leverage transparently. It handles all complexity—reconnection, rate-limiting, symbol/channel resolution—once, encapsulating a solid horizontal scaling strategy that consumers can rely on without thought.

Internally, Feed publishes to a topic exchange with channel and symbol in the routing key, allowing each downstream consumer to bind selectively: the Archivist captures everything, a UI service captures only trades and quotes, an analytics worker captures order book snapshots, a future indicator service captures binned data—all from the same Feed instance, all without code changes to Feed itself.

## Extended Definition

### What It Does

The Feed service provides a self-contained data acquisition capability:

1. **Discovers Available Symbols**
   - Calls the BitMEX HTTP API to fetch active trading instruments
   - Filters symbols by user-provided patterns (glob-style: `*`, `?`)
   - Pre-filters by role assignment (HIGH_VOLUME gets non-Bitcoin, BITCOIN gets Bitcoin-only, etc.)
   - Returns the symbol list this service instance is responsible for handling

2. **Resolves Channels to Subscriptions**
   - Loads user-configured channel patterns (e.g., `trade`, `orderBook*`)
   - Resolves concrete channel names by matching patterns against BitMEX's known channels
   - Pre-filters by role assignment (different roles handle different channel sets)
   - Determines which channels require symbol subscription and which are global

3. **Builds and Manages WebSocket Connection**
   - Connects to BitMEX's WebSocket endpoint (live or testnet)
   - Batches subscription requests to avoid URL length limits
   - Subscribes to `channel:symbol` topics (e.g., `trade:XBTUSD`, `orderBookL2:ETHUSD`) and global channels (e.g., `insurance`, `announcement`)
   - Sends periodic pings to maintain connection liveliness
   - Handles receipt of pings and pongs (WebSocket keep-alive handshake)

4. **Publishes to Message Queue**
   - For each message received from BitMEX, extracts metadata (table, action, timestamp, API version)
   - Publishes the enriched message to RabbitMQ's `bitmex-data` topic exchange
   - Sets message TTL based on configuration to prevent unbounded queue growth
   - Handles backpressure (waits if the queue is full)
   - Gracefully degrades on queue unavailability (logs and continues)

5. **Handles Reconnection**
   - On WebSocket close, schedules automatic reconnection
   - Uses exponential backoff (configurable cap on retry delay)
   - Clears subscriptions on reconnect and resubscribes from scratch
   - Restarts the heartbeat (pings) on successful reconnection

6. **Provides Observability**
   - Exposes a health check endpoint reporting connection status
   - Tracks last message received time (used to detect stalled connections)
   - Logs connection events, subscriptions, batching, and errors

### Design Philosophy

The Feed embodies these principles:

- **Centralized gateway**: A single Feed connection serves all downstream consumers, eliminating per-consumer connection overhead and rate-limit risk to BitMEX. One service solves the hard problem; everyone else benefits.
- **Stateless data flow**: The service doesn't buffer, order, or validate data. It receives from BitMEX and publishes to RabbitMQ immediately.
- **Consumer autonomy via routing**: Data is published to a topic exchange with channel and symbol in the routing key. Each consumer binds to the patterns it cares about, with no coordination between consumers and no changes to Feed code.
- **Tolerant of queue unavailability**: If RabbitMQ is down or backpressured, the service doesn't fail; it degrades gracefully and continues consuming from BitMEX.
- **Automatic healing**: On disconnection, the service automatically reconnects. In containerized environments, this is often sufficient; there's no need for external restart policies.
- **Role-based multi-instance**: Multiple Feed instances can run with different roles, each handling a subset of channels and symbols, enabling horizontal scaling without replication complexity.

### Symbol and Channel Resolution

The Feed uses a **pattern-matching** system to determine what data to subscribe to:

#### Symbol Resolution

**Patterns:** Glob-style patterns in `FEED_SYMBOLS` env var, e.g., `XBTUSD,*USD,BTC*`

**Process:**
1. Fetch all active instruments from BitMEX API
2. Extract symbol field from each instrument
3. Filter by user patterns (e.g., `*USD` matches `XBTUSD`, `ETHUSD`, `*USD`, etc.)
4. Apply role-based filtering:
   - `HIGH_VOLUME`: Symbols NOT starting with `XBT` (Bitcoin-specific)
   - `BITCOIN`: Symbols starting with `XBT` only
   - Other roles: All symbols (no filtering)

**Why patterns?** User typically can't enumerate all symbols; there are hundreds. Patterns allow concise, flexible specification.

**Why role-based filtering?** Allows horizontal scaling: run one instance for high-volume (altcoins), one for Bitcoin. Prevents duplicate subscriptions across instances if using a shared pattern.

#### Channel Resolution

**Patterns:** Glob-style patterns in `FEED_CHANNELS` env var

**Process:**
1. From `channels.ts`, load the list of known BitMEX channels
2. Filter channels by user patterns
3. Apply role-based filtering:
   - `GLOBAL`: Only global channels (insurance, announcement, etc.)
   - `LOW_VOLUME_1`: Lower-volume binned quotes
   - `LOW_VOLUME_2`: Lower-volume binned trades
   - `LOW_VOLUME_3`: Liquidation, funding, settlement
   - `HIGH_VOLUME`: orderBookL2, quote, trade (highest-volume streaming channels)
   - `BITCOIN`: Same as HIGH_VOLUME (role is determined by symbol filtering)
   - `NONE`: All channels

**Why segregate by role?** High-volume channels produce vastly more messages per second. By running multiple Feed instances with different roles, each can handle its throughput independently.

#### Subscription Topics

For each resolved channel and symbol pair, the service builds a subscription topic:

**Symbol-required channels:**
- `trade` + `XBTUSD` → `trade:XBTUSD`
- `trade` + `ETHUSD` → `trade:ETHUSD`
- `orderBookL2` + `XBTUSD` → `orderBookL2:XBTUSD`
- etc.

**Global channels (no symbol):**
- `insurance` → `insurance`
- `announcement` → `announcement`
- `chat` → `chat`
- etc.

**Total topic count:** (symbol-required channels × resolved symbols) + (global channels)

Example: If resolving to 50 symbols and 6 symbol-required channels plus 5 global channels = (6 × 50) + 5 = 305 topics.

## Technical Details

### Service Lifecycle

**Startup sequence:**
1. Load configuration from environment
2. Store original channel and symbol patterns
3. Validate configuration (required fields, sensible ranges)
4. Resolve channels by pattern and role
5. Fetch symbols from BitMEX API—if failure, exit (symbols are required)
6. Build subscription topics from resolved channels and symbols
7. Connect to RabbitMQ with retry logic (up to 10 retries, 3-second intervals)
8. Store channel and connection reference
9. Initiate BitMEX WebSocket connection
10. Initialize health check endpoint
11. Service is now active

This ordering is deliberate: configuration must be valid, symbols must be available, and RabbitMQ must be ready before attempting WebSocket connection. If any step fails, the service exits with an error code.

**Graceful shutdown:**
- On `SIGTERM` or `SIGINT`, set `isShuttingDown` flag
- Close WebSocket (if open)
- Close RabbitMQ channel
- Close RabbitMQ connection
- Exit cleanly

### Core Functions

#### `fetchAllSymbols(patterns, role)`

Fetches and filters symbols from BitMEX's HTTP API.

**Implementation:**
- Makes HTTPS GET request to `https://www.bitmex.com/api/v1/instrument/active`
- Parses JSON response to extract symbols
- Filters by glob patterns
- Applies role-based filtering (role-specific symbol sets)
- Logs count of resolved symbols

**Error handling:**
- Network errors: Thrown and propagated (service will crash)
- Parse errors: Thrown and propagated

**Why required at startup?** The symbol list can change (new instruments added, old ones delisted). Fetching at startup ensures current data. If the service is long-running and the symbol set changes, a manual restart is required to pick up new symbols.

**Why optional filtering by role?** HIGH_VOLUME and BITCOIN roles have pre-defined symbol sets to enable horizontal scaling and avoid redundant subscriptions. A multi-instance deployment can divide the symbol space.

#### `buildSubscriptionTopics(channels, symbols)`

Builds the concrete list of subscription topics from abstract channels and symbols.

**Process:**
1. For each channel:
   - If it's a symbol-required channel (in `SYMBOL_REQUIRED_CHANNELS`):
     - Append each symbol: `${channel}:${symbol}`
   - Else (global channel):
     - Append the channel name as-is (no symbol suffix)

**Output:** Array of topic strings like `['trade:XBTUSD', 'trade:ETHUSD', 'insurance', 'announcement']`

#### `globToRegex(pattern)` and `matchesPatterns(symbol, patterns)`

Converts glob patterns to regex and performs matching.

**Pattern syntax:**
- `*` = 0 or more characters
- `?` = exactly 1 character
- Literal characters match as-is

**Examples:**
- `*USD` matches `XBTUSD`, `ETHUSD`, `USD` (0 chars before USD), but NOT `XBTUSDM`
- `XBT*` matches `XBTUSD`, `XBTUSDM`, but NOT `XBT` (trailing `*` requires 0+ chars after)
- `XBT?` matches `XBTA`, `XBTB`, etc., but NOT `XBTUSD` (? matches exactly 1 char)

**Why custom glob, not regex?** Users provide patterns in a friendly glob syntax. Regex would be harder to read. The function converts glob to regex internally.

#### `connectBitMEX()`

Establishes and manages the WebSocket connection.

**Flow:**
1. Check `isShuttingDown`; return if true (don't reconnect during shutdown)
2. Create new WebSocket to `config.bitmexWsUrl`
3. On open event:
   - Log connection success
   - Reset reconnect delay
   - Update last message time
   - Build subscription topics
   - Batch topics and send subscriptions in waves (see batching strategy below)
   - Start heartbeat (ping every 30 seconds)
4. On message event:
   - Update last message time
   - Parse JSON
   - Handle subscription confirmations (ignore)
   - Handle info messages (capture API version if present)
   - Handle data messages (extract metadata, publish to RabbitMQ)
5. On ping event:
   - Log receipt
   - Send pong (WebSocket keep-alive)
6. On pong event:
   - Log receipt
7. On error event:
   - Log error details (message, stack)
8. On close event:
   - Log close code and reason
   - Clear ping interval
   - If not shutting down, schedule reconnection

**Subscription batching strategy:**

BitMEX has limits on the number of subscriptions per message (URL length, message size). The service avoids hitting these limits by breaking subscriptions into batches:

- Batches of `config.batchSizeChannels` topics per publish message
- Delay between batches: `config.batchDelayMs` (typically 50-100ms per batch)
- Spread batches over time to avoid overwhelming the server

Example: 300 topics, batch size 50, delay 50ms:
- Time 0ms: Send topics 0-49
- Time 50ms: Send topics 50-99
- Time 100ms: Send topics 100-149
- ... etc.

**Why stagger?** Prevents:
- Single message that's too large
- Overwhelming the server with too many subscriptions at once
- Connection timeout or rate limiting

#### `publishToQueue(channel, data, ttlMs)`

Publishes an enriched message to RabbitMQ.

**Routing key strategy:**
- If the message has a `symbol` field: routing key is `${table}.${symbol}` (e.g., `trade.XBTUSD`)
- Otherwise: routing key is just `${table}` (e.g., `insurance`, `announcement`)

This allows consumers to bind selectively:
- Bind to `trade.#` to get all trades regardless of symbol
- Bind to `#.XBTUSD` to get all data for Bitcoin
- Bind to `#` to get everything (catch-all)

**Process:**
1. Check if channel is valid and connection is intact (defensive check)
2. Determine routing key (channel + symbol if present)
3. Serialize message to JSON
4. Set message options (persistent, TTL if configured)
5. Publish to exchange `bitmex-data` with the computed routing key
6. If publish returns false (buffer full), wait for drain event
7. On drain (or timeout after 5 seconds), continue

**Backpressure handling:**
- RabbitMQ's `publish()` method returns false if the internal buffer is full
- Service awaits a `drain` event before continuing
- Drain event fires when the buffer is flushed (ACKs received from consumers or broker)
- A 5-second safety timeout prevents indefinite waiting

**Why wait for drain?** Don't send too fast to RabbitMQ; respect its buffering limits. If we send too fast, we'll accumulate messages in memory and potentially run out of memory.

**TTL handling:**
- If `messageTtlMs` is configured, set `expiration` on the message
- Messages older than TTL are automatically discarded by RabbitMQ
- Prevents unbounded queue growth if consumers are slow or down

#### `getHealthState()`

Returns current connection health metrics.

**Fields:**
- `wsConnected`: Boolean, true if WebSocket is connected and in OPEN state
- `lastMessage`: Milliseconds elapsed since the most recent message received (returned in the health response; used to detect staleness)

**Use case:** Operators can query this endpoint to confirm the service is receiving data. The endpoint returns HTTP 200 if the WebSocket is connected and received a message within the last 30 seconds; otherwise returns 503. If `lastMessage` is very large (many seconds), the connection may be dead, stalled, or the feed may be idle.

#### Reconnection Logic

On WebSocket close or error:
1. Clear ping interval
2. If `isShuttingDown`, return (don't reconnect during shutdown)
3. Schedule reconnect after `reconnectDelay`
4. On reconnect, double the delay (exponential backoff) up to `maxReconnectDelayMs`
5. Attempt connection; if successful, reset delay to initial value
6. If failure, schedule another reconnect

**Example backoff sequence:** 5s, 10s, 20s, 40s, 60s, 60s, 60s (capped at 60s)

**Why exponential backoff?** If BitMEX is down, hammering it with connection attempts is wasteful and might trigger rate limiting. Backing off gives BitMEX time to recover and reduces load on the network.

### Data Flow Through the System

```
BitMEX WebSocket Message (JSON)
    ↓
Parse JSON
    ↓
Is subscription confirmation? → Log and return (no-op)
Is info message? → Capture API version if present, return
    ↓
Is data message (has table and action)?
    ↓
Enrich with _apiVersion (captured from earlier info message)
    ↓
Compute routing key: symbol present? "${table}.${symbol}" : "${table}"
    ↓
Publish to RabbitMQ (exchange: bitmex-data, routing key: computed key)
    ↓
Check if buffer full (publish() returns false)
    ↓
If buffer full: Wait for drain event (or timeout)
    ↓
Continue to next message
```

### Edge Cases and Handling

#### Role-Based Instance Idling

**Scenario**: An operator deploys a Feed instance with a role that has no matching channels or symbols.

**Example**: Role `LOW_VOLUME_1` with symbols matching only Bitcoin pairs (but LOW_VOLUME_1 doesn't handle Bitcoin).

**Handling:**
- During startup, detect zero resolved channels or symbols
- Log a warning (e.g., "No channels for this role, idling")
- Don't attempt WebSocket connection
- Still start the health check endpoint
- Service runs indefinitely without consuming or publishing

#### Symbol Set Changes

**Scenario**: BitMEX adds a new trading pair mid-day.

**Handling:**
- The Feed service fetches symbols only once at startup
- New symbols won't be subscribed to until the service restarts
- Operator must manually restart for new symbols to be picked up

**Why not dynamic reload?** WebSocket subscriptions would require unsubscribing from old and subscribing to new, which is complex error-prone. A restart is simpler and safer.

**Workaround**: Operator can restart the Feed service to pick up new symbols without losing existing subscriptions (downstream queue holds any buffered messages).

#### API Version Transitions

**Scenario**: BitMEX rolls out a new API version and sends messages with different schema mid-stream.

**Handling:**
- The service captures the API version from the `version` field in info messages
- Stores it in `state.apiVersion`
- Enriches all subsequent data messages with `_apiVersion`
- If version changes, new documents are tagged with the new version
- Older documents retain their original version tag

**Why track it?** Different schema versions may require different parsing logic downstream. Tagging with version allows consumers to handle multiple versions or reject unsupported versions.

#### Connection Loss Mid-Stream

**Scenario**: WebSocket connection drops unexpectedly (network issue, BitMEX restart, etc.).

**Handling:**
1. WebSocket close event fires
2. Log close code and reason
3. Clear the ping interval
4. Schedule reconnection with backoff
5. On reconnection, resubscribe to all topics from scratch

**Why restart subscriptions?** WebSocket state is not persistent. After reconnection, the server has no record of previous subscriptions. The client must resubscribe.

**Message loss during disconnect?** Any messages that arrive while disconnected are lost (no buffering on BitMEX side). This is expected behavior for a streaming data source. The Archivist and downstream consumers see a temporal gap in the data.

#### RabbitMQ Unavailable

**Scenario**: RabbitMQ is down or unreachable.

**Handling:**
- During startup, connection attempts fail; service exits with error code
- Operator must fix RabbitMQ and restart the Feed
- If RabbitMQ becomes unavailable mid-stream (rare), publish attempts log errors and continue
- Messages during RabbitMQ downtime are **lost** (no buffering on Feed side)

**Why not retry publishes?** The service is designed to be infrastructure-like. It assumes external services (RabbitMQ) are managed separately. If RabbitMQ is down, the service degrades gracefully rather than trying to heal itself.

#### BitMEX Rate Limiting

**Scenario**: The service sends too many subscription requests and BitMEX rate-limits.

**Handling:**
- BitMEX may close the WebSocket connection
- Service detects close, logs the code/reason
- Service reconnects with exponential backoff
- Batching strategy (described above) minimizes the risk

**Prevention**: Operators should tune `batchSizeChannels` and `batchDelayMs` to stay within BitMEX's limits. Default values are conservative.

#### Stalled Connections

**Scenario**: WebSocket is "connected" but not receiving messages (one-sided communication dead or market is completely idle).

**Detection**: Operator polls the health endpoint and sees `lastMessage` > 30000ms (30+ seconds since last message).

**Handling**:
- Service sends periodic pings every 30 seconds (these update `lastMessageTime`)
- If pings are successful, `lastMessageTime` is refreshed
- If pings fail or BitMEX doesn't respond, TCP layer will eventually timeout
- After extended silence, the OS closes the socket
- Service detects close and reconnects with backoff

**Why not explicit timeout?** The service cannot distinguish between a true stall and a legitimately idle market. The 30-second ping interval and health check window are designed to catch real connection deaths while respecting market silence. Operators interpret the health status: a large `lastMessage` value after pings fail suggests a real issue, while a large `lastMessage` value with pings succeeding suggests idle market data.

#### Backpressure and Channel Drain Handling

**Scenario**: Archivist is slow to ACK messages (database slow), RabbitMQ queue fills, Feed's publish calls return false.

**Handling:**
1. Feed detects publish returned false
2. Feed registers a resolver function in `drainWaiters` set
3. Feed awaits a drain event or 5-second timeout
4. When drain event fires (buffer flushed), all waiters are resolved and removed
5. Feed continues publishing

**Why track waiters?** Multiple concurrent messages might be publishing; each registers its own resolver. When drain fires, all are released together.

**Why 5-second timeout?** Prevents indefinite stalls. If drain never fires, the service eventually times out and continues. This is a defensive measure; in normal operation, drain fires well before timeout.

### Performance Considerations

#### Memory Usage

The service holds state for:
- One WebSocket connection
- One RabbitMQ channel
- Configuration and symbol/channel lists

**Typical memory:** < 100MB (very lightweight)

**Scaling:** Memory doesn't grow with number of symbols or channels (they're just configuration). A single instance can handle hundreds of subscriptions.

#### Batching Subscriptions

Batching prevents:
- Single WebSocket message that's too large
- Rate-limiting from BitMEX
- Overwhelming the server

**Current configuration (hardcoded):**
- `batchSizeChannels: 10` (topics per subscription message)
- `batchDelayMs: 3000` (3-second delay between batches)

**Example timing:** 100 topics would be sent as 10 batches of 10 topics each, staggered 3 seconds apart, taking ~27 seconds total to complete all subscriptions.

**Trade-off:** Subscription delay (up to ~27 seconds for 100+ topics) vs. reliability and compliance with BitMEX limits. The conservative values prioritize stability over onset speed.

#### Heartbeat (Ping/Pong)

The service sends a ping every 30 seconds. This:
- Keeps the connection alive (prevents idle connection timeouts)
- Detects one-sided communication failures (pong confirms bidirectional communication)
- Consumes minimal bandwidth

**Note:** Pings/pongs themselves do NOT update `lastMessageTime`; only actual data messages from BitMEX do. This means if the market is completely idle (no trades, quotes, or other data), `lastMessageTime` will appear stale even though the connection is healthy. The 30-second ping interval ensures that keep-alive detection happens at the TCP layer, while market data updates provide observability of actual flow.

### Multi-Consumer Architecture

The Feed is designed as a shared hub, enabling diverse downstream consumers without coordination:

**Example consumer bindings to the `bitmex-data` exchange:**
- **Archivist**: Bind with `#` → receives all messages (archival of complete data feed)
- **UI WebSocket service**: Bind with `trade.#` + `quote.#` → only real-time trades and quotes
- **Analytics batch worker**: Bind with `orderBookL2.#` → only order book snapshots
- **Indicator generator**: Bind with `quoteBin*.#` → only binned quote data
- **Future service**: Bind with `#.XBTUSD` → only Bitcoin-denominated products

Each consumer adds its own binding; Feed code never changes. Scaling from 1 to 100 consumers is transparent.

**Message flow:**
- All Feed instances (if multiple, on different roles) publish to the same exchange
- Each consumer queue receives only matching messages (based on binding)
- RabbitMQ handles all routing; no consumer-to-consumer coordination needed

**Advantages:**
- **No rate-limit risk**: One connection to BitMEX, shared by all consumers
- **Encapsulated complexity**: Reconnection, symbol resolution, channel management happens in Feed; consumers ignore it
- **Scales transparently**: Spin up 10 UI instances, 5 analytics workers, 3 batch processors—all consuming from the same Feed
- **Consumer autonomy**: Each service binds to what it needs; new consumers added without modifying Feed or other consumers
- **Deduplication tolerance**: If Feed instances overlap (e.g., both subscribe to same symbol), Archivist's unique indexes absorb duplicates

**Multi-instance Feed (different roles):**
If deploying multiple Feed instances on roles HIGH_VOLUME, LOW_VOLUME_1, and GLOBAL:
- HIGH_VOLUME: Subscribes to orderBookL2, quote, trade for non-Bitcoin symbols
- LOW_VOLUME_1: Subscribes to quoteBin* channels
- GLOBAL: Subscribes to insurance, announcement, etc.
- All publish to the same RabbitMQ exchange
- Consumers bind to what they need; get complete coverage with parallelism

### Observability

The service logs:
- Startup: Configuration loaded, roles resolved, symbols fetched
- Connection: WebSocket connected, RabbitMQ connected
- Subscriptions: Topics being subscribed (batches, counts)
- Messages: Subscription confirmations, data received
- Errors: Parse errors, publish failures, connection issues
- Reconnection: Attempts, backoff delays

**Health endpoint** provides:
- WebSocket connection state
- Last message received time

**Metrics** available via state inspection:
- `state.reconnectDelay` (current backoff delay)
- `state.apiVersion` (most recent API version seen)

**Monitoring strategy:** Query health endpoint periodically; check logs for errors; alert on stale `lastMessageTime`.

## Dynamic Subscription Management

The Feed service listens for subscription management commands via RabbitMQ on the `feed-commands` exchange. This allows dynamic subscription and unsubscription without restarting the service.

### Command Message Format

Send JSON messages to the `feed-commands` direct exchange:

```json
{
  "command": "subscribe|unsubscribe|resubscribe",
  "channel": "<channel_name>", // e.g. "instrument", "ordeBookL2:XBTUSD"
}
```

### Commands

**Subscribe**: Attempt to subscribe to a Bitmex channel.

```json
{
  "command": "subscribe",
  "channel": "orderBookL2:XBTUSD",
}
```

Result: Service sends `{"op": "subscribe", "args": ["orderBookL2:XBTUSD"]}` to BitMEX WebSocket

**Unsubscribe**: Remove a channel/symbol subscription and tell BitMEX to stop streaming it.

```json
{
  "command": "unsubscribe",
  "channel": "orderBookL2:XBTUSD",
}
```

Result: Service sends `{"op": "unsubscribe", "args": ["orderBookL2:XBTUSD"]}` to BitMEX WebSocket

**Resubscribe**: Unsubscribe then immediately subscribe.

```json
{
  "command": "resubscribe",
  "channel": "orderBookL2:XBTUSD",
}
```

Result: Service unsubscribes then subscribes to get fresh snapshot

### Global Channels

Some channels don't require symbols (like `insurance`, `announcement`):

```json
{
  "command": "subscribe",
  "channel": "insurance"
}
```

Result: Service sends `{"op": "subscribe", "args": ["insurance"]}` to BitMEX WebSocket

### Implementation

- **Location**: `src/commands.ts`
- **Integration**: Minimal footprint in the rest of the service
- **Isolation**: Completely separate from core feed logic

### Example: Sending Commands from Another Service

```typescript
import amqp from 'amqplib';

const conn = await amqp.connect('amqp://localhost');
const channel = await conn.createChannel();

await channel.assertExchange('feed-commands', 'fanout', { durable: true });

const command = {
  command: 'subscribe',
  channel: 'trade:ETHUSD', // Accepts array of channels as well
};

channel.publish('feed-commands', '', Buffer.from(JSON.stringify(command)));
```
