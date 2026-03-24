# TradeBot Development Tools

Comprehensive CLI tooling for development, debugging, and monitoring of the TradeBot monorepo. Each tool is designed to improve developer experience by providing quick access to common operations.

## Quick Start

```bash
# Interactive menu (no arguments)
./tools

# Run a specific tool
./tools ws                 # WebSocket tool
./tools db -l              # MongoDB list mode
./tools rabbit --list      # RabbitMQ queue list
./tools bouncer            # View accounts
./tools broadcast          # Monitor broadcast
./tools signal --latest    # View latest signals
```

## Global Options

All tools support these global flags:

```bash
-e, --env <path>    Load additional .env file (overrides root and module .env)
-m, --module <name> Also load this module's .env (modules/<name>/.env)
-v, --verbose       Enable verbose/debug output
--help              Show help for specific command
```

Example:

```bash
./tools -e .env.local db --list
```

---

## WebSocket Tool (`ws`, `websocket`)

Connect to BitMEX WebSocket with authentication or as a guest. Provides an interactive shell for subscribing/unsubscribing from data streams and executing common operations.

### Usage

```bash
./tools ws [account] [options]
```

### Options

- `[account]` - Optional account ID to auto-select (otherwise prompts you)
- `-t, --testnet` - Connect to testnet instead of live. Only valid with `--guest` (authenticated accounts have their environment fixed in Bouncer)
- `--guest` - Connect as guest without authentication
- `-p, --platform` - Connect to `/realtimePlatform` instead of `/realtime`. Use this for platform-level topics: `announcement`, `chat`, `connected`, `publicNotifications`, `privateNotifications` (the last one requires auth)

### Endpoints

| Endpoint | Flag | Topics |
|----------|------|--------|
| `/realtime` | _(default)_ | All trading topics: `trade`, `quote`, `order`, `position`, `orderBookL2`, etc. |
| `/realtimePlatform` | `-p` | `announcement`, `chat`, `connected`, `publicNotifications`, `privateNotifications` |

### Examples

```bash
# Interactive menu - prompts to select account
./tools ws

# Connect to specific account by ID
./tools ws bitmex-live

# Connect to testnet as guest
./tools ws --testnet --guest

# Connect to /realtimePlatform as guest (public topics)
./tools ws --guest --platform

# Connect to /realtimePlatform authenticated (for privateNotifications)
./tools ws bitmex-live --platform
```

### Interactive Commands

Once connected, you can use these commands in the shell:

| Command | Example | Description |
|---------|---------|-------------|
| `sub <channel> [<symbol>]` | `sub trade XBTUSD` | Subscribe to a channel (with optional symbol filter) |
| `unsub <channel> [<symbol>]` | `unsub trade XBTUSD` | Unsubscribe from a channel |
| `quotes <symbol>` | `quotes XBTUSD` | Subscribe to quote data for a symbol |
| `trades <symbol>` | `trades XBTUSD` | Subscribe to trade data for a symbol |
| `orders` | `orders` | Subscribe to order updates (requires auth) |
| `positions` | `positions` | Subscribe to position updates (requires auth) |
| `list` | `list` | Print locally-tracked active subscriptions |
| `ping` | `ping` | Send a ping |
| `help` | `help` | Show this command list |
| `exit` | `exit` | Disconnect and exit |

### Account Selection

- If no account is specified, you'll be prompted to select from available accounts in Bouncer
- Accounts are auto-discovered via Docker or read from `BOUNCER_URL`
- Requires `BOUNCER_TOKEN` for Bouncer authentication

### Authentication

- WS auth is delegated to Bouncer: `POST /sign/ws` returns the HMAC-SHA256 signature
- The raw API secret never leaves Bouncer
- Guest mode connects without authentication (no access to private data)

---

## MongoDB Tool (`db`, `database`)

Query and explore MongoDB database with interactive REPL and management commands.

### Usage

```bash
./tools db [query] [options]
```

### Options

- `[query]` - Optional JSON query (in interactive mode)
- `-c, --collection <name>` - Specify collection for queries
- `-l, --list` - List all collections in the current database with document counts

### Examples

```bash
# List all collections and stats
./tools db --list

# Interactive mode (default)
./tools db

# Query specific collection
./tools db -c orders
```

### Interactive Commands

In interactive mode, you can enter:

