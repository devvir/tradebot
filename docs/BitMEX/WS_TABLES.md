# BitMEX WebSocket Tables — Reference

Sources: `tradebot_unpacked` MongoDB (WS keys from partial messages — authoritative), `tradebot_archive` (action types via `_id % 4` — reliable for keyed tables only), live BitMEX mainnet WS (action types, data shapes), live BitMEX testnet WS (symbol filter behaviour), `swagger.json`.

---

## Table Reference

| Table | Keys | Access | Symbol | Snapshot | Actions | REST | Since |
|---|---|---|---|---|---|---|---|
| orderBookL2 | symbol, id, side | public | optional | full | insert, update, delete | GET /orderBook/L2 | 2026-03-08 |
| orderBookL2_25 | symbol, id, side | public | optional | full | insert, update, delete | — | 2026-03-08 |
| orderBook10 | symbol | public | optional | full | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; update | — | 2026-03-08 |
| quote | (none) | public | optional | 1 per symbol | insert | GET /quote | 2014-11-22 |
| quoteBin1m | (none) | public | optional | 1 per symbol | insert | GET /quote/bucketed | 2014-11-22 |
| quoteBin5m | (none) | public | optional | 1 per symbol | insert | GET /quote/bucketed | 2014-11-22 |
| quoteBin1h | (none) | public | optional | 1 per symbol | insert | GET /quote/bucketed | 2014-11-22 |
| quoteBin1d | (none) | public | optional | 1 per symbol | insert | GET /quote/bucketed | 2014-11-22 |
| trade | (none) | public | optional | 1 per instrument | insert | GET /trade | 2014-11-22 |
| tradeBin1m | (none) | public | optional | 1 per symbol | insert | GET /trade/bucketed | 2014-11-22 |
| tradeBin5m | (none) | public | optional | 1 per symbol | insert | GET /trade/bucketed | 2014-11-22 |
| tradeBin1h | (none) | public | optional | 1 per symbol | insert | GET /trade/bucketed | 2014-11-22 |
| tradeBin1d | (none) | public | optional | 1 per symbol | insert | GET /trade/bucketed | 2014-11-22 |
| liquidation | orderID | public | optional | active | insert, update, delete | GET /liquidation | 2026-03-08 |
| instrument | symbol | public | optional | full | insert, update, delete | GET /instrument | 2026-03-08 |
| funding | timestamp, symbol | public | optional | 1 per symbol | insert | GET /funding | 2016-05-07 |
| settlement | timestamp, symbol | public | optional | 1 per symbol | insert | GET /settlement | 2015-05-01 |
| insurance | timestamp, currency | public | N/A | 1 per currency | insert | GET /insurance | 2016-02-28 |
| announcement | id | public | N/A | empty | insert | GET /announcement | 2026-03-08 |
| chat | id | public | N/A | empty | insert, update, delete | GET /chat | 2026-03-08 |
| connected | id (0) | public | N/A | 1 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; update | — | 2026-03-08 |
| publicNotifications | id | public | N/A | unknown | insert | — | 2026-03-08 |
| privateNotifications | id | private | N/A | unknown | insert | — | N/A |
| execution | (none) | private | optional | empty | insert | GET /execution | N/A |
| order | orderID | private | optional | full? | insert, update, delete | GET /order | N/A |
| position | account, symbol, strategy | private | optional | full? | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; update | GET /position | N/A |
| margin | account, currency | private | N/A | 1 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; update | GET /user/margin | N/A |
| wallet | account, currency | private | N/A | 1 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; update | GET /user/wallet | N/A |
| transact | transactID | private | N/A | empty | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; update | GET /user/walletHistory | N/A |
| affiliate | account, currency | private | N/A | 1 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; update | GET /user/affiliateStatus | N/A |
| csastate | account | private | N/A | 1 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; update | GET /user/csa | N/A |
| isolation | account, symbol | private | N/A | 1 per symbol | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; update | N/A | N/A |
| leverage | account, symbol, strategy | private | optional | empty? | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; update | GET /position/leverage | N/A |
| mamAllocation | account, marginCurrency | private | N/A | 1 per currency? | insert, update, delete | N/A | N/A |
| voucher | voucherId | private | N/A | unknown | insert, update, delete | N/A | N/A |

---

## Column Definitions

- **Keys** — fields BitMEX uses to identify a row for update/delete; `(none)` means insert-only (no keyed deltas possible)
- **Symbol** — whether a symbol filter applies to the subscription:
  - `optional` — can subscribe without symbol (all symbols) or with one (`trade:XBTUSD`); verified live on testnet
  - `N/A` — symbol filter explicitly rejected by BitMEX: "The table does not emit symbols. Subscribe to the table directly."
