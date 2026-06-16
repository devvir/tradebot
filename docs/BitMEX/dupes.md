# BitMEX duplicate messages

BitMEX WebSocket data contains duplicate messages from two distinct sources. This
note explains both, the reconnection bug that produced most of them, what the data
now looks like, and how they are removed. It concerns the `instrument` and
`orderBookL2` tables — the only two affected.

## Two sources of duplicates

**1. Exchange-origin duplicates — low but not negligible.** BitMEX itself re-sends
identical messages from time to time: the same symbol, same exchange `timestamp`,
same field values, delivered twice. This is independent of our collection and shows
up in every WS source. On a clean day it accounts for ~0.009% of `instrument`
messages — small, but real, and always present.

**2. The ghost-subscription reconnection bug — large, bursty, our own.** A stale
lingering WS connection re-delivers the same event stream in parallel with the live
one, so entire publish batches (many symbols sharing one exchange `timestamp`)
appear twice, the second copy lagging by seconds. This is *our* collection bug, not
the exchange's, and it produced the overwhelming majority of duplicates in the
affected period.

## The reconnection bug

The bug surfaced on process crashes and bad manual reconnections — a connection that
was never cleanly torn down kept delivering. Because of that trigger, it tracked the
stability of the collecting host:

- **`local`** (this workstation, frequently under heavy load and prone to crashes)
  lit up repeatedly through April and into mid-May 2026.
- **`mtav`** (a dedicated, stable feed) had only a single affected day —
  2026-04-24, ~9.9% — consistent with one isolated bad reconnect.

The episodes, by `instrument` message drop rate on `local`:

```
2026-04-07   9.3%   ┐
2026-04-08  21.0%   ├ first cluster (onset 04-07, peak 04-08, taper 04-09)
2026-04-09   7.0%   ┘
2026-04-12   2.4%
2026-04-14   6.7%
2026-04-19  47.5%   ┐ worst cluster
2026-04-20  39.5%   ┘
2026-04-22   2.8%
2026-04-23   6.1%
2026-05-14  26.0%   ← last episode before the fix
```

`2026-05-14` is the **last** day with a ≥1% drop. The fix landed around
**2026-05-15**: across the 32 days that follow, the maximum `local` drop is 0.009%
— i.e. back down to the exchange-origin baseline. So the contaminated window is a
recurring April-to-mid-May condition, not a single incident, and it is closed.

## Per-source picture (full-year 2026 instrument validation)

| Source | What it is | Overall drop | Notes |
|---|---|---:|---|
| `tardis` | third-party feed | **0.000%** | already sanitized against duplicates — needs no dedup |
| `mtav` | dedicated feed | ~0.18% | mostly 0; one ghost day (2026-04-24) |
| `local` | this host's WS capture | ~2.72% | all the mass is the April–mid-May ghost days above |

`tardis` is notable: across the sampled buckets it dropped exactly zero messages,
so the Tardis pipeline appears to de-duplicate (or never duplicates) at source.
Treat third-party feeds as clean unless shown otherwise.

## How duplicates are removed

The `tools data dedup` command removes them; see
[docs/tooling/DATA-DEDUP.md](../tooling/DATA-DEDUP.md) for the full algorithm. In
short: it keys each message on its full content with `_date_` stripped (so the same
exchange event collides regardless of reception time), tracks a monotonic clock of
the maximum exchange `timestamp` seen, and drops an already-seen message only when
its `timestamp` is more than `threshold` (default 500 ms) behind that clock — i.e.
a late re-delivery from a lagging parallel stream. Legitimate same-millisecond
oscillations and exchange re-sends within the threshold are kept. Scoped to
`instrument` and `orderBookL2`.

The default threshold was tuned against a ghost-free `mtav` control: at 500 ms it
removed **zero** legitimate messages (the only legitimate same-content/different-event
messages lag at most ~500 ms). So at the default, false positives are effectively
nil, and the small residual drop on clean days (~0.009%) is the exchange-origin
duplicates, not the tool over-removing.

## Current state

The affected data — our own WS-collected `instrument` and `orderBookL2` from
**2026-03-08 onward** (the start of this collection) — is being deduped and
reimported. MongoDB, cold storage, and the dumps are all being regenerated from the
deduped buckets. Once that pass completes, the stored data is clean and the problem
is resolved.

What remains is awareness for the future:

- Only our own collection in the affected window carried the ghost bug; it is fixed
  at the collection side as of ~2026-05-15.
- Exchange-origin duplicates (~0.009%) are intrinsic to BitMEX and will keep
  appearing at a low rate — dedup handles them too.
- Third-party feeds (`tardis`) arrive clean and do not need deduping.
