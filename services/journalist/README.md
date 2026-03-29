# Journalist Service

Consumes BitMEX WebSocket messages from RabbitMQ and writes them to the vault service. Runs continuously, recording every event as it arrives in real time.

## What it does

- Consumes all messages from the `journalist` topic exchange
- Augments each row with the message's `action` field
- Injects a synthetic `ts` field into rows from timeless tables (`connected`, `liquidation`, `publicNotifications`) using the stream clock, enabling time-synced replay
- Closes the previous day's vault file when a new day appears in the stream

## Development

```bash
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/JOURNALIST.md](../../docs/services/JOURNALIST.md).