| Command | Example | Description |
|---------|---------|-------------|
| `:collections` | `:collections` | List all available collections |
| `:find <collection>` | `:find orders` | Find first 10 documents in collection |
| `:count <collection>` | `:count users` | Count total documents in collection |
| `:stats <collection>` | `:stats orders` | Show collection statistics (size, avg doc size, etc.) |
| `:exit` or `:quit` | `:exit` | Exit tool |
| JSON query | `{"status": "active"}` | Query the specified collection (requires `-c` flag) |

### Examples

```bash
# List collections
:collections

# Find documents in 'orders' collection
:find orders

# Count documents
:count positions

# Get stats
:stats signals

# Query active orders (with -c flag)
./tools db -c orders
{"status": "active"}

# Exit
:exit
```

### Configuration

Connects to MongoDB using `DB_URL` environment variable (default: `mongodb://localhost:27017/tradebot`)

---

## RabbitMQ Tool (`rabbit`, `amqp`)

Monitor RabbitMQ queues, view messages, and stream queue activity in real-time.

### Usage

```bash
./tools rabbit [queue] [options]
```

### Options

- `[queue]` - Optional queue name to inspect
- `-l, --list` - List all queues with message counts and consumer info
- `-w, --watch` - Watch queue and stream new messages (requires queue name)
- `--messages <count>` - Number of recent messages to fetch (default: 10)

### Examples

```bash
# List all queues
./tools rabbit --list

# Fetch 10 recent messages from queue
./tools rabbit broadcast

# Fetch custom amount of messages
./tools rabbit trades --messages 20

# Stream messages in real-time
./tools rabbit broadcast --watch

# Watch with message limit
./tools rabbit quotes --watch --messages 5
```

### Queue Information

When listing queues (`--list`), you'll see:

- **Name** - Queue name
- **Messages** - Total pending messages
- **Ready** - Messages ready for consumption
- **Consumers** - Number of active consumers

### Watching Messages

With `--watch` flag:
- Messages are streamed in real-time as they arrive
- Each message shows timestamp and content
- Messages are not consumed (they remain in the queue)
- Press Ctrl+C to stop watching

### Message Display

Messages are displayed as:
- JSON messages are formatted for readability
- Raw text messages are shown as-is
- Each message includes a timestamp

### Configuration

- **RabbitMQ URL**: `QUEUE_URL` environment variable (default: `amqp://guest:guest@localhost:5672`)
- **Management API**: `RABBITMQ_MGMT_URL` (default: `http://localhost:15672/api`)

---

## Bouncer Tool (`bouncer`)

View accounts and authentication information from the Bouncer service.

### Usage

```bash
./tools bouncer [options]
```

### Options

- `-a, --all` - Show full details for each account (including keys and tokens)
- `--account <name>` - Show detailed JSON for specific account

### Examples

```bash
# List all accounts (summary)
./tools bouncer

# Show all details
./tools bouncer --all

# Show specific account details
./tools bouncer --account "Trading Bot"

# Combined
./tools bouncer -a --account "My Account"
```

### Account Summary (default)

Table showing:
- **#** - Account number
- **Name** - Account name/identifier
- **Exchange** - Exchange name (BitMEX, etc.)
- **Testnet** - Whether it's testnet or live
- **AuthKey** - Whether API key is present

### Account Details (with `--all`)

- Account name/account ID
- Exchange
- API Key (first 8 chars shown, rest masked)
- Token status (shown as masked for security)
- Testnet flag

### Configuration

Connects to Bouncer service at `BOUNCER_URL` environment variable.

---

## Broadcast Monitoring Tool (`broadcast`)

Monitor messages from the Broadcast service in real-time. Useful for debugging broadcast activity and message patterns.

### Usage

```bash
./tools broadcast [options]
```

### Options

- `--type <type>` - Filter messages by type (only print messages matching this type)

### Examples

```bash
# Monitor all broadcast messages
./tools broadcast

# Monitor and filter by type
./tools broadcast --type OrderUpdate
```

### Message Display

For each message:
- **Message number** - Sequential counter
- **Timestamp** - When message was published
- **Type** - Message type/action
- **Content** - Full JSON payload

### Message Types

Common message types (service-specific):
- `OrderUpdate` - Order changes
- `TradeExecuted` - Trade execution
- `PositionChange` - Position updates
- Custom types from your broadcast service

### Real-Time Monitoring

- Connects to RabbitMQ's broadcast exchange
- Each message is acknowledged after display
- Press Ctrl+C to stop monitoring
- No messages are lost

