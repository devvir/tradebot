# TradeBot Development Tools

Comprehensive CLI tooling for development, debugging, and monitoring of the TradeBot monorepo. Each tool is designed to improve developer experience by providing quick access to common operations.

## Quick Start

```bash
# Interactive menu (no arguments)
./tools

# Run a specific tool
./tools rabbit --list         # RabbitMQ queue list
./tools remote sync-env       # Push .env files to remote
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
./tools -e .env.local rabbit --list
```

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
| **UPTIME** | Time since the container last started — a restart resets it |
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

## Remote Tool (`remote`)

Remote server operations. One subcommand: `sync-env` pushes local `.env` files to a remote host. `remote` alone runs it.

### Usage

```bash
./tools remote sync-env
./tools remote          # the same
```

---

### `remote sync-env`

Finds all `.env` files in the monorepo and copies each to the corresponding path on a remote server via `scp`, preserving directory structure relative to the project root.

Excludes `node_modules/`, `dist/`, and `.git/` directories from the search.

```bash
# Push all .env files to a remote server
./tools remote sync-env
# Prompt: Remote destination (user@host:/remote/path): deploy@10.0.0.1:/srv/tradebot
```

For each file, the equivalent remote path is created with `ssh mkdir -p` before the transfer.

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
./tools -e .env.dev rabbit --list

# Use staging config
./tools -e .env.staging monitor

# Multiple layers
./tools -e .env.local cold audit
```

### Required Environment Variables

| Variable | Example | Tools | Default |
|----------|---------|-------|---------|
| `QUEUE_URL` | `amqp://guest:guest@localhost:5672` | rabbit | `amqp://guest:guest@localhost:5672` |
| `RABBITMQ_MGMT_URL` | `http://localhost:15672/api` | rabbit | `http://localhost:15672/api` |

---

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
│   │   ├── rabbit.ts
│   │   ├── monitor.ts
│   │   ├── remote.ts
│   ├── tools/                # Tool implementations (isolated)
│   │   ├── rabbitmq/
│   │   ├── monitor/
│   │   ├── remote/
│   │   │   ├── index.ts      # Entry point
│   │   │   ├── types.ts      # RemoteDest, parseRemoteDest
│   │   │   └── sync-env.ts   # Push .env files via scp
│   └── shared/               # Shared utilities
│       ├── ui/
│       │   ├── logger.ts     # Colored output, formatting
│       │   └── prompts.ts    # Interactive prompts
│       └── utils/
│           └── env.ts        # Environment loading
├── tests/
│   ├── commands/
│   │   └── register.test.ts  # Command registration smoke tests
│   ├── shared/
│   │   └── utils/
│   │       └── env.test.ts
│   └── tools/
│       ├── remote.test.ts    # parseRemoteDest, findEnvFiles, listRemoteFiles, localMd5, run()
│       ├── monitor.test.ts
├── .env                      # Dev tooling overrides (loaded after root .env)
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

### RabbitMQ queue not found

Make sure queue name is exact. List available queues first:

```bash
./tools rabbit --list
```

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
