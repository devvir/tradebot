# Courier Service

Downloads BitMEX daily trade and quote gzips from S3 and streams them to the vault service.

## Core Functionality

- **S3 download** — Fetches historical BitMEX gzips from the public S3 bucket from 2014-11-22 onwards
- **Direct streaming** — Pipes S3 response bytes straight to vault via HTTP PUT — no intermediate disk I/O
- **Idempotent sync** — On each run, checks which dates vault already has and skips them; 409 responses are treated as no-ops
- **Gap-tolerant** — A day BitMEX hasn't published is recorded as missing and retried every cycle without blocking later dates; it's downloaded automatically if it ever appears
- **Retry with backoff** — Transient failures are retried up to 5 times with exponential backoff
- **Midnight polling** — Rechecks for newly published gzips shortly after UTC midnight each day

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests
```

For technical details, see [docs/services/COURIER.md](../../docs/services/COURIER.md).