### Configuration

Uses RabbitMQ with:
- **Exchange**: `broadcast` (fanout type)
- **URL**: `QUEUE_URL` environment variable

---

## Signal Service Tool (`signal`)

View trading signals and indicators from the Signal service. Useful for understanding signal generation and testing indicator logic.

### Usage

```bash
./tools signal [options]
```

### Options

- `-l, --latest` - Show latest 20 signals only (sorted newest first)
- `--symbol <symbol>` - Filter signals by symbol (e.g., `XBTUSD`)

### Examples

```bash
# View recent signals
./tools signal

# Get only latest signals
./tools signal --latest

# Filter by symbol
./tools signal --symbol XBTUSD

# Latest signals for specific symbol
./tools signal --latest --symbol ETHUSD
```

### Signal Information

Each signal displays:
- **Number** - Sequential index
- **Timestamp** - When signal was generated
- **Symbol** - Trading symbol (e.g., XBTUSD)
- **Type** - Signal type/classification
- **Direction** - Buy/Sell/Hold (if applicable)
- **Strength** - Signal strength percentage
- **Price** - Price at signal generation
- **Reason** - Signal reasoning/indicators

### Summary Statistics

After listing signals, you'll see:

**By Symbol**:
- Count of signals per symbol
- Helps identify which symbols are generating most signals

**By Type**:
- Count of signals per type
- Helps understand signal distribution

### Output Limits

- Default: Up to 50 most recent signals
- With `--latest`: Up to 20 most recent signals
- Filter by symbol if dataset is too large

### Configuration

Connects to MongoDB collection `signals`:
- **URL**: `DB_URL` environment variable
- **Collection**: `signals`
- **Default DB**: `tradebot`

---

---

## Monitor Tool (`monitor`, `mon`)

Live dashboard showing all running Docker containers and RabbitMQ queue health. Designed to run continuously in a dedicated terminal.

### Usage

```bash
./tools monitor [options]
```

### Options

- `-i, --interval <seconds>` - Refresh interval in seconds (default: `3`)

### Examples

```bash
# Default refresh every 3s
./tools monitor

# Faster refresh
./tools monitor -i 1

# Slower refresh to reduce noise
./tools monitor -i 10
```

### Container Table

Containers are grouped by Docker Compose project. For each container:

| Column | Description |
|--------|-------------|
| **ID** | Short container ID (12 chars) |
| **NAME** | Container name, prefixed with green ● (running) or red ● (stopped) |
| **HEALTH** | Health status from Docker healthcheck (healthy / unhealthy / starting) |
| **UPTIME** | Time since container was created |
| **CPU** | CPU usage percentage |
| **MEMORY** | Memory used / limit (percentage) |
| **RESTARTS** | Restart count (yellow if > 0) |
| **LAST LOG** | Time since last log line was emitted |

### RabbitMQ Section

RabbitMQ instances are **auto-discovered** from running Docker containers — no configuration needed. Each instance with port 15672 mapped to the host gets its own section.

| Column | Description |
|--------|-------------|
| **QUEUE** | Queue name |
| **VHOST** | Virtual host |
| **READY** | Messages ready (yellow if > 0) |
| **UNACKED** | Unacknowledged messages (red if > 0) |
| **TOTAL** | Total messages |
| **CONSUMERS** | Active consumers |
| **PUBLISH/s** | Publish rate |
| **DELIVER/s** | Delivery rate |
| **STATE** | Queue state |

### Credentials

RabbitMQ management API credentials are read from:
- `QUEUE_USER` (default: `guest`)
- `QUEUE_PASS` (default: `guest`)

Override per-project with `-e` if credentials differ.

---

## Environment Configuration

The tooling package loads environment variables in this order (later overrides earlier):

1. **Root .env** - `/tradebot/.env` (lowest priority)
2. **Module .env** - `/dev/tooling/.env`
3. **Additional .env** - Via `-e` flag
4. **Process environment** - Already-set env vars (highest priority)

### Example - Using Custom .env

```bash
# Use development config
./tools -e .env.dev db --list

# Use staging config
./tools -e .env.staging bouncer

# Multiple layers
./tools -e .env.local signal --latest
```

### Required Environment Variables

