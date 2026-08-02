# Fair Price Marking (BitMEX)

> Source: <https://www.bitmex.com/app/fairPriceMarking>
> Verbatim copy of the BitMEX reference page (captured from a saved MHTML of the
> rendered page). Page chrome (nav, footer, ticker) omitted; documentation body kept
> faithfully. This is the authoritative definition of the `markMethod` modes the
> instrument distiller must reproduce — do not paraphrase the formulas from memory.

## Sections

- Overview
- Calculation of Fair Price for Perpetual Contracts
- Calculation of Fair Price for Futures Contracts
- Impact Bid, Ask, and Mid Price
- Fair Price Derivation
- Exceptions
- Last Price Marking
- Last Price Adjusted Marking
- Last Price Protected Marking
- Last Price Pre-Launch Marking
- FairPriceStox
- Reduce-only Restrictions

## Overview

BitMEX employs a unique system called Fair Price Marking to avoid unnecessary
liquidations in its highly leveraged products. Without this system, unnecessary
liquidations may occur if the market is being manipulated, is illiquid, or the Mark
Price swings unnecessarily relative to its Index Price. The system is able to achieve
this by setting the Mark Price of the contract to the Fair Price instead of the Last
Price.

For Perpetual Contracts, the Fair Price is equal to the underlying Index Price plus a
decaying Funding basis rate.

For Futures Contracts, the Fair Price is equal to the underlying Index Price plus an
annualised Fair Value basis rate, known as the % Fair Basis.

All ADL contracts are subject to Fair Price Marking. Also note that Fair Price Marking
only affects the Liquidation Price and Unrealised PNL, it does not affect Realised PNL.

Note: This means that you may see a positive or negative Unrealised PNL immediately
after an order executes. This happens when the Fair Price is slightly different from the
Last Price. This is normal and does not mean you have lost money, but be sure to keep an
eye on your Liquidation Price to avoid a premature liquidation.

Further information on the composition and calculation of BitMEX indices is available.

## Calculation of Fair Price for Perpetual Contracts

The Fair Price for a Perpetual Contract is calculated using only the Funding Basis rate:

```
Funding Basis = Funding Rate * (Time Until Funding / Funding Interval)
Fair Price    = Index Price * (1 + Funding Basis)
```

For further information on perpetual contract funding calculations and examples please
see the Funding Section in the Perpetual Contracts Guide.

## Calculation of Fair Price for Futures Contracts

The Fair Price marking calculation for Futures Contracts is slightly different to a
Perpetual Contract, and is done by comparing the Impact Mid Price of a contract to its
underlying Index Price. This is used to calculate the % Fair Basis which is then used in
the derivation of the Fair Price.

## Impact Bid, Ask, and Mid Price

```
Impact Mid Price = Average (Impact Bid Price, Impact Ask Price) where;
Impact Bid Price = The average fill price to execute the Impact Notional on the Bid side
Impact Ask Price = The average fill price to execute the Impact Notional on the Ask side
```

The Impact Notional is used to determine how deep in the order book to measure either
the Impact Bid or Ask Price and is set to:

| Contracts | Impact Notional |
|---|---|
| All Perpetual Swaps | USD 10,000 |
| Quanto Futures | USD 10,000 |
| Linear Futures | USD 50,000 |
| XBT Inverse Futures | USD 200,000 |

## Fair Price Derivation

Once BitMEX has calculated the Impact Mid Price, it can use this number to calculate the
% Fair Basis. The % Fair Basis will then be used to calculate the Fair Value of the
futures contract which is added to the Index Price to finally create the Fair Price which
is used for marking purposes.

```
% Fair Basis = (Impact Mid Price / Index Price - 1) / (Time To Expiry / 365)
Fair Value   = Index Price * % Fair Basis * (Time to Expiry / 365)
Fair Price   = Index Price + Fair Value
```

For Example:

```
Impact Mid Price = $105
Underlying Index = $100
Time To Expiry = 30 Days

% Fair Basis = ($105 / $100 - 1) / (30 / 365) = 60.8%
Fair Value = $100 * 60.8% * (30/365) = $5
Fair Price = $100 + $5 = $105
```

Note on Calculation: The % Fair Basis is updated every 30 seconds but only if the
difference between the Impact Ask Price and Impact Bid Price is less than the maintenance
margin of the futures contract (or 3 ticks on the contract whichever is larger). After it
has been updated the Fair Price will be equal to the Impact Mid Price, and then the Fair
Price will float with regard to the Index Price and the time-to-expiry decay on the
contract until the next update.

## Exceptions

