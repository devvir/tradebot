# Bot App — Milestones

Each milestone produces something verifiable in isolation. A service is "done" when it behaves correctly given valid input at its boundary — not when the full pipeline is running. Stubs and static test inputs are first-class tools, not workarounds.

---

## M0: Contracts

Define all shared message interfaces before writing any service code.

**Scope:**
- `MarketState` — signal output, bot input
- `DesiredState` — bot output, executor input
- `AccountState` — bot internal (position, margin)
- `DesiredOrder`

**Location:** `shared/types`

**Done when:** types compile, are exported, documented with field-level comments.

---

## M1: Executor

Build the executor service end-to-end. Test with a static `DesiredState` published to its input queue.

**Scope:**
- Subscribes to `desired.{symbol}` queue
- Connects to private WS streams: `order`, `execution` (accumulates live order state)
- Computes diff: desired ↔ live (converge_orders algorithm)
- REST calls: amend → create → cancel (in that order)

**Done when:**
- Given a static `DesiredState` on the queue, correct REST calls are made
- Verified against testnet (or a stubbed REST endpoint)
- API errors, retries, and rate limits handled

**Stub needed:** script that publishes a hardcoded `DesiredState` to the executor's input queue.

---

## M2: Signal

Build the signal service end-to-end. Connect to our ws service. Verify output by inspecting published messages.

**Scope:**
- Subscribes to public WS tables: `orderBookL2`, `trade`, `instrument`, `quote`, `funding`
- Delta accumulation: partial → insert/update/delete with key indexing (same pattern as snapshots service)
- Publishes `MarketState` per symbol at configured minimum interval
- EMA of last price included

**Done when:**
- Well-formed `MarketState` messages appear on the queue
- Order book state is correct after a sequence of deltas
- EMA values are sensible

**Stub needed:** subscriber script that logs incoming `MarketState` messages.

---

## M3: Bot framework

Build the bot framework shell. Feed it `MarketState` from the queue. Verify it publishes `DesiredState`.

**Scope:**
- Consumes `MarketState` from RabbitMQ
- Connects to private WS streams: `position`, `margin` (accumulates account state)
- Hybrid loop: signals buffer up to a minimum interval, then tick fires
- Calls strategy: `decide(market, account, config) → DesiredState`
- Publishes `DesiredState` to output queue
- Sanity checks: market open, order book healthy, position limits

**Initial strategy: market maker**
- Place N bid orders below mid + N ask orders above mid
- Configurable: N levels, spacing, size, position limits

**Done when:**
- Bot consumes signal, accumulates account state, runs market maker strategy
- Publishes well-formed `DesiredState` to output queue

**Stub needed:** subscriber script that logs `DesiredState` output.

---

## M4: Integration

Wire all three services in a compose module. Verify the full loop end-to-end.

**Done when:**
- Orders appear on testnet matching strategy intent
- Amend/create/cancel cycle works as market moves
- No service changes required to connect to the others

---

## M5: Exchange app wiring

Point the module at our ws/rest services instead of direct testnet. Surface and fix any gaps in ws/rest (private WS streams, order endpoints, auth). Signal/bot/executor require no changes.

**Done when:** bot app works identically with the exchange app as its data source.
