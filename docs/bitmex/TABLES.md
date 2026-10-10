# The BitMEX tables

The columns of every table, in the order they are written. This is the header row of each file.
Taken from the vault service's own definition, `services/vault/src/data/headers.ts`, which is what
wrote them.

| table | columns |
|---|---|
| `funding` | `timestamp`, `symbol`, `fundingInterval`, `fundingRate`, `fundingRateDaily` |
| `insurance` | `currency`, `timestamp`, `walletBalance` |
| `settlement` | `timestamp`, `symbol`, `settlementType`, `settledPrice`, `optionStrikePrice`, `optionUnderlyingPrice`, `bankrupt`, `taxBase`, `taxRate` |
| `compositeIndex` | `timestamp`, `symbol`, `indexSymbol`, `indexMultiplier`, `reference`, `lastPrice`, `sourcePrice`, `conversionIndex`, `conversionIndexPrice`, `weight`, `logged` |
| `tick` | `timestamp`, `symbol`, `price`, `tickDirection` |
| `trade` | `timestamp`, `symbol`, `side`, `size`, `price`, `tickDirection`, `trdMatchID`, `grossValue`, `homeNotional`, `foreignNotional`, `trdType`, `pool` |
| `quote`, `quoteBin1m`, `quoteBin5m`, `quoteBin1h`, `quoteBin1d` | `timestamp`, `symbol`, `bidSize`, `bidPrice`, `askPrice`, `askSize`, `pool` |
| `tradeBin1m`, `tradeBin5m`, `tradeBin1h`, `tradeBin1d` | `timestamp`, `symbol`, `open`, `high`, `low`, `close`, `trades`, `volume`, `vwap`, `lastSize`, `turnover`, `homeNotional`, `foreignNotional`, `pool` |
| `announcement` | `_date_`, `_action_`, `id`, `link`, `title`, `content`, `date` |
| `chat` | `_date_`, `_action_`, `channelID`, `date`, `html`, `id`, `message`, `user`, `userColor`, `flair`, `guild` |
| `connected` | `_date_`, `_action_`, `id`, `users`, `bots` |
| `instrument` | `_date_`, `_action_`, `symbol`, `rootSymbol`, `instrumentID`, `state`, `typ`, `listing`, `front`, `expiry`, `settle`, `listedSettle`, `relistInterval`, `positionCurrency`, `underlying`, `quoteCurrency`, `underlyingSymbol`, `reference`, `referenceSymbol`, `calcInterval`, `publishInterval`, `publishTime`, `maxOrderQty`, `minPrice`, `maxPrice`, `lotSize`, `tickSize`, `multiplier`, `settlCurrency`, `underlyingToPositionMultiplier`, `underlyingToSettleMultiplier`, `quoteToSettleMultiplier`, `isQuanto`, `isInverse`, `initMargin`, `maintMargin`, `riskLimit`, `riskStep`, `limit`, `taxed`, `deleverage`, `makerFee`, `takerFee`, `settlementFee`, `fundingBaseSymbol`, `fundingQuoteSymbol`, `fundingPremiumSymbol`, `fundingTimestamp`, `fundingInterval`, `fundingRate`, `indicativeFundingRate`, `rebalanceTimestamp`, `rebalanceInterval`, `launchingTimestamp`, `prevClosePrice`, `limitDownPrice`, `limitUpPrice`, `prevTotalVolume`, `totalVolume`, `volume`, `volume24h`, `prevTotalTurnover`, `totalTurnover`, `turnover`, `turnover24h`, `homeNotional24h`, `foreignNotional24h`, `prevPrice24h`, `vwap`, `highPrice`, `lowPrice`, `lastPrice`, `lastPriceProtected`, `lastTickDirection`, `lastChangePcnt`, `bidPrice`, `midPrice`, `askPrice`, `impactBidPrice`, `impactMidPrice`, `impactAskPrice`, `hasLiquidity`, `openInterest`, `openValue`, `fairMethod`, `fairBasisRate`, `fairBasis`, `fairPrice`, `markMethod`, `markPrice`, `referencePrice`, `indicativeSettlePrice`, `settledPriceAdjustmentRate`, `settledPrice`, `instantPnl`, `minTick`, `fundingBaseRate`, `fundingQuoteRate`, `farLegSymbol`, `nearLegSymbol`, `timestamp`, `pool` |
| `liquidation` | `_date_`, `_action_`, `orderID`, `symbol`, `side`, `price`, `leavesQty` |
| `orderBookL2` | `_date_`, `_action_`, `symbol`, `id`, `side`, `size`, `price`, `transactTime`, `timestamp`, `pool` |
| `publicNotifications` | `_date_`, `_action_`, `title`, `body`, `ttl`, `closable`, `persist`, `sound` |

- **A dotted name is a slice of the table before the dot**, with the same columns:
  `orderBookL2.secondary` is `orderBookL2` for the Secondary pool.
- **`_date_` and `_action_` open every table that came over the websocket.** `_date_` is when the
  message was received and is written on the first row of a message only; the rows after it, until
  the next `_date_`, are the rest of that message. `_action_` is the message's action: `partial`,
  `insert`, `update` or `delete`.
- **The other tables are plain rows**, as REST and the S3 dumps gave them.
- **How each value is typed and cast** is in `services/vault/src/data/casts.ts` and
  `shared/utils/src/tables.ts`; the websocket's own types are in `shared/types/src/bitmex.ts`.
