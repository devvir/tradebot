# BitMEX REST Endpoints — Reference

Sources: `swagger.json` (parameters, required flags), `WS_TABLES.md` (WS table cross-reference), `REST_STARTTIME_BUG.md` (startTime/endTime behaviour), live BitMEX mainnet (observed response shapes), `tradebot_unpacked` MongoDB (vault data availability).

---

## Public Endpoints

| Endpoint | Methods | symbol | Paginated | Time range | filter | columns | WS table | Since |
|---|---|---|---|---|---|---|---|---|
| /trade | GET | optional | yes | yes | yes | yes | trade | 2026-03-08 |
| /trade/bucketed | GET | optional | yes | yes | yes | yes | tradeBin1m / 5m / 1h / 1d | 2026-03-08 |
| /quote | GET | optional | yes | yes | yes | yes | quote | 2026-03-08 |
| /quote/bucketed | GET | optional | yes | yes | yes | yes | quoteBin1m / 5m / 1h / 1d | 2026-03-08 |
| /orderBook/L2 | GET | **required** | no | no | no | no | orderBookL2 | 2026-03-08 |
| /instrument | GET | optional | yes | yes | yes | yes | instrument | 2026-03-08 |
| /instrument/active | GET | — | no | no | no | no | — | — |
| /instrument/activeAndIndices | GET | — | no | no | no | no | — | — |
| /instrument/indices | GET | — | no | no | no | no | — | — |
| /instrument/compositeIndex | GET | optional | yes | yes | yes | yes | — | — |
| /funding | GET | optional | yes | yes | yes | yes | funding | 2016-05-07 |
| /settlement | GET | optional | yes | yes | yes | yes | settlement | 2015-05-01 |
| /insurance | GET | currency | yes | yes | yes | yes | insurance | 2016-02-28 |
| /liquidation | GET | optional | yes | yes | yes | yes | liquidation | 2026-03-08 |
| /announcement | GET | — | no | no | no | yes | announcement | — |
| /announcement/urgent | GET | — | no | no | no | no | — | — |
| /chat | GET | — | yes (no start/reverse) | no | no | no | chat | — |
| /chat/channels | GET | — | no | no | no | no | — | — |
| /chat/connected | GET | — | no | no | no | no | connected | — |
| /stats | GET | — | no | no | no | no | — | — |
| /stats/history | GET | — | no | no | no | no | — | — |
| /schema | GET | — | no | no | no | no | — | — |
| /schema/websocketHelp | GET | — | no | no | no | no | — | — |
| /leaderboard | GET | — | yes (no reverse) | no | no | no | — | — |

---

## Private Endpoints

| Endpoint | Methods | Required args | symbol | Paginated | Time range | filter | columns | WS table |
|---|---|---|---|---|---|---|---|---|
| /order | GET | — | optional | yes | yes | yes | yes | order |
| /order | POST | symbol | — | — | — | — | — | order |
| /order | PUT | orderID or origClOrdID | — | — | — | — | — | order |
| /order | DELETE | orderID or clOrdID | — | — | — | — | — | order |
| /order/all | DELETE | — | optional | — | — | — | — | order |
| /order/cancelAllAfter | POST | timeout | — | — | — | — | — | — |
| /order/closePosition | POST | symbol | — | — | — | — | — | order |
| /execution | GET | — | optional | yes | yes | yes | yes | execution |
| /execution/tradeHistory | GET | — | optional | yes | yes | yes | yes | — |
| /position | GET | — | — | count only | no | yes | yes | position |
| /position/leverage | POST | symbol, leverage | — | — | — | — | — | leverage |
| /position/crossLeverage | POST | symbol, leverage | — | — | — | — | — | leverage |
| /position/isolate | POST | symbol, enabled | — | — | — | — | — | isolation |
| /position/riskLimit | POST | symbol, riskLimit | — | — | — | — | — | — |
| /position/transferMargin | POST | symbol, amount | — | — | — | — | — | margin |
| /user/margin | GET | — | currency | no | no | no | no | margin |
| /user/wallet | GET | — | currency | no | no | no | no | wallet |
| /user/walletHistory | GET | — | currency | yes (no time range) | no | no | no | transact |
| /user/walletSummary | GET | — | currency | no | yes | no | no | — |
| /user/affiliateStatus | GET | — | currency | no | no | no | no | affiliate |
| /user/csa | GET | — | — | no | no | no | no | csastate |
| /user/commission | GET | — | — | no | no | no | no | — |
| /user/depositAddress | GET | currency | — | no | no | no | no | — |
| /user/requestWithdrawal | POST | currency, amount, address | — | — | — | — | — | — |
| /user/tradingVolume | GET | — | — | no | no | no | no | — |

