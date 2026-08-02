# BitMEX Trade & Quote Stream Analysis

Findings from empirical analysis comparing the WebSocket stream against the REST API historical feed,
using a MongoDB collection of ~15M captured WS messages (`tradebot_unpacked`, ~16 days of data).

---

## WS ↔ REST API equivalence

Individual trade and quote items are **identical** between the WebSocket stream and the REST API.
Given a time range and count, the REST API returns the exact same entries as the WS stream,
field-for-field, when sorted deterministically.

**Deterministic sort keys:**

- `trade`: `timestamp` → `symbol` → `size` → `trdMatchID`
- `quote`: `timestamp` → `symbol` → `bidSize`

Ties on `timestamp + symbol` do occur (multiple events at the same millisecond), so additional
tiebreakers are necessary for a stable sort. Within a tie group, size and trdMatchID order is
consistent between both sources.

**Verified experimentally**: 2292 multi-symbol trade entries and 587 XBTUSD quote entries matched
exactly between WS and REST after sorting.

---

## WS message grouping (sweeps)

The `data` array in a WS insert message (`_id % 4 === 1`) can contain more than one item.
About 1.5% of all insert messages are grouped (214,687 sweeps in 14.7M documents).

### Properties of grouped messages

- All items share the **same timestamp, symbol, and side** — verified across all 14.7M insert
  documents with zero exceptions.
- Items have **different prices**, walking through consecutive book levels (or multiple limit orders
  at the same level).
- Items have **different `trdMatchID`s** — each is a separate match event against one resting order.
- The **same price level can repeat** within a group (288/309 mixed-price sweeps had repeated
  levels), meaning multiple distinct limit orders can rest at the same price.
- Only `Regular` and `Settlement` trades appear in sweeps. `Referential` trades are never grouped.

### What a sweep represents

A grouped message is a **market order sweeping through the book**. Each item is one fill against one
resting order. The group boundary is the order boundary — all fills in one message came from one
aggressor order.

Single-item insert messages are trades that consumed only one resting order (one fill, one level),
or IOC/FOK orders that stopped after the first fill.

### Sweep size distribution (across 214,687 sweeps)

| Items per group | Count |
|---|---|
| 2 | 123,684 (58%) |
| 3 | 38,183 (18%) |
| 4–5 | 25,858 (12%) |
| 6–9 | 14,806 (7%) |
| 10–19 | 7,734 (4%) |
| 20–49 | 4,356 (2%) |
| 50+ | 66 (<1%) |

Max observed: 173 items in a single sweep (XBTUSD).

### Level span distribution (distinct price levels per sweep)

43% of sweeps consume only 1 distinct price level (multiple limit orders at the same price).
The remainder walk the book:

| Distinct levels | Count |
|---|---|
| 1 | 92,598 (43%) |
| 2 | 68,701 (32%) |
| 3 | 20,259 (9%) |
| 4–5 | 15,112 (7%) |
| 6–9 | 9,925 (5%) |
| 10–19 | 4,759 (2%) |
| 20+ | 3,333 (2%) |

### Sweep distribution by symbol

Sweeps concentrate heavily on liquid instruments:

| Symbol | Sweeps | Avg items | Zero-span % | Avg price span |
|---|---|---|---|---|
| XBTUSD | 83,482 | 3.66 | 45% | 0.35 bps |
| XBTUSDT | 24,436 | 3.59 | 15% | 0.53 bps |
| XBT_USDT | 20,920 | 7.86 | 9% | 1.23 bps |
| SOLUSDT | 11,298 | 2.51 | 78% | 0.41 bps |
| ETHUSDT | 9,783 | 2.80 | 10% | 0.64 bps |
| SUIUSDT | 9,517 | 2.57 | 69% | 0.59 bps |
| DOGEUSDT | 8,753 | 2.42 | 81% | 0.32 bps |
| XRPUSDT | 8,648 | 2.59 | 67% | 0.42 bps |

Less liquid instruments rarely produce sweeps. The high zero-span rates on SOLUSDT, DOGEUSDT, SUIUSDT
indicate thin books where multiple orders stack at the same price.

---

## Multiple sweeps in the same millisecond

It is possible for two separate sweep groups to share the same `timestamp + symbol + side`:

| Concurrent groups | ms-slots | Notes |
|---|---|---|
| 1 | 204,918 | Unambiguous — one actor |
| 2 | 4,427 | Two actors |
| 3 | 270 | Three actors |
| 4 | 22 | |
| 5–6 | 3 | Extremely rare |

**2,243 of these multi-actor ms-slots involve sweeps with 2+ distinct price levels** (i.e., multiple
actors each consuming multiple levels simultaneously) — ~1% of all multi-level sweep events.

**Key finding: these are coincidental, not coordinated.** Per-actor level span decreases as actor
count increases (avg 2.62 levels/group with 1 actor, down to ~1.7 with 4 actors). The largest
individual sweeps (up to 106 levels) always come from a single actor. Multi-actor slots are smaller
coincident orders, not whale coordination.

**Can the REST API detect concurrent sweeps?** Only 3% of concurrent sweep pairs produce a
non-monotonic price sequence (a reversal mid-sweep) that would hint at multiple actors. The other
97% are indistinguishable from a single sweep in the REST feed.

---

## trdMatchID

`trdMatchID` is a UUID identifying a single **match event** — one fill between one aggressor and one
resting order.

| trdType | trdMatchID present |
|---|---|
| `Regular` | Always |
| `Settlement` | Always |
| `Referential` | Never |

Key properties:

- **One ID = one resting order**, not one price level. Multiple limit orders at the same price each
  get their own `trdMatchID`.
- **Partial fills included**: a resting order partially consumed still gets its own ID. There is no
  distinction between partial and full fills in the public feed.
- **Cross-feed link**: the same `trdMatchID` appears in the private `Execution` feed, letting a
  trader match a public trade to their own private fill. This is its primary purpose.
- **No aggressor identity**: the ID belongs to the match event, not the aggressor. There is no
  aggressor order ID anywhere in the public feed. The WS group boundary is the only aggressor signal.

---

## Quote vs Trade grouping

- **Quote**: always single-item insert messages. No grouping observed.
- **Trade**: grouped messages occur on the most liquid instruments. Less active symbols produce only
  single-item messages.

Quote and trade together account for ~30% of all WS messages.

---

## Partial messages (action = `_id % 4 === 0`)

The initial snapshot on WS subscription is a `partial` action. These contain 1000+ items spanning
all symbols with mixed sides and trdTypes — not trade events, just the current table state. Exclude
from all stream analysis by filtering to `_id % 4 === 1` (inserts).

---

## Conclusion: can the REST API replace the WS stream for trade/quote?

| Use case | REST sufficient? |
|---|---|
| Reconstructing individual trades/quotes | Yes — exact match verified |
| Detecting that a sweep occurred | Yes — cluster by ts+symbol+side |
| Identifying a single aggressor order's full fill | Yes — when no concurrent actors |
| Distinguishing concurrent multi-level sweeps | **No** — merges into one in REST (97% undetectable) |
| Detecting whale coordination vs. coincidence | Moot — concurrent sweeps are coincidental, not coordinated |

**Practical verdict**: the information lost by dropping WS trade collection (actor identity on ~1%
of multi-level sweep events) is not recoverable from REST, but analysis shows those cases are
coincident small orders rather than meaningful coordinated activity. The largest and most impactful
sweeps are always single-actor and fully recoverable from REST. Continuing WS collection is
reasonable as insurance, but the REST API is sufficient for all known analytical use cases.