Occasionally, due to index instability or price unavailability, a contract may need to be
moved to an alternative mode, LastPriceAdjusted, LastPriceProtected, LastPrice or
LastPricePreLaunch. There is no external price available to mark our Yield Swaps, so they
use LastPriceAdjusted. Historically LastPriceProtected or LastPrice have been used for the
XBJ contracts due to pricing anomalies and for the ETHPOW contracts.

In the case of any such anomalies or unexpected price unavailability, notice will be sent
as the marking method is changed.

## Last Price Marking

Last Price is a marking mode that uses the Last Price traded every 5 second for marking,
and is often, but not always used with some limitations on price movements per trading
session (usually 1 hour) relative to the mark price at the beginning of the session, so
as not to discourage manipulation.

Any price limits are defined as Limit Up (bids cannot be placed above this level) and
Limit Down (asks cannot be placed below this level). Price limits will update every
trading session and the values can be found in the contract specifications and on the
trading UI.

For API consumers, this field is available on the instrument feed as lastPrice.

## Last Price Adjusted Marking

Last Price Adjusted is a marking mode that functions similarly to simple Last Price
marking, but with adjustments to allow for Yield Swap Floating Funding payments.

The Price is adjusted to take into account the next Floating Funding payment:

```
Adjusted Mark Price = Last Price + (Yield Index - Last Price) * Time Fraction / Days until expiry
```

The Time Fraction is defined as:

```
Time Fraction = (Current time - Yield Index Fixing Time)/(Next Floating Funding payment time - Yield Index Fixing Time)
```

When the Yield Index has just fixed, Time Fraction = 0
When the Floating Funding is about to be paid, Time Fraction = 1

For API consumers, this field is available on the instrument feed as lastPriceAdjusted.

## Last Price Protected Marking

Last Price Protected is a marking mode that functions similarly to simple Last Price
marking, but with some protections for our users as not to cause unnecessary
liquidations.

A price band is created equal to 1 maintenance margin (0.5x each way) around the
previously-calculated Mark Price (also known as the Fair Price, calculated above).

The Mark Price is equal to the Last Price, but only within this band created by the Fair
Price. If the band moves, the Mark Price will stay. It is allowed to move toward the band
but not away from it.

For API consumers, this field is available on the instrument feed as lastPriceProtected.

## Last Price Pre-Launch Marking

Last Price Pre-Launch is a marking mode designed for contracts where no observable
external market price exists for the underlying asset. Like standard Last Price Marking,
it uses the Last Price traded to mark the contract, with Price Limits applied to
discourage manipulation. Please refer to the Last Price Marking section for a detailed
explanation of how it works.

This mark method is intended as a temporary mechanism and expected to transition to Fair
Price or FairPriceStox marking once a robust underlying index is available. Any such
transition will be communicated to users in advance and remains at the sole discretion of
BitMEX.

For API consumers, this field is available on the instrument feed as lastPricePreLaunch.

## FairPriceStox

FairPriceStox is an adjusted marking methodology aiming to incorporate data from
traditional financial markets as well as digital asset prices. These contracts track the
price of tokenised stocks on various crypto exchanges. In addition to this, prices from
traditional markets are provided by external data providers and incorporated into the
index. A final input is taken as the median of bid, ask, last from the perpetual contract
on BitMEX that is marked to this index.

These indices follow the BitMEX Index Protection Rules, so stale values will be excluded
from the index after 15 minutes of inactivity or if they deviate significantly from other
components (it is expected that the traditional finance prices will drop out soon after
their markets close).

The only exception to this drop out is the final BitMEX component of the index, which will
not be excluded from the index calculation under any circumstances - so in the event that
all other index components are stale, this contract will be effectively marked to
median(bid, ask, last). In addition, during periods when BitMEX price is the only
remaining component in the index (ie. its weighting is 100%), there will be 2% price bands
applied to the current price which operate in the same way as LimitUp and LimitDown prices
for Last Price Marked contracts, and are reset hourly to be centred around the last price.

## Reduce-only Restrictions

Contracts using Last Price marking and selected contracts using other marking methods are
subject to reduce-only restrictions.

If the proportion of the aggregated open position for a contract across all your accounts
(i.e. including all sub-accounts) is greater than 20% of the total open value of that
contract on BitMEX, reduce-only restrictions for that contract will be automatically
applied on all your accounts. These restrictions mean that you cannot increase your
position in that contract past 20% of open value. The restriction will be automatically
lifted once you are below 20% of open value.

Please note that BitMEX reserves the right to update the ratio (20%) and include new
contracts to this restriction from time to time, depending on market conditions.