---

## Other Endpoints

Included for completeness. Unlikely to be useful for data collection or trading automation, but listed here so the doc covers the full API surface.

| Endpoint | Methods | Description |
|---|---|---|
| /address | GET, POST, PUT | Saved withdrawal addresses (address book) |
| /addressConfig | GET | Address book settings |
| /apiKey | GET | List your API keys |
| /apiKey/self | GET | Get the API key used in the current request |
| /chat/pinned | GET | Get pinned message for a channel |
| /globalNotification | GET | Global platform notifications for your account |
| /guild | GET, POST, PUT | Guild (trading group) — read, create, update |
| /guild/archive | POST | Archive a guild |
| /guild/join | POST | Join or request to join a guild |
| /guild/kick | POST | Kick a member from your guild |
| /guild/leave | POST | Leave a guild |
| /guild/shareTrades | POST | Toggle whether guild members can see your orders/positions |
| /instrument/activeIntervals | GET | All active contract series and interval pairs |
| /instrument/usdVolume | GET | Exchange-wide volume summary in USD |
| /leaderboard/name | GET | Your alias on the leaderboard |
| /leagueoftrader/myRankings | GET | Leaderboard rankings for accounts you own |
| /porl/nonce | GET | Proof of Reserves nonce and data |
| /porl/snapshots | GET | Proof of Reserves historical snapshots |
| /referralCode | GET, POST | List or create referral codes |
| /referralCode/check/{code} | GET | Check if a referral code is valid |
| /referralCode/code/{code} | GET | Get a referral code by code string |
| /referralCode/{id} | GET, PUT, DELETE | Read, update, or delete a referral code |
| /stats/historyUSD | GET | Historical exchange statistics in USD |
| /trading-bots/instances | GET, POST | List or create bot instances |
| /trading-bots/instances/preview | POST | Preview simulated orders for a bot config without starting it |
| /trading-bots/instances/{instanceId} | GET | Get a bot instance including performance metrics |
| /trading-bots/instances/{instanceId}/pause | POST | Pause a running bot |
| /trading-bots/instances/{instanceId}/resume | POST | Resume a paused bot |
| /trading-bots/instances/{instanceId}/stop | POST | Stop a bot (terminal); optionally close open orders |
| /trading-bots/marketplace | GET | Browse public bots with performance metrics |
| /trading-bots/marketplace/{instanceId} | GET | Get a single public bot's marketplace details |
| /trading-bots/strategies | GET | List available bot strategies |
| /trading-bots/strategies/{strategyId} | GET | Get a strategy schema by ID |
| /user | GET | Your full user profile |
| /user/addSubaccount | POST | Create a sub-account |
| /user/cancelWithdrawal | POST | Cancel a pending withdrawal |
| /user/checkReferralCode | GET | Check if a referral code is valid |
| /user/communicationToken | POST | Register a push notification token (mobile) |
| /user/confirmEmail | POST | Confirm email address with a token |
| /user/confirmWithdrawal | POST | Confirm a withdrawal with a token |
| /user/createIndependentSubaccount | POST | Create an independent sub-account with its own email |
| /user/depositAddressInformation | GET | Deposit address details including network info |
| /user/executionHistory | GET | Execution history aggregated by day |
| /user/getWalletTransferAccounts | GET | Accounts available for internal wallet transfers |
| /user/logout | POST | Log out (invalidate session) |
| /user/marginingMode | POST | Switch between single-asset and multi-asset margining |
| /user/preferences | POST | Save user preferences |
| /user/quoteFillRatio | GET | Quote fill ratio statistics (last 7 days) |
| /user/quoteValueRatio | GET | Quote value ratio statistics (last 3 days) |
| /user/staking | GET | Current staking amount |
| /user/staking/instruments | GET | List stakeable instruments |
| /user/staking/tiers | GET | Staking tiers for a currency |
| /user/unstakingRequests | GET, POST, DELETE | Manage unstaking requests |
| /user/updateSubaccount | POST | Rename a sub-account |
| /user/walletTransfer | POST | Transfer funds between linked accounts |
| /user/withdrawal | DELETE | Cancel a pending withdrawal |
| /userAffiliates | GET | Affiliate tree for your account up to a given depth |
| /userEvent | GET | User event log |
| /userPriceAlert | GET, POST, DELETE | Manage price alerts |
| /userPriceAlert/{id} | PUT, DELETE | Update or delete a specific price alert |
| /wallet/assets | GET | Supported asset configuration |
| /wallet/haircuts | GET | Currency haircut configuration |
| /wallet/networks | GET | Supported deposit/withdrawal network configuration |