- **Snapshot** — content of the `data` array in the initial `partial` message:
  - `full` — complete current state (all active order book levels, all open orders, all positions, etc.)
  - `1` — exactly one record; the record is updated in place and never extended (applies to `connected`, `margin`, `wallet`, `affiliate`)
  - `1 per symbol` — one record per active symbol for an unfiltered subscription, or one record for a symbol-filtered subscription; each record is the most recently closed bar for that symbol
  - `empty` — confirmed empty across many partials in `tradebot_unpacked`; zero items despite substantial activity
  - `unknown` — insufficient data to determine; empty in what we have but low activity makes this inconclusive
- **Actions** — which action values the table emits after the initial partial; verified against `tradebot_archive` (`_id % 4`: 0=partial, 1=insert, 2=update, 3=delete)
- **REST** — paginated REST endpoint to fetch historical data; `—` means no endpoint
- **Since** — earliest date with data in `${VAULT_DATA_DIR}/`; `N/A` means no vault data collected yet

---

## Notes

**transact** — It is an insert-only table, but BitMEX sends update actions instead of inserts (they're complete and with new IDs; they are indeed inserts with the wrong action).

**`pool` field in `filter`:** The `trade` and `quoteBin*` tables include `pool: "Primary"` in the partial's `filter` object alongside `symbol`: `{ "pool": "Primary", "symbol": "XBTUSD" }`. This is undocumented by BitMEX. No other observed tables include extra fields in the filter beyond `symbol`.

**quote and trade** — `keys: []` (empty) per WS partials: insert-only. BitMEX's own reference client (`deltaParser.js`) explicitly documents this and throws on any update/delete. A small number of update/delete documents exist in `tradebot_archive` — a discrepancy in the source, not valid WS behaviour.

**tradeBin / quoteBin** The snapshot contains the most recently closed bar for each subscribed symbol; the bar's timestamp marks the end of its period (e.g. `2026-03-22T00:00:00.000Z` is the bar that closed at midnight, covering March 21). Verified live against BitMEX mainnet. Closed bars arrive as inserts and are immutable. For `tradeBin1d` subscribed without a symbol filter, the partial includes index instruments (`.`-prefixed symbols), producing a significantly larger snapshot than for regular instruments alone.

**instrument** — deletes are for index instruments (symbol starts with `.`). Regular trading instruments appear in the partial and inserts, and are only updated thereafter.

**insurance, announcement, chat** — confirmed empty partials across all samples in `tradebot_unpacked`. No updates or deletes in `tradebot_archive`.
**funding** — partial contains one record per perpetual symbol (including delisted ones — timestamps as far back as 2016). 313 records observed in a live sample. Each record's `timestamp` reflects the last funding event for that symbol, not the subscription time.
**settlement** — partial contains the full history of all settled contracts (688 records observed in a live sample, dating back to 2015). One record per settlement event; since each symbol settles only once, this is effectively one record per ever-settled symbol. No index symbols. Insert-only after the partial.

**publicNotifications, execution, transact** — marked `unknown` snapshot: we have no data volume sufficient to draw conclusions. For `execution` and `transact`, a partial snapshot of recent history would be reasonable. For `publicNotifications`, the data array is almost certainly always empty (notifications are push events, not state).

**privateNotifications** — available via `/realtimePlatform` (not `/realtime`). Auth uses the same `/realtime` HMAC path. Partial is empty; schema has `title, body, ttl, closable, persist, sound`. BitMEX documents it as "currently not used".

**connected** — single record tracking connected user/bot counts (`users`, `bots`). Keyed by `id`; only ever updated. The `partial` always arrives with all-zero values — the real counts arrive in the first `update` immediately after. `id` is always `0` (fixed placeholder key).

**margin, wallet, affiliate** — one record per account/currency pair. The partial gives the full set; items are only updated thereafter.

**csastate, isolation, leverage, mamAllocation, voucher** — undocumented private endpoints.

---

## Table Descriptions

### orderBookL2 / orderBookL2_25
The L2 order book tables stream the limit order book as individual price levels. Each item represents a single level with a symbol, a BitMEX-internal `id` (from which price can be derived, though price is also included directly), a side (Buy or Sell), and a size. On subscription you receive a full snapshot of all active levels (L2_25 limits to 25 per side), then a stream of inserts (new levels), updates (size changes), and deletes (levels removed). Only `orderBookL2` has a REST snapshot endpoint.

### orderBook10
A different protocol from the L2 tables. Each message contains a single record for the symbol with `bids` and `asks` arrays — each entry is `[price, size]` — covering the top 10 levels on each side. On subscription a partial arrives with the current book state; thereafter only updates are sent, each replacing the full record. There are no inserts or deletes — the record is simply overwritten on every tick. BitMEX documentation describes this as a "traditional full book push" and notes it transmits more data than the L2 delta approach. Keyed by `symbol` only. No REST endpoint.

### quote
Top-of-book snapshots: the current best bid and best ask for a symbol, with their sizes. Each message is a point-in-time record. The table has no keys, so there are no updates or deletes — every change in the spread produces a new insert. The partial contains the most recent quote per symbol — one record per currently-quoted trading instrument. Index instruments are never included. The count varies (observed range ~100–120) because some instruments are only intermittently quoted; symbols absent from the partial may have gone without a new quote long enough to fall outside whatever recency threshold BitMEX applies. The REST endpoint (`GET /quote`) provides full historical access with pagination.

### quoteBin1m / quoteBin5m / quoteBin1h / quoteBin1d
OHLCV-style summaries of the top-of-book quote activity aggregated into fixed time buckets (1-minute, 5-minute, 1-hour, 1-day). Each bar records the open, high, low, and close of the best bid and ask over the period, along with a timestamp marking the end of the period. The partial contains the most recently closed bar per subscribed symbol (one bar per symbol for unfiltered subscriptions, one bar for symbol-filtered). Closed bars arrive as inserts and are immutable. Historical data is available via `GET /quote/bucketed?binSize=`.

### trade
A stream of every individual trade that executes on the exchange. Each item includes symbol, side, size, price, tick direction, and a unique match ID. Also carries index/reference price ticks (`trdType: "Referential"`) for `.`-prefixed index symbols with `size: 0`. These are not actual trades but periodic index price publications using the same channel. The partial contains the most recent trade or referential tick per active symbol — one record per symbol, including index instruments (observed range ~1000–1100; variation driven by index symbol churn). No updates or deletes: every trade record is final on arrival.

### tradeBin1m / tradeBin5m / tradeBin1h / tradeBin1d
OHLCV trade bars aggregated into fixed time buckets. Each bar records open, high, low, close price, total volume, and VWAP over the period, with a timestamp marking the end of the period. The partial contains the most recently closed bar per subscribed symbol (one bar per symbol for unfiltered subscriptions, one bar for symbol-filtered). For `tradeBin1d` subscribed without a filter, the partial includes index instruments alongside regular trading instruments, producing a much larger snapshot. Closed bars arrive as inserts and are immutable. REST access via `GET /trade/bucketed?binSize=` with full pagination.

### liquidation
Active liquidation orders currently on the book. When a trader's position is forcibly closed, BitMEX takes over the position and places a liquidation order on the market. This table tracks those in-flight orders. Items are inserted when a liquidation order is placed, updated if the price or quantity changes (e.g. as the market moves), and deleted when the order fills or is cancelled. The partial normally contains zero items (active liquidations at any given moment are rare) but is a valid snapshot of currently outstanding liquidation orders.

### instrument
Full state of every instrument (trading contract and index) listed on BitMEX. Each record contains ~80+ fields: contract specifications (lot size, tick size, multiplier, margin rates, fees), current market state (last price, mark price, fair price, bid/ask, funding rate, open interest), and lifecycle timestamps (listing, expiry, settlement). The partial contains all active instruments. Regular trading instruments (XBTUSD, XBTUSDT, etc.) are updated in place as their state changes. Index instruments (`.`-prefixed symbols) are inserted when a new index period begins and deleted when it expires.

### funding
Periodic funding rate records for perpetual swap contracts. Each entry records the funding rate, funding interval, and the daily-equivalent funding rate for a symbol at a specific timestamp. Funding events occur at fixed intervals (typically every 8 hours for most perpetuals). The partial contains one record per perpetual symbol — 313 symbols observed in a live sample, including delisted ones (timestamps as far back as 2016). Each record's `timestamp` is the most recent funding event for that symbol. No index symbols (`.`-prefixed) are included. All subsequent data arrives as inserts. Full historical funding data is available via `GET /funding`.

### settlement
Settlement records produced when a futures contract expires or an option is exercised. Each entry records the settlement type and settled price. The partial contains the full history of all settlements since BitMEX's inception (688 records observed, 2015–2026). No index symbols are included. New settlements arrive as inserts at contract expiry (infrequent — only futures and options, not perpetuals). Historical settlements also available via `GET /settlement`.

### insurance
The BitMEX insurance fund balance by currency, recorded at each update event. The fund absorbs losses from liquidations that cannot be covered by the liquidated trader's margin. Each insert adds a new balance snapshot with a timestamp and wallet balance. The partial is empty; a snapshot of the fund at any time can be reconstructed from the insert history. REST access via `GET /insurance`.

### announcement
Platform-wide announcements from BitMEX (e.g. maintenance windows, new features, policy changes). Each item has a title, content body, link, and timestamp. The partial is empty in `tradebot_unpacked` samples — announcements are infrequent. Historical announcements available via `GET /announcement`.

### chat
Public chat messages sent in BitMEX's built-in chat channels. Each item includes the user, message text, rendered HTML, and a channel identifier. Updates occur when messages are edited (admin/moderator edits). The partial is empty — chat is a live event stream with no meaningful snapshot of history delivered on subscribe. Recent chat history (500 messages per Channel) is available via `GET /chat`.

### connected
A single record reporting the current number of connected users and bots on the platform. Keyed by `id` (always the same record). Only ever updated, never inserted or deleted. No REST equivalent.

### publicNotifications
Platform-wide push notifications (alerts, important messages). The channel exists and delivers partials, but no data has been observed in practice. Inserts are the expected delivery mechanism. The data array is almost certainly always empty since notifications are push events, not persistent state.

### execution
A private stream of all order execution events for the authenticated account. Each item represents a fill or a change in order state (e.g. new order, partial fill, cancel). Contains full execution details: order ID, symbol, side, price, quantity filled, fees, P&L, and more. Insert-only — each execution event is immutable once recorded. The snapshot at subscription time is empty. Historical executions available via `GET /execution`.

### order
A private stream of all active and recently completed orders for the authenticated account. The partial provides a full snapshot of currently open orders. New orders arrive as inserts; modifications (price, quantity, status changes) arrive as updates; cancellations and fully-filled orders arrive as deletes. Provides the full order lifecycle in real time. Historical order history available via `GET /order`.

### position
A private stream of all open positions for the authenticated account. Each record represents a position in a single instrument, including current quantity, entry price, liquidation price, unrealised P&L, and margin details. The partial gives a snapshot of all current positions. Changes as trades execute arrive as updates. Symbol filter is supported.

### margin
Account-level margin and balance summary, broken down by currency. Each record covers a single account/currency pair and includes wallet balance, margin used, available balance, unrealised P&L, and risk limits. The partial gives the current margin state. Only updates are received after that — the set of margin records is fixed for a given account configuration. Does not support symbol filter.

### wallet
Account wallet balances by currency. Tracks deposited, withdrawn, and current balance per currency. Similar structure to `margin` but focused on wallet accounting rather than trading margin. The partial gives current balances; only updates follow. Does not support symbol filter.

### transact
A private log of all wallet transactions for the authenticated account: deposits, withdrawals, realised P&L transfers, fee payments, and funding payments. Each item is an immutable event with a unique `transactID`. Insert-only. The snapshot at subscription time is unknown — may include recent transactions or be empty. Full transaction history available via `GET /user/walletHistory`.

### affiliate
Affiliate program statistics for the authenticated account. Tracks referral volume, commissions earned, and payout history. One record per account/currency pair; the partial gives the current state and only updates follow. Does not support symbol filter. Current affiliate status also available via `GET /user/affiliateStatus`.
### csastate
Cross-margin Status Assessment state. Tracks the account's overall cross-margin health across multiple dimensions: margin balance, margin call threshold, liquidation threshold, and a status flag for each (`maintMarginRatioStatus`, `marginBalanceStatus`, `overallStatus`). Also includes a `liquidationDeadline` timestamp and `valuationCurrency`. The partial was empty in the observed sample, suggesting no active stress condition triggers a record — it may only populate during margin events. Updates are likely pushed when the account's margin health changes, rather than continuously.

### isolation
Per-symbol margin mode setting. Records whether each symbol the account has interacted with is in cross-margin (`crossMargin: true`) or isolated mode (`crossMargin: false`). Keyed by `account` + `symbol`. The partial delivers the current mode for all relevant symbols — one record per symbol. Updated when the user switches between cross and isolated margin for a symbol.

### leverage
Per-symbol, per-strategy leverage setting. Stores the configured leverage multiplier for a given symbol and strategy combination. Keyed by `account`, `symbol`, and `strategy`. The partial was empty in the observed sample (empty data array), which may mean leverage is only tracked when explicitly set (i.e. non-default). Updated when the user changes the leverage setting for a symbol.

### mamAllocation
MAM (Multi-Account Manager) fund allocation. Tracks how margin currency is distributed across allocation types for the account. The `allocations` field is an array of `{ type, amount }` entries — observed types include the currency itself (`USDt`), `XBt`, and `free`. Keyed by `account` + `marginCurrency`. The partial delivers current allocations per margin currency. Likely update-only after the initial partial — allocations change when the MAM manager redistributes funds.

### voucher
Account credit vouchers. Each record represents a voucher with a balance, currency, expiry, type, and a link to a master voucher (`masterVoucherId`). Keyed by `voucherId` (a GUID). The partial was empty in the observed sample — vouchers are likely rare promotional credits. Actions are unknown; given the expiry field, deletes or updates are plausible when vouchers are spent or expire.