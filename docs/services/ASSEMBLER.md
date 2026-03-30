# Assembler Service — Technical Reference

## Overview

```
fanout:assembler  →  assembler  →  topic:assembled  routingKey=record
```

Assembler reconstructs original BitMEX WebSocket messages from the WS-message
envelopes published by clerk. Each message from clerk is a `{ action, date, data }`
object for one WS message; assembler enriches it with table-level metadata
(`keys`, `types`, `filter` for partials) to restore the full BitMEX WS envelope.

## Consumed Exchange

Assembler consumes from the `assembler` fanout exchange (queue: `assembler`), which
is bound by the customs pipe from `topic:clerk` with routing key `message`.

## Reconstruction Logic

Each incoming message carries headers `x-table`, `x-date`, and `x-msg-index`, plus
a `WsMessage` payload (`{ action, date, data }`) where `data` is an array of
already type-cast item objects.

For each message:

1. Look up the table in `TABLE_SPECS` (a static map of table → `{ keys, types, filter }`).
   Unknown tables are logged as warnings and skipped.
2. Build the reconstructed message:
   - All messages get `table`, `action`, `data`, `timestamp`.
   - `timestamp` is `data[0].timestamp` for tables that have a timestamp field,
     otherwise it falls back to `message.date`.
   - `partial` messages additionally get `keys`, `types`, and `filter: {}` from `TABLE_SPECS`.
   - `chat` messages (all actions) additionally get `keys: ['id']` and `filterKey: 'channelID'`.

Reconstructed message shape:

```ts
{
  table:     string;
  action:    string;             // 'partial' | 'insert' | 'update' | 'delete'
  data:      Record<string, unknown>[];
  keys?:     string[];           // present on partials and chat
  types?:    Record<string, WsFieldType>;  // present on partials
  filter?:   {};                 // present on partials (always empty)
  filterKey?: string;            // present on chat (all actions)
}
```

This matches the original BitMEX WebSocket message structure exactly (minus `table`,
which is inferred from the collection at query time).

## Published Exchange

Assembler publishes to the `assembled` topic exchange with routing key `record`.
The `x-table`, `x-date`, and `x-msg-index` headers from the incoming message are
forwarded unchanged.

## Table Specs

`TABLE_SPECS` (`src/tableSpecs.ts`) covers all known BitMEX tables and maps each to:
- `keys` — the field(s) used to key data items (as reported in BitMEX `partial` messages)
- `types` — the field type string for each field (as reported in BitMEX `partial` messages)

This is static data derived from observed BitMEX partial messages. It is used to restore
the `keys` and `types` root fields that BitMEX includes only in `partial` actions but
which are needed by consumers to interpret delta messages.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `ASSEMBLER_PREFETCH` | No | `200` | Per-consumer prefetch count |