---

## Column Definitions

- **symbol** — how the symbol parameter works for this endpoint:
  - `optional` — can be omitted (returns all symbols) or provided to filter to one symbol
  - `required` — must be supplied; the request fails without it
  - `currency` — takes a currency code (e.g. `XBt`) rather than a trading symbol
  - `—` — no symbol or currency parameter exists
- **Paginated** — whether the endpoint supports `count` (max rows per request), `start` (row offset), and `reverse` (newest-first ordering); `count only` means count is accepted but start/reverse are not
- **Time range** — whether `startTime` and `endTime` query parameters are accepted (ISO 8601 strings); see Notes for the startTime bug
- **filter** — whether a JSON-encoded `filter` object is accepted to narrow results by any field (e.g. `{"side":"Buy"}`)
- **columns** — whether a comma-separated or JSON-encoded `columns` list is accepted to select a subset of response fields
- **WS table** — the WebSocket table that streams equivalent data; see `WS_TABLES.md` for subscription details
- **Since** — earliest date with data in `/data/bitmex/vault/`; `—` means no vault data collected

---

## Notes

**Pagination defaults** — `count` defaults to 100 on all paginated endpoints; maximum is 500. `reverse` defaults to false (ascending, oldest-first). Use `reverse=true` with `count=500` and walk backward using `endTime` to page through history without gaps.

**startTime/endTime bug** — documented in `REST_STARTTIME_BUG.md`. The `startTime` filter is exclusive on some endpoints and the behaviour is inconsistent across table types. Use `endTime` for reliable backward pagination; treat `startTime` as a rough lower bound only.

**filter parameter** — accepts a JSON object as a query string value; keys are field names from the response schema. Example: `filter={"side":"Buy"}`. Dot-notation for nested fields is not supported. On endpoints that also accept `symbol` as a standalone param, `filter={"symbol":"XBTUSD"}` is equivalent.

**columns parameter** — accepts either a comma-separated string or a JSON array. Reducing columns significantly cuts response size for wide schemas (instrument has ~100 fields). The `symbol` field is always included even if not requested.

**POST /order body format** — BitMEX expects `application/x-www-form-urlencoded` (formData), not JSON. The swagger marks `orderID` and `origClOrdID` as both optional for PUT, but at least one is required — the request is rejected without an order identifier.

**GET /position** — not fully paginated. It accepts `count` but no `start` or `reverse`, and no time range. It returns all currently open positions; there is no way to page through historical position state via this endpoint. Use `/execution` for historical fills.

**GET /user/walletHistory** — returns transaction records (the `transact` WS table equivalent). Supports `count`, `start`, `reverse` but no time range filter. The `currency` param controls which currency's ledger is returned; omit for all currencies.

**DELETE /order/all** — cancels all open orders for the authenticated account. Optional `symbol` narrows cancellation to one instrument. Returns the array of canceled orders.

**POST /order/cancelAllAfter** — sets a server-side dead-man's switch: all orders are canceled `timeout` milliseconds from now unless the call is repeated before expiry. Sending `timeout=0` disarms it.

**instrument sub-endpoints** — `/instrument/active` returns only currently tradeable instruments (no indices). `/instrument/activeAndIndices` adds index symbols (`.`-prefixed). `/instrument/indices` returns only index symbols. None accept pagination or time range — they are point-in-time snapshots of current state.

---

## Endpoint Descriptions

### /trade

The primary tick-level trade feed. Each record is one matched trade: timestamp, symbol, side (Buy/Sell), size, price, tickDirection, and a trdMatchID. The endpoint is insert-only; there is no concept of updating or deleting a trade.

Fully paginated with time range support. For bulk historical collection, page backward with `reverse=true&count=500`, decrementing `endTime` to the timestamp of the last received record on each page. The WS `trade` table delivers the same schema in real time.

### /trade/bucketed

OHLCV bars aggregated server-side. The `binSize` param selects the resolution: `1m`, `5m`, `1h`, `1d`. If omitted, defaults to `1m`. Each bar has open, high, low, close, volume, vwap, lastSize, turnover, homeNotional, foreignNotional.

The `partial` boolean parameter (default false) controls whether the currently incomplete bar is included in the response. When collecting history, keep it false.

### /quote

Best bid/ask snapshots. Each record is a `bidPrice`, `bidSize`, `askPrice`, `askSize` at a timestamp for a symbol. Same pagination and time range support as `/trade`. The WS `quote` table streams equivalent data live.