| Variable | Example | Tools | Default |
|----------|---------|-------|---------|
| `BOUNCER_URL` | `http://localhost:3010` | ws, bouncer | Required |
| `DB_URL` | `mongodb://localhost:27017/tradebot` | db, signal | `mongodb://localhost:27017/tradebot` |
| `QUEUE_URL` | `amqp://guest:guest@localhost:5672` | rabbit, broadcast | `amqp://guest:guest@localhost:5672` |
| `RABBITMQ_MGMT_URL` | `http://localhost:15672/api` | rabbit | `http://localhost:15672/api` |

---

## Interactive Menu

Run without arguments to get an interactive menu:

```bash
./tools
```

This displays:
- List of all available tools
- Tool descriptions
- Selectable via arrow keys
- Press Enter to select a tool

---

## Architecture

### Directory Structure

```
dev/tooling/
├── src/
│   ├── index.ts              # Main CLI entry point
│   ├── commands/             # Thin routing layer
│   │   ├── ws.ts
│   │   ├── db.ts
│   │   ├── rabbit.ts
│   │   ├── bouncer.ts
│   │   ├── broadcast.ts
│   │   └── signal.ts
│   ├── tools/                # Tool implementations (isolated)
│   │   ├── websocket/
│   │   │   └── index.ts
│   │   ├── mongodb/
│   │   │   └── index.ts
│   │   ├── rabbitmq/
│   │   │   └── index.ts
│   │   ├── bouncer/
│   │   │   └── index.ts
│   │   ├── broadcast/
│   │   │   └── index.ts
│   │   └── signal/
│   │       └── index.ts
│   └── shared/               # Shared utilities
│       ├── ui/
│       │   ├── logger.ts     # Colored output, formatting
│       │   └── prompts.ts    # Interactive prompts
│       └── utils/
│           └── env.ts        # Environment loading
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

### Design Principles

- **Commands are thin routing layers** - They validate options and delegate to tools
- **Tools are isolated** - Each tool lives in its own folder with complete logic
- **Shared utilities are centralized** - UI, environment, logging are shared across tools
- **TypeScript throughout** - Full type safety and IDE support
- **Environment management** - Layered env loading for flexibility
- **Error handling** - Graceful error messages with proper exit codes

---

## Adding New Tools

To add a new tool:

1. Create tool folder: `src/tools/my-tool/`
2. Create implementation: `src/tools/my-tool/index.ts` with `run()` export
3. Create command: `src/commands/my-tool.ts` with `register()` export
4. Register command in `src/index.ts`
5. Add to tool list in interactive menu
6. Document in this README

Example tool:

```typescript
// src/tools/my-tool/index.ts
import { success } from '../../shared/ui/logger.js';

export async function run(options: Record<string, any> = {}): Promise<void> {
  success('My tool is running!');
}
```

```typescript
// src/commands/my-tool.ts
import { Command } from 'commander';
import { run as runMyTool } from '../tools/my-tool/index.js';
import { error } from '../shared/ui/logger.js';

export function register(program: Command): void {
  program
    .command('my-tool')
    .description('Description of my tool')
    .option('--option <value>', 'An option')
    .action(async (options: any) => {
      try {
        await runMyTool(options);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
```

---

## Troubleshooting

### "BOUNCER_URL not configured"

Make sure `BOUNCER_URL` is set in your `.env` files:

```bash
BOUNCER_URL=http://localhost:3010
```

Or use the `-e` flag:

```bash
./tools -e ./env.local ws
```

### MongoDB connection times out

Check MongoDB is running and `DB_URL` is correct:

```bash
# Test connection
./tools db -l

# Check env var
echo $DB_URL
```

### RabbitMQ queue not found

Make sure queue name is exact. List available queues first:

```bash
./tools rabbit --list
```

### WebSocket auth failed

- Verify Bouncer service is running and accessible
- Check account is configured in Bouncer
- Try guest mode to rule out auth issues: `./tools ws --guest`

---

## Development

### Build

```bash
cd dev/tooling
pnpm build
```

### Run from TypeScript (no build needed)

```bash
cd dev/tooling
pnpm dev  # or: node --loader=ts-node/esm src/index.ts
```

### Test

```bash
cd dev/tooling
pnpm test
pnpm test:watch
```

---

## Future Enhancements

Potential tools and features to add:

- Service health checks and status dashboard
- Redis monitoring and key inspection
- Exchange API explorer
- Log file analyzer
- Performance profiling
- Configuration validator
- Database backup/restore utilities
- Custom alert definitions
- Rule testing environment
