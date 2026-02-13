# Feed Service TODO

## Dynamic symbol discovery

When BitMEX lists a new instrument mid-session (e.g. a new future), the feed service currently won't subscribe to it. Symbols are only resolved at startup via `fetchAllSymbols`.

Previously there was an `instrument` channel insert handler that detected new symbols and subscribed dynamically, but it was removed during the role-based refactor because it depended on `symbolPatterns` which was always empty at that point.

### Options

1. **Instrument channel listener** (was partially implemented before): The GLOBAL role already receives `instrument` messages. On `insert` action, publish an event to RabbitMQ that other feed instances react to by subscribing to the new symbol if it matches their patterns + role.
2. **Periodic re-fetch**: Poll the REST API every N minutes, diff against current symbols, subscribe to new matches.
3. **Self-contained per instance**: Each non-GLOBAL instance subscribes to `instrument` as well (just for detection, not archival) and handles its own new symbol subscriptions.