### /quote/bucketed

Best bid/ask bucketed into OHLC form per side. Takes the same `binSize` and `partial` params as `/trade/bucketed`. Less commonly used than trade bucketed.

### /orderBook/L2

Current limit order book snapshot. `symbol` is required. `depth` controls how many levels per side to return (default 25, 0 = full book). This is a point-in-time snapshot only — no time range or pagination. The WS `orderBookL2` table provides the live delta stream.

### /instrument

Full instrument metadata. Returns one record per instrument matching the query. With time range, returns historical instrument state snapshots (e.g. past funding rates, open interest history). Without time range, returns current state of all matching instruments.

The `instrument.json` file in this docs directory contains a sample response with all ~100 fields annotated.

### /funding

Historical funding rate records. One record per funding event per symbol: timestamp, symbol, fundingInterval, fundingRate, fundingRateDaily. Perpetual contracts fund every 8 hours. Paginate backward with `reverse=true` to collect full history.

### /settlement

Settlement records for expired contracts. One record per settled contract. Since each symbol settles once, this is effectively the full list of all contracts that ever closed on BitMEX. `settlementType` distinguishes cash settlement from funding settlements.

### /liquidation

Liquidation events. Each record has orderID, symbol, side, price, leavesQty. Liquidations are a subset of the public trade feed, filtered to forced-close events. Shares the same full pagination + time range interface as `/trade`.

### /order (GET)

Returns orders for the authenticated account. By default includes terminal orders (Filled, Canceled); use `filter={"ordStatus":"New"}` to narrow to open orders only. Paginated with time range — the full order history is accessible.

### /order (POST)

Creates a new order. `symbol` is the only required field. Key optional fields:

| Field | Description |
|---|---|
| side | `Buy` or `Sell` (default: closes if position exists) |
| orderQty | Quantity in contracts |
| price | Limit price; omit for Market orders |
| ordType | `Market`, `Limit`, `Stop`, `StopLimit`, `MarketIfTouched`, `LimitIfTouched`, `Pegged` (default: `Limit`) |
| timeInForce | `Day`, `GoodTillCancel`, `ImmediateOrCancel`, `FillOrKill` (default: `GoodTillCancel`) |
| execInst | Comma-separated execution instructions: `ParticipateDoNotInitiate`, `AllOrNone`, `MarkPrice`, `LastPrice`, `IndexPrice`, `Close`, `ReduceOnly`, `Fixed` |
| clOrdID | Client-assigned order ID (max 36 chars); must be unique per account |

Returns the order document as created, including the server-assigned `orderID`.

### /order (PUT)

Amends an existing open order. Identified by `orderID` (server ID) or `origClOrdID` (client ID). Amendable fields: `orderQty`, `leavesQty`, `price`, `stopPx`, `pegOffsetValue`. Reducing `orderQty` below `cumQty` cancels the order.

### /order (DELETE)

Cancels an order. Identified by `orderID` or `clOrdID`. Both params accept comma-separated lists for bulk cancellation in one request. Returns the canceled order documents.

### /execution

Every fill event for the authenticated account. Each record is one partial or full fill, not one order — an order filled in multiple tranches produces multiple execution records. Shares the same schema as the WS `execution` table.

Key fields: execID, orderID, clOrdID, symbol, side, lastQty, lastPx, cumQty, avgPx, ordStatus, execType, timestamp.

For accounting, `execType=Trade` records are the fills; `execType=New`, `Canceled`, etc. are order lifecycle events.

### /position

Current open positions for the authenticated account. Point-in-time; no historical state. Key fields: symbol, currentQty, avgEntryPx, markPrice, unrealisedPnl, realisedPnl, liquidationPrice, leverage, crossMargin.

Accepts `filter` and `columns` for field selection but is not fully paginated — no `start` or `reverse`. Closed positions are not returned.

### /user/margin

Account margin summary. Returns a single object with walletBalance, marginBalance, availableMargin, unrealisedPnl, realisedPnl, maintMargin, initMargin, and more. The `currency` param selects the account currency (default `XBt`). Equivalent to the WS `margin` table snapshot.

### /user/wallet

Wallet balance for the authenticated account. Returns `amount` and `currency`. Simpler than `/user/margin`. The `currency` param selects which currency wallet to return.

### /user/walletHistory

Full transaction ledger: deposits, withdrawals, funding payments, realised PnL settlements, fees. Paginated by `count`/`start`/`reverse` but no time range. Each record has `transactID`, `transactType`, `amount`, `fee`, `address`, `timestamp`. Equivalent to the WS `transact` table.
