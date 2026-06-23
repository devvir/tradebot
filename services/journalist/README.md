# Journalist Service

Consumes BitMEX WebSocket messages from RabbitMQ and writes them to the vault service. Runs continuously, recording every event as it arrives in real time.

## What it does

- Consumes all messages from the `journalist` topic exchange
- Files each message under its **event-time day** (the data items' `timestamp`), falling back to the collector reception time for timeless tables (`connected`, `liquidation`, `publicNotifications`) and empty messages
- Carries each message's `action` and reception date through to vault, where they become the `_date_`/`_action_` columns
- Closes the previous day's vault file once a new day has settled; diverts rows that arrive after a bucket is sealed to a `.tail` file rather than dropping them

## Development

```bash
pnpm install
pnpm build
pnpm test
```

For technical details, see [docs/services/JOURNALIST.md](../../docs/services/JOURNALIST.md).
