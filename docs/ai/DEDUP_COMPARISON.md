# Dedup comparison — local vs antel

Per-date dedup results across three runs.

- **local** / **antel** — original message count of the source (kept + dropped; identical for the local T0/T500 runs since they dedup the same source).
- **localT0** — dropped (%) from `local.T0.log` (aggressive, `-T0`).
- **localT500** — dropped (%) from `local.T500.log` (default, `-T500`).
- **useLocalT0** — whether to keep the T0 output for this date (see below). Format: `Yes/No (T0drops ÷ T500drops)`; ratio is `—` when T500 dropped 0.
- **antel** / **antel.T500** — antel original count and dropped (%) from `antel.T500.log` (dedicated remote, reliable; the primary source — local only fills its gaps).
- **antel.T0** (orderBookL2 table + instrument pass-2 table) — dropped (%) from running `-T0` on the *clean* antel source = the legit same-ms oscillation rate, since a ghost-free source has no other content repeats. **orderBookL2: 0** (no oscillations). **instrument: ~0.06%/day** (real oscillations — this is the empirical baseline for judging local T0-vs-T500 in pass 2).

`—` = source genuinely absent for that date. `?` = source present but dedup not yet run.

† local source for this date had corrupted gzip (binary garbage); values are **post-sanitize** — garbage removed (`scripts/sanitize-instrument.mjs`), then re-deduped.

## useLocalT0 rationale

T0 drops every same-content message; T500 keeps content repeats that arrive within 500ms of the clock. T0's drop set is a **superset** of T500's (anything dropped at 500ms distance is also dropped at 0), so the marginal effect of going aggressive is `T0effect = T0drops − T500drops` — the drops T0 *adds*. That marginal covers repeats at 0–500ms distance; it's not strict zero-gap contiguity, but close enough for our needs (to go tighter we'd just drop all dupes outright).

Most of those near-instant repeats are **legit oscillations** (a value flipping back and forth in the same instant) — false-dedup positives. Their healthy-day baseline is small but **table-specific** (orderBookL2's is ~10× lower than instrument's, since order-level deltas rarely repeat verbatim); each table's section below gives its own floor.

The **entangled ghost-subscription bug** is when 2+ parallel streams re-deliver verbatim with *no* time gap between repeats, so T500 cannot catch them — only T0 can. It shows up as `T0effect` far above the oscillation baseline — i.e. as an outlier.

The ratio (T0drops ÷ T500drops) is **not** the deciding factor — it explodes when T500≈0 regardless of payload (e.g. instrument 03-29 is 89x but only 0.07% effect). `T0effect` is the signal, and in practice the days split into a clean gap between FP-only (healthy) and entangled days with nothing in between.

Decision: **useLocalT0 = Yes when T0effect is a clear outlier** above the table's FP floor (the per-table threshold sits squarely in that empty gap) — the extra T0 drops are real entangled dupes worth removing. Otherwise No: T0 would only shave legit oscillations with no real-dupe gain. (Losing oscillations is acceptable since antel is primary and local only fills gaps; the bar is just "is there a real dupe payload to remove".)

## instrument

FP floor: healthy-day baseline ~0.06% (max 0.124%) of the file. Natural gap: **No** days have T0effect ≤ 0.16% (almost all ≤ 0.07%), **Yes** days ≥ 0.84% — threshold **0.2%**.

| date | local | localT0 | localT500 | useLocalT0 | antel | antel.T500 |
|------|------:|--------:|----------:|:----------:|------:|-----------:|
| 2026-03-08 | 4,238,200 | 1,259 (0.0%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-09 | 6,355,653 | 4,510 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-10 | 6,395,798 | 3,906 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-11 | 4,704,034 | 2,693 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-12 | 6,267,613 | 4,364 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-13 | 6,685,094 | 6,870 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-14 | 5,156,201 | 2,770 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-15 | 5,353,562 | 3,898 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-16 | 6,746,522 | 6,542 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-17 | 6,315,383 | 5,955 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-18 | 6,037,335 | 24,107 (0.4%) | 19,747 (0.3%) | No (1.2x) | — | — |
| 2026-03-19 | 6,262,970 | 4,295 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-20 | 6,340,852 | 3,629 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-21 | 4,669,721 | 1,626 (0.0%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-22 | 3,498,325 | 1,877 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-23 | 3,184,568 | 2,256 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-24 | 4,871,173 | 2,273 (0.0%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-25 | 3,252,533 | 1,685 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-26 | 4,087,541 | 2,394 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-27 | 4,128,597 | 2,099 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-28 | 4,845,119 | 2,583 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-29 | 4,776,758 | 3,481 (0.1%) | 39 (0.0%) | No (89.3x) | — | — |
| 2026-03-30 | 5,943,339 | 4,113 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-03-31 | 6,077,257 | 4,921 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-04-01 | 5,578,534 | 3,021 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-04-02 | 5,926,371 | 3,490 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-04-03 | 5,344,296 | 2,039 (0.0%) | 0 (0.0%) | No (—) | — | — |
| 2026-04-04 | 802,000 | 180 (0.0%) | 0 (0.0%) | No (—) | — | — |
| 2026-04-05 | 4,502,199 | 2,176 (0.0%) | 0 (0.0%) | No (—) | — | — |
| 2026-04-06 | 5,834,632 | 4,670 (0.1%) | 0 (0.0%) | No (—) | — | — |
| 2026-04-07 | 6,574,159 | 679,917 (10.3%) | 616,744 (9.4%) | Yes (1.1x) | — | — |
| 2026-04-08 | 9,165,731 | 3,625,414 (39.6%) | 1,928,569 (21.0%) | Yes (1.9x) | — | — |
| 2026-04-09 | 8,209,730 | 2,035,527 (24.8%) | 603,562 (7.4%) | Yes (3.4x) | — | — |
| 2026-04-10 | 5,783,408 | 2,834 (0.0%) | 0 (0.0%) | No (—) | 2,928,024 | 0 (0.0%) |
| 2026-04-11 | 5,063,882 | 2,386 (0.0%) | 0 (0.0%) | No (—) | 5,145,967 | 0 (0.0%) |
| 2026-04-12 | 6,277,089 | 1,014,960 (16.2%) | 152,603 (2.4%) | Yes (6.7x) | 5,286,481 | 0 (0.0%) |
| 2026-04-13 | 5,382,859 | 3,585 (0.1%) | 0 (0.0%) | No (—) | 6,315,122 | 0 (0.0%) |
| 2026-04-14 | 6,965,673 | 680,216 (9.8%) | 468,195 (6.7%) | Yes (1.5x) | 6,426,500 | 0 (0.0%) |
| 2026-04-15 | 5,137,686 | 2,920 (0.1%) | 0 (0.0%) | No (—) | 6,408,274 | 0 (0.0%) |
| 2026-04-16 | 7,122,972 | 4,610 (0.1%) | 0 (0.0%) | No (—) | 7,279,551 | 0 (0.0%) |
| 2026-04-17 | 6,918,974 | 5,434 (0.1%) | 0 (0.0%) | No (—) | 7,270,975 | 0 (0.0%) |
| 2026-04-18 | 6,493,256 | 893,568 (13.8%) | 18,746 (0.3%) | Yes (47.7x) | 5,839,228 | 0 (0.0%) |
| 2026-04-19 | 9,997,997 | 4,770,565 (47.7%) | 4,754,617 (47.6%) | No (1.0x) | 6,016,917 | 0 (0.0%) |
| 2026-04-20 | 9,175,719 | 3,631,126 (39.6%) | 3,626,887 (39.5%) | No (1.0x) | 6,673,420 | 0 (0.0%) |
| 2026-04-21 | 6,156,740 | 3,990 (0.1%) | 0 (0.0%) | No (—) | 6,575,628 | 0 (0.0%) |
| 2026-04-22 | 7,520,956 | 1,147,778 (15.3%) | 215,066 (2.9%) | Yes (5.3x) | 6,634,159 | 0 (0.0%) |
| 2026-04-23 | 7,723,018 | 1,558,924 (20.2%) | 475,324 (6.2%) | Yes (3.3x) | 6,711,695 | 0 (0.0%) |
| 2026-04-24 | 7,756,247 | 1,297,436 (16.7%) | 775,198 (10.0%) | Yes (1.7x) | 4,334,244 | 0 (0.0%) |
| 2026-04-25 | 479,191 | 48 (0.0%) | 0 (0.0%) | No (—) | 4,845,161 | 0 (0.0%) |
| 2026-04-26 | 2,067,052 | 844 (0.0%) | 0 (0.0%) | No (—) | 4,953,856 | 0 (0.0%) |
| 2026-04-27 | 5,658,986 | 4,443 (0.1%) | 0 (0.0%) | No (—) | 6,433,376 | 0 (0.0%) |
| 2026-04-28 | 6,283,558 | 4,420 (0.1%) | 0 (0.0%) | No (—) | 6,279,930 | 0 (0.0%) |
| 2026-04-29 | 6,699,157 | 5,572 (0.1%) | 0 (0.0%) | No (—) | 6,717,180 | 0 (0.0%) |
| 2026-04-30 | 6,509,908 | 278,694 (4.3%) | 586 (0.0%) | Yes (475.6x) | 6,447,486 | 0 (0.0%) |
| 2026-05-01 | 5,445,359 | 1,463 (0.0%) | 0 (0.0%) | No (—) | 6,080,132 | 0 (0.0%) |
| 2026-05-02 | 4,712,091 | 1,581 (0.0%) | 0 (0.0%) | No (—) | 4,716,655 | 0 (0.0%) |
| 2026-05-03 | 4,926,249 | 1,992 (0.0%) | 0 (0.0%) | No (—) | 4,963,841 | 0 (0.0%) |
| 2026-05-04 | 6,378,898 | 4,683 (0.1%) | 0 (0.0%) | No (—) | 6,886,715 | 0 (0.0%) |
| 2026-05-05 | 6,553,143 | 3,849 (0.1%) | 0 (0.0%) | No (—) | 6,748,664 | 0 (0.0%) |
| 2026-05-06 | 7,398,859 | 3,224 (0.0%) | 0 (0.0%) | No (—) | — | — |
| 2026-05-07 | 6,968,615 | 3,915 (0.1%) | 0 (0.0%) | No (—) | 7,472,352 | 0 (0.0%) |
| 2026-05-08 | 7,035,876 | 3,742 (0.1%) | 0 (0.0%) | No (—) | 7,224,990 | 0 (0.0%) |
| 2026-05-09 | 5,684,526 | 2,376 (0.0%) | 0 (0.0%) | No (—) | 5,693,977 | 0 (0.0%) |
| 2026-05-10 | 6,094,122 | 3,567 (0.1%) | 0 (0.0%) | No (—) | 6,147,356 | 0 (0.0%) |
| 2026-05-11 | 6,809,515 | 4,002 (0.1%) | 0 (0.0%) | No (—) | 7,247,711 | 0 (0.0%) |
| 2026-05-12 | 3,345,397 | 1,998 (0.1%) | 0 (0.0%) | No (—) | 7,206,031 | 0 (0.0%) |
| 2026-05-13 | 6,750,382 | 77,230 (1.1%) | 20,420 (0.3%) | Yes (3.8x) | 7,022,088 | 0 (0.0%) |
| 2026-05-14 | 13,347,104 | 6,819,495 (51.1%) | 3,647,504 (27.3%) | Yes (1.9x) | 7,156,685 | 0 (0.0%) |
| 2026-05-15 | 7,241,067 | 4,386 (0.1%) | 0 (0.0%) | No (—) | 7,262,010 | 1 (0.0%) |
| 2026-05-16 | 5,339,200 | 2,800 (0.1%) | 0 (0.0%) | No (—) | 5,342,111 | 0 (0.0%) |
| 2026-05-17 | 5,211,418 | 2,549 (0.0%) | 0 (0.0%) | No (—) | 5,215,428 | 0 (0.0%) |
| 2026-05-18 | 7,164,289 | 5,100 (0.1%) | 0 (0.0%) | No (—) | 7,217,616 | 0 (0.0%) |
| 2026-05-19 | 6,702,213 | 2,926 (0.0%) | 0 (0.0%) | No (—) | 6,717,011 | 0 (0.0%) |
| 2026-05-20 | 6,012,580 | 3,031 (0.1%) | 0 (0.0%) | No (—) | 6,674,661 | 0 (0.0%) |
| 2026-05-21 | 6,606,741 &dagger; | 4,074 (0.1%) | 0 (0.0%) | No (—) | 6,868,722 | 0 (0.0%) |
| 2026-05-22 | 6,878,361 | 4,803 (0.1%) | 0 (0.0%) | No (—) | 6,888,434 | 0 (0.0%) |
| 2026-05-23 | 5,426,811 | 5,718 (0.1%) | 0 (0.0%) | No (—) | 5,769,416 | 0 (0.0%) |
| 2026-05-24 | 5,267,340 | 3,447 (0.1%) | 0 (0.0%) | No (—) | 5,298,870 | 0 (0.0%) |
| 2026-05-25 | 5,225,053 | 2,723 (0.1%) | 0 (0.0%) | No (—) | 5,513,049 | 0 (0.0%) |
| 2026-05-26 | 5,039,238 | 2,777 (0.1%) | 0 (0.0%) | No (—) | 6,964,084 | 0 (0.0%) |
| 2026-05-27 | 6,809,770 | 3,663 (0.1%) | 0 (0.0%) | No (—) | 7,126,012 | 0 (0.0%) |
| 2026-05-28 | 7,109,152 | 4,191 (0.1%) | 0 (0.0%) | No (—) | 7,260,566 | 0 (0.0%) |
| 2026-05-29 | 6,727,578 | 4,325 (0.1%) | 0 (0.0%) | No (—) | 6,853,443 | 0 (0.0%) |
| 2026-05-30 | 5,218,878 &dagger; | 2,499 (0.0%) | 0 (0.0%) | No (—) | 5,284,424 | 0 (0.0%) |
| 2026-05-31 | 5,222,269 | 2,978 (0.1%) | 0 (0.0%) | No (—) | 5,280,911 | 0 (0.0%) |
| 2026-06-01 | 7,304,650 | 5,567 (0.1%) | 0 (0.0%) | No (—) | 7,329,915 | 0 (0.0%) |
| 2026-06-02 | 7,730,870 | 7,100 (0.1%) | 0 (0.0%) | No (—) | 7,903,009 | 0 (0.0%) |
| 2026-06-03 | 7,116,460 | 6,957 (0.1%) | 0 (0.0%) | No (—) | 8,050,627 | 0 (0.0%) |
| 2026-06-04 | 8,044,167 | 7,195 (0.1%) | 0 (0.0%) | No (—) | 8,565,044 | 0 (0.0%) |
| 2026-06-05 | 5,571,304 | 6,933 (0.1%) | 0 (0.0%) | No (—) | 8,746,583 | 0 (0.0%) |
| 2026-06-06 | 3,663,415 | 2,684 (0.1%) | 0 (0.0%) | No (—) | 6,949,390 | 0 (0.0%) |
| 2026-06-07 | 6,473,455 | 6,012 (0.1%) | 0 (0.0%) | No (—) | 6,561,108 | 0 (0.0%) |
| 2026-06-08 | 7,528,846 | 5,388 (0.1%) | 0 (0.0%) | No (—) | 7,476,314 | 0 (0.0%) |
| 2026-06-09 | 7,468,712 | 5,703 (0.1%) | 0 (0.0%) | No (—) | 7,475,833 | 0 (0.0%) |
| 2026-06-10 | 7,824,530 | 6,375 (0.1%) | 0 (0.0%) | No (—) | 7,825,373 | 0 (0.0%) |
| 2026-06-11 | 7,177,574 &dagger; | 6,232 (0.1%) | 0 (0.0%) | No (—) | 7,481,266 | 0 (0.0%) |
| 2026-06-12 | 6,934,313 &dagger; | 4,518 (0.1%) | 0 (0.0%) | No (—) | 7,226,189 | 0 (0.0%) |
| 2026-06-13 | 5,571,564 | 2,798 (0.1%) | 0 (0.0%) | No (—) | 5,571,648 | 0 (0.0%) |
| 2026-06-14 | 4,490,365 | 2,589 (0.1%) | 0 (0.0%) | No (—) | 5,402,362 | 0 (0.0%) |
| 2026-06-15 | 7,150,677 | 5,078 (0.1%) | 0 (0.0%) | No (—) | 7,254,123 | 0 (0.0%) |
| 2026-06-16 | 6,310,519 | 4,207 (0.1%) | 0 (0.0%) | No (—) | 6,941,233 | 0 (0.0%) |
| 2026-06-17 | 6,189,535 | 5,214 (0.1%) | 0 (0.0%) | No (—) | 7,012,436 | 0 (0.0%) |
| 2026-06-18 | 5,368,182 | 5,520 (0.1%) | 0 (0.0%) | No (—) | 6,730,484 | 0 (0.0%) |
| 2026-06-19 | 5,143,719 | 3,890 (0.1%) | 0 (0.0%) | No (—) | 5,675,926 | 0 (0.0%) |
| 2026-06-20 | 4,284,312 | 3,234 (0.1%) | 0 (0.0%) | No (—) | 4,926,786 | 0 (0.0%) |

## instrument — second pass (timestamp-rebucketed)

This re-runs dedup on the **timestamp-rebucketed** sources, on top of the first pass (which already applied the recommendations above: antel→T500, local→T0/T500 per day). So it is a *second* pass — drops are expected to be small, exposing only what rebucketing newly reveals.

**Why rebucket (the motivation):** `data dedup` and `data prepare` both operate **per bucket** and can't see across files. A ghost-subscription duplicate that straddled midnight landed in the previous-day bucket via one stream and the next-day bucket via the other, so the dup and its original sat in **different `_date_` buckets** — invisible to both commands, immune to all cleanup. Re-bucketing every message by its canonical **event `timestamp`** (the same field dedup keys on) guarantees a dup and its original co-locate in one bucket, finally catchable. Journalist does this for new data going forward; the one-time `data rebucket` retrofits history (see `project_timestamp_bucketing`).

**Expected / seen consequences:**

- **antel.T500 → ~0** (seen: 0 on every day 04-10…06-23 **except 06-23**, which dropped **229 = 0.0035%**, and pass-1's 05-15 = 1). The clean remote essentially never has catchable dupes — rare single events excepted. The 06-23 case is **resolved**: a 120ms referential-symbol reconnect burst at 07:58 (see note below), benign.
- **antel.T0 → the legit same-ms oscillation baseline.** On the clean source, T0's only drops are genuine A→B→A-in-one-ms repeats. Seen: **mean 0.067%/day** (range 0.027–0.121%) over all **74 T0 days (complete, 04-10…06-23)** — empirically confirming the ~0.06% floor pass-1 had only estimated. (Instrument genuinely oscillates; orderBookL2 does not — its antel.T0 is 0.)
- **local T0 / T500 → only the cross-bucket dupes** pass-1 missed (small), plus the same oscillation cost on the T0 side. **NB — chaining:** in this pass `local T0` is run on the **local T500 output** (not independently on the raw source), so the `localT0` column already shows the drops **on top of T500** (= `T0effect` directly). Don't subtract `localT500` from it. (Chaining can differ slightly from the independent diff because the monotonic clock/window state differs over already-T500-deduped data — usually negligible, occasionally not.)

**Decision method (this pass):** use **antel.T0 % as the per-day legit-oscillation baseline** (mean 0.067%, max 0.121%). Because local T0 is chained on local T500, `localT0 / orig` **is** the T0effect (no subtraction). `useLocalT0` shows `Yes/No (localT0%)`; threshold **0.2%** (sits in the natural gap, above the max oscillation baseline): localT0% ≈ baseline ⇒ just oscillations ⇒ **T500**; localT0% > 0.2% ⇒ real cross-bucket dupes ⇒ **T0**.

**Result (complete):** only **04-19 = Yes (0.30%)** — the single day where rebucketing exposed enough co-temporal cross-midnight dupes that T0 adds value over T500. Every other day is ≈ baseline (≤0.15%) ⇒ **No**. This is expected: pass-1's per-day T0 already wiped the hard ghost-sub days, so pass-2 only surfaces the **rebucketing ripples** — of which 04-19 is the lone meaningful one. So for instrument pass-2: **T500 everywhere except 04-19**.

**06-23 antel anomaly (resolved):** the 229 T500 drops are **one ~120ms burst at 07:58:23.473–593Z, all 229 referential `.`-symbols** (`.BUNIT`, `.BHYPET`, …), all carrying 06-23 timestamps. Diagnosis via plain ordered `diff` of raw vs rebucketed+deduped (nothing in the pipeline sorts, so deduped = raw minus dropped, in order): the diff is just 357 lines = these 229 + 128 unrelated boundary moves (06-22-timestamp events received after midnight, correctly rebucketed to 06-22 — not drops). So it's a brief **reconnect/replay at 07:58** that re-emitted the referential-symbol set; rebucketing co-located the copies, and the clock had advanced >500ms past them, so T500 dropped them as out-of-order repeats. Benign — a 0.0035% referential blip, exactly what dedup is for. Not the redeploy (~11:00), not a boundary cutover.

**Notes:** 06-22/06-23 are *new* collection days (not in pass 1), so for them this is effectively a first pass — same rebucket→dedup process. † `prepared` source — on one day the raw antel+local sources were lost, leaving only an early `data prepare` (sort/merge/dedup) output; it's treated as a **local** source (expected to carry local's issues, perhaps attenuated), and **antel is absent** that day. **Coverage: complete** — antel.T0 + antel.T500 04-10…06-23 (74 days), local.T0 + local.T500 03-08…06-23 (107 local days + the 05-06 prepared day). antel is `—` before 04-10 (its start) and on 05-06 (sources lost; prepared stands in). All `useLocalT0` decisions are in.

| date | local | localT0 | localT500 | useLocalT0 | antel | antel.T0 | antel.T500 |
|------|------:|--------:|----------:|:----------:|------:|--------:|-----------:|
| 2026-03-08 | 4,238,306 | 1,259 (0.0%) | 0 (0.0%) | No (0.03%) | — | — | — |
| 2026-03-09 | 6,355,653 | 4,510 (0.1%) | 0 (0.0%) | No (0.07%) | — | — | — |
| 2026-03-10 | 6,395,814 | 3,906 (0.1%) | 0 (0.0%) | No (0.06%) | — | — | — |
| 2026-03-11 | 4,704,035 | 2,693 (0.1%) | 0 (0.0%) | No (0.06%) | — | — | — |
| 2026-03-12 | 6,267,613 | 4,364 (0.1%) | 0 (0.0%) | No (0.07%) | — | — | — |
| 2026-03-13 | 6,685,094 | 6,870 (0.1%) | 0 (0.0%) | No (0.10%) | — | — | — |
| 2026-03-14 | 5,156,201 | 2,770 (0.1%) | 0 (0.0%) | No (0.05%) | — | — | — |
| 2026-03-15 | 5,353,563 | 3,898 (0.1%) | 0 (0.0%) | No (0.07%) | — | — | — |
| 2026-03-16 | 6,746,521 | 6,542 (0.1%) | 0 (0.0%) | No (0.10%) | — | — | — |
| 2026-03-17 | 6,315,383 | 5,955 (0.1%) | 0 (0.0%) | No (0.09%) | — | — | — |
| 2026-03-18 | 6,017,588 | 4,360 (0.1%) | 0 (0.0%) | No (0.07%) | — | — | — |
| 2026-03-19 | 6,262,970 | 4,295 (0.1%) | 0 (0.0%) | No (0.07%) | — | — | — |
| 2026-03-20 | 6,340,852 | 3,629 (0.1%) | 0 (0.0%) | No (0.06%) | — | — | — |
| 2026-03-21 | 4,721,687 | 1,783 (0.0%) | 0 (0.0%) | No (0.04%) | — | — | — |
| 2026-03-22 | 3,451,121 | 1,721 (0.0%) | 0 (0.0%) | No (0.05%) | — | — | — |
| 2026-03-23 | 3,179,806 | 2,255 (0.1%) | 0 (0.0%) | No (0.07%) | — | — | — |
| 2026-03-24 | 4,878,917 | 2,277 (0.0%) | 0 (0.0%) | No (0.05%) | — | — | — |
| 2026-03-25 | 3,326,693 | 1,702 (0.1%) | 0 (0.0%) | No (0.05%) | — | — | — |
| 2026-03-26 | 4,054,249 | 2,391 (0.1%) | 0 (0.0%) | No (0.06%) | — | — | — |
| 2026-03-27 | 4,079,981 | 2,081 (0.1%) | 0 (0.0%) | No (0.05%) | — | — | — |
| 2026-03-28 | 4,845,119 | 2,583 (0.1%) | 0 (0.0%) | No (0.05%) | — | — | — |
| 2026-03-29 | 4,776,719 | 3,442 (0.1%) | 0 (0.0%) | No (0.07%) | — | — | — |
| 2026-03-30 | 5,948,621 | 4,115 (0.1%) | 0 (0.0%) | No (0.07%) | — | — | — |
| 2026-03-31 | 6,072,508 | 4,920 (0.1%) | 0 (0.0%) | No (0.08%) | — | — | — |
| 2026-04-01 | 5,611,847 | 3,032 (0.1%) | 0 (0.0%) | No (0.05%) | — | — | — |
| 2026-04-02 | 5,892,530 | 3,478 (0.1%) | 0 (0.0%) | No (0.06%) | — | — | — |
| 2026-04-03 | 5,344,297 | 2,039 (0.0%) | 0 (0.0%) | No (0.04%) | — | — | — |
| 2026-04-04 | 801,999 | 180 (0.0%) | 0 (0.0%) | No (0.02%) | — | — | — |
| 2026-04-05 | 4,675,957 | 2,362 (0.1%) | 0 (0.0%) | No (0.05%) | — | — | — |
| 2026-04-06 | 5,660,875 | 4,484 (0.1%) | 0 (0.0%) | No (0.08%) | — | — | — |
| 2026-04-07 | 5,894,960 | 2 (0.0%) | 716 (0.0%) | No (0.00%) | — | — | — |
| 2026-04-08 | 5,539,598 | 0 (0.0%) | 0 (0.0%) | No (0.00%) | — | — | — |
| 2026-04-09 | 6,186,166 | 5 (0.0%) | 0 (0.0%) | No (0.00%) | — | — | — |
| 2026-04-10 | 5,771,445 | 2,829 (0.0%) | 0 (0.0%) | No (0.05%) | 2,928,148 | 1,549 (0.1%) | 0 (0.0%) |
| 2026-04-11 | 5,114,494 | 2,386 (0.0%) | 0 (0.0%) | No (0.05%) | 5,145,967 | 2,397 (0.0%) | 0 (0.0%) |
| 2026-04-12 | 5,211,517 | 0 (0.0%) | 0 (0.0%) | No (0.00%) | 5,286,481 | 2,343 (0.0%) | 0 (0.0%) |
| 2026-04-13 | 5,383,301 | 3,585 (0.1%) | 0 (0.0%) | No (0.07%) | 6,315,122 | 4,238 (0.1%) | 0 (0.0%) |
| 2026-04-14 | 6,285,016 | 0 (0.0%) | 0 (0.0%) | No (0.00%) | 6,426,501 | 4,411 (0.1%) | 0 (0.0%) |
| 2026-04-15 | 5,137,686 | 2,920 (0.1%) | 0 (0.0%) | No (0.06%) | 6,408,274 | 3,499 (0.1%) | 0 (0.0%) |
| 2026-04-16 | 7,240,105 | 4,659 (0.1%) | 0 (0.0%) | No (0.06%) | 7,279,553 | 4,721 (0.1%) | 0 (0.0%) |
| 2026-04-17 | 6,878,289 | 5,385 (0.1%) | 0 (0.0%) | No (0.08%) | 7,270,975 | 5,776 (0.1%) | 0 (0.0%) |
| 2026-04-18 | 5,523,242 | 0 (0.0%) | 0 (0.0%) | No (0.00%) | 5,839,228 | 3,273 (0.1%) | 0 (0.0%) |
| 2026-04-19 | 5,331,745 | 15,951 (0.3%) | 33,742 (0.6%) | Yes (0.30%) | 6,016,919 | 4,001 (0.1%) | 0 (0.0%) |
| 2026-04-20 | 5,460,467 | 4,227 (0.1%) | 0 (0.0%) | No (0.08%) | 6,673,418 | 5,083 (0.1%) | 0 (0.0%) |
| 2026-04-21 | 6,156,757 | 3,990 (0.1%) | 0 (0.0%) | No (0.06%) | 6,575,628 | 4,588 (0.1%) | 0 (0.0%) |
| 2026-04-22 | 6,373,215 | 53 (0.0%) | 0 (0.0%) | No (0.00%) | 6,634,160 | 5,011 (0.1%) | 0 (0.0%) |
| 2026-04-23 | 6,164,041 | 0 (0.0%) | 0 (0.0%) | No (0.00%) | 6,711,717 | 4,930 (0.1%) | 0 (0.0%) |
| 2026-04-24 | 6,458,851 | 41 (0.0%) | 0 (0.0%) | No (0.00%) | 4,334,221 | 2,888 (0.1%) | 0 (0.0%) |
| 2026-04-25 | 479,163 | 48 (0.0%) | 0 (0.0%) | No (0.01%) | 4,845,161 | 1,364 (0.0%) | 0 (0.0%) |
| 2026-04-26 | 2,067,087 | 845 (0.0%) | 0 (0.0%) | No (0.04%) | 4,953,860 | 2,562 (0.1%) | 0 (0.0%) |
| 2026-04-27 | 5,658,989 | 4,442 (0.1%) | 0 (0.0%) | No (0.08%) | 6,433,423 | 4,882 (0.1%) | 0 (0.0%) |
| 2026-04-28 | 6,283,509 | 4,420 (0.1%) | 0 (0.0%) | No (0.07%) | 6,283,124 | 4,556 (0.1%) | 0 (0.0%) |
| 2026-04-29 | 6,699,157 | 5,572 (0.1%) | 0 (0.0%) | No (0.08%) | 6,713,937 | 5,288 (0.1%) | 0 (0.0%) |
| 2026-04-30 | 6,231,216 | 0 (0.0%) | 0 (0.0%) | No (0.00%) | 6,447,488 | 2,924 (0.0%) | 0 (0.0%) |
| 2026-05-01 | 5,445,357 | 1,463 (0.0%) | 0 (0.0%) | No (0.03%) | 6,080,130 | 1,634 (0.0%) | 0 (0.0%) |
| 2026-05-02 | 4,712,091 | 1,581 (0.0%) | 0 (0.0%) | No (0.03%) | 4,716,655 | 1,582 (0.0%) | 0 (0.0%) |
| 2026-05-03 | 4,926,249 | 1,992 (0.0%) | 0 (0.0%) | No (0.04%) | 4,963,841 | 2,080 (0.0%) | 0 (0.0%) |
| 2026-05-04 | 6,378,898 | 4,683 (0.1%) | 0 (0.0%) | No (0.07%) | 6,886,715 | 4,822 (0.1%) | 0 (0.0%) |
| 2026-05-05 | 6,553,143 | 3,849 (0.1%) | 0 (0.0%) | No (0.06%) | 6,748,535 | 4,155 (0.1%) | 0 (0.0%) |
| 2026-05-06 | 7,398,988 † | 3,353 (0.0%) | 0 (0.0%) | No (0.05%) | — | — | — |
| 2026-05-07 | 6,968,615 | 3,915 (0.1%) | 0 (0.0%) | No (0.06%) | 7,472,352 | 4,313 (0.1%) | 0 (0.0%) |
| 2026-05-08 | 7,035,876 | 3,743 (0.1%) | 0 (0.0%) | No (0.05%) | 7,224,990 | 4,275 (0.1%) | 0 (0.0%) |
| 2026-05-09 | 5,684,568 | 2,376 (0.0%) | 0 (0.0%) | No (0.04%) | 5,693,979 | 2,213 (0.0%) | 0 (0.0%) |
| 2026-05-10 | 6,094,172 | 3,567 (0.1%) | 0 (0.0%) | No (0.06%) | 6,147,355 | 3,733 (0.1%) | 0 (0.0%) |
| 2026-05-11 | 6,809,294 | 4,002 (0.1%) | 0 (0.0%) | No (0.06%) | 7,247,710 | 3,888 (0.1%) | 0 (0.0%) |
| 2026-05-12 | 3,345,526 | 1,998 (0.1%) | 0 (0.0%) | No (0.06%) | 7,206,031 | 4,345 (0.1%) | 0 (0.0%) |
| 2026-05-13 | 6,680,269 | 0 (0.0%) | 0 (0.0%) | No (0.00%) | 7,022,088 | 4,379 (0.1%) | 0 (0.0%) |
| 2026-05-14 | 6,520,492 | 0 (0.0%) | 0 (0.0%) | No (0.00%) | 7,156,556 | 4,968 (0.1%) | 0 (0.0%) |
| 2026-05-15 | 7,241,067 | 4,386 (0.1%) | 0 (0.0%) | No (0.06%) | 7,262,138 | 4,318 (0.1%) | 0 (0.0%) |
| 2026-05-16 | 5,339,200 | 2,800 (0.1%) | 0 (0.0%) | No (0.05%) | 5,342,111 | 2,527 (0.0%) | 0 (0.0%) |
| 2026-05-17 | 5,211,418 | 2,549 (0.0%) | 0 (0.0%) | No (0.05%) | 5,215,428 | 2,253 (0.0%) | 0 (0.0%) |
| 2026-05-18 | 7,164,288 | 5,100 (0.1%) | 0 (0.0%) | No (0.07%) | 7,217,615 | 4,867 (0.1%) | 0 (0.0%) |
| 2026-05-19 | 6,702,213 | 2,926 (0.0%) | 0 (0.0%) | No (0.04%) | 6,717,011 | 2,968 (0.0%) | 0 (0.0%) |
| 2026-05-20 | 6,012,580 | 3,031 (0.1%) | 0 (0.0%) | No (0.05%) | 6,674,661 | 3,150 (0.0%) | 0 (0.0%) |
| 2026-05-21 | 6,606,741 | 4,074 (0.1%) | 0 (0.0%) | No (0.06%) | 6,868,722 | 4,013 (0.1%) | 0 (0.0%) |
| 2026-05-22 | 6,878,362 | 4,803 (0.1%) | 0 (0.0%) | No (0.07%) | 6,888,435 | 4,890 (0.1%) | 0 (0.0%) |
| 2026-05-23 | 5,426,810 | 5,718 (0.1%) | 0 (0.0%) | No (0.11%) | 5,769,415 | 5,474 (0.1%) | 0 (0.0%) |
| 2026-05-24 | 5,267,340 | 3,447 (0.1%) | 0 (0.0%) | No (0.07%) | 5,298,870 | 3,081 (0.1%) | 0 (0.0%) |
| 2026-05-25 | 5,241,911 | 2,734 (0.1%) | 0 (0.0%) | No (0.05%) | 5,513,049 | 2,626 (0.0%) | 0 (0.0%) |
| 2026-05-26 | 5,022,383 | 2,766 (0.1%) | 0 (0.0%) | No (0.06%) | 6,964,085 | 4,329 (0.1%) | 0 (0.0%) |
| 2026-05-27 | 6,809,768 | 3,663 (0.1%) | 0 (0.0%) | No (0.05%) | 7,126,012 | 3,862 (0.1%) | 0 (0.0%) |
| 2026-05-28 | 7,109,144 | 4,191 (0.1%) | 0 (0.0%) | No (0.06%) | 7,260,558 | 4,416 (0.1%) | 0 (0.0%) |
| 2026-05-29 | 6,727,577 | 4,325 (0.1%) | 0 (0.0%) | No (0.06%) | 6,853,442 | 4,630 (0.1%) | 0 (0.0%) |
| 2026-05-30 | 5,218,893 | 2,499 (0.0%) | 0 (0.0%) | No (0.05%) | 5,284,425 | 2,607 (0.0%) | 0 (0.0%) |
| 2026-05-31 | 5,222,254 | 2,978 (0.1%) | 0 (0.0%) | No (0.06%) | 5,280,910 | 3,009 (0.1%) | 0 (0.0%) |
| 2026-06-01 | 7,304,650 | 5,567 (0.1%) | 0 (0.0%) | No (0.08%) | 7,329,915 | 5,435 (0.1%) | 0 (0.0%) |
| 2026-06-02 | 7,730,941 | 7,100 (0.1%) | 0 (0.0%) | No (0.09%) | 7,903,057 | 7,629 (0.1%) | 0 (0.0%) |
| 2026-06-03 | 7,155,166 | 6,985 (0.1%) | 0 (0.0%) | No (0.10%) | 8,050,656 | 7,555 (0.1%) | 0 (0.0%) |
| 2026-06-04 | 8,073,437 | 7,225 (0.1%) | 0 (0.0%) | No (0.09%) | 8,565,033 | 7,527 (0.1%) | 0 (0.0%) |
| 2026-06-05 | 5,503,137 | 6,875 (0.1%) | 0 (0.0%) | No (0.12%) | 8,746,585 | 10,609 (0.1%) | 0 (0.0%) |
| 2026-06-06 | 3,663,579 | 2,684 (0.1%) | 0 (0.0%) | No (0.07%) | 6,949,366 | 6,200 (0.1%) | 0 (0.0%) |
| 2026-06-07 | 6,473,474 | 6,012 (0.1%) | 0 (0.0%) | No (0.09%) | 6,561,127 | 5,982 (0.1%) | 0 (0.0%) |
| 2026-06-08 | 7,528,849 | 5,388 (0.1%) | 0 (0.0%) | No (0.07%) | 7,476,317 | 5,354 (0.1%) | 0 (0.0%) |
| 2026-06-09 | 7,468,653 | 5,703 (0.1%) | 0 (0.0%) | No (0.08%) | 7,475,774 | 5,488 (0.1%) | 0 (0.0%) |
| 2026-06-10 | 7,824,534 | 6,375 (0.1%) | 0 (0.0%) | No (0.08%) | 7,825,377 | 6,534 (0.1%) | 0 (0.0%) |
| 2026-06-11 | 7,177,573 | 6,232 (0.1%) | 0 (0.0%) | No (0.09%) | 7,481,265 | 6,583 (0.1%) | 0 (0.0%) |
| 2026-06-12 | 6,934,313 | 4,518 (0.1%) | 0 (0.0%) | No (0.07%) | 7,226,189 | 5,024 (0.1%) | 0 (0.0%) |
| 2026-06-13 | 5,571,564 | 2,798 (0.1%) | 0 (0.0%) | No (0.05%) | 5,571,648 | 3,367 (0.1%) | 0 (0.0%) |
| 2026-06-14 | 4,490,365 | 2,589 (0.1%) | 0 (0.0%) | No (0.06%) | 5,402,362 | 2,899 (0.1%) | 0 (0.0%) |
| 2026-06-15 | 7,185,208 | 5,087 (0.1%) | 0 (0.0%) | No (0.07%) | 7,254,121 | 5,110 (0.1%) | 0 (0.0%) |
| 2026-06-16 | 6,275,987 | 4,198 (0.1%) | 0 (0.0%) | No (0.07%) | 6,941,234 | 4,679 (0.1%) | 0 (0.0%) |
| 2026-06-17 | 6,189,534 | 5,214 (0.1%) | 0 (0.0%) | No (0.08%) | 7,012,435 | 6,826 (0.1%) | 0 (0.0%) |
| 2026-06-18 | 5,430,563 | 5,550 (0.1%) | 0 (0.0%) | No (0.10%) | 6,730,484 | 7,587 (0.1%) | 0 (0.0%) |
| 2026-06-19 | 5,084,598 | 3,863 (0.1%) | 0 (0.0%) | No (0.08%) | 5,675,927 | 4,277 (0.1%) | 0 (0.0%) |
| 2026-06-20 | 4,301,116 | 3,234 (0.1%) | 0 (0.0%) | No (0.08%) | 4,926,785 | 4,374 (0.1%) | 0 (0.0%) |
| 2026-06-21 | 3,654,186 | 2,026 (0.1%) | 0 (0.0%) | No (0.06%) | 4,772,258 | 2,810 (0.1%) | 0 (0.0%) |
| 2026-06-22 | 4,147,939 | 4,004 (0.1%) | 0 (0.0%) | No (0.10%) | 6,275,615 | 6,841 (0.1%) | 0 (0.0%) |
| 2026-06-23 | 4,938,115 | 4,191 (0.1%) | 0 (0.0%) | No (0.08%) | 6,531,500 | 6,625 (0.1%) | 229 (0.0%) |

## orderBookL2

Unlike instrument, orderBookL2 has **effectively no oscillation FP** — most days dedup to exactly 0 (BitMEX's ~50ms conflation collapses any same-ms A→B→A before it's sent, so legit oscillations never reach the file). So there is **no noise floor to clear**: every excess T0 drop is a real duplicate, not a false positive.

**No per-day decision for orderBookL2 — it's T0 for every source, always.** Running T0 vs T500 on the *healthy antel source* settled it: antel.T0 = **0 on every day** (no same-ms content repeats at all), so T0 has no false-positive cost here — unlike instrument's ~0.06% oscillation floor, every T0 drop is a real duplicate. There is therefore nothing to decide per day. Practical payoff: the rebucketed run is **T0 only** (current: `-T0`, window 5M) on all sources — no need to also run T500 and compare per day (half the work).

**DECISION (confirmed): use T0 for all orderBookL2.** The clean-source test settles it: running **T0 on antel** (ghost-free dedicated remote) drops **exactly 0 on every day tested** — 61/61 so far (04-10…06-09; the first pass is still completing across the rest). A same-ms oscillation A→B→A is an identical-content repeat, so T0 *would* drop it; zero drops on clean data means **orderBookL2 has no same-ms oscillations at all** (the ~50ms conflation collapses them before emission). Therefore T0 costs nothing real on clean data, and on dirty local every T0-vs-T500 delta is collector/ghost re-delivery (see 03-22 below). T0 is free, removes the block-replays, and de-ghosts unconditionally.

**03-22 investigation (one data point, confirmed):** the 896 T0-only dropped messages (2,484 rows) are **not** oscillations and **not** ghost-subscription. They collapse into 3–4 tight bursts (11:42–43, 23:54, 00:37, 20:08) of stale events received 89–417s (mean ~165s) after their own `timestamp`, re-delivered with the original `timestamp`/`transactTime` — i.e. **collector-side block re-delivery** (early-collection instability, pre-stabilization ~first half of April), the co-temporal block-replay pattern.

Verified on the 11:42–43 burst (450 dup messages, each recurring exactly twice): 178 are multi-row (normal in orderBookL2 — a single insert/update/delete frame carries many levels; for such a message to be an oscillation, *every* `id` in it would have to flip back to identical values at the same `timestamp` simultaneously — implausible), and the 272 single-row candidates **all** passed the oscillation test — **0** had any intervening different value for the same `id` between the two occurrences. So **450/450 are pure duplicates, 0 oscillations**. On 03-22, every T0 drop is a real duplicate; nothing legit is lost.

The two sides of the proof line up: **antel.T0 = 0** (no oscillations on clean data) and the **03-22 local deep-dive** (every T0 drop on dirty data is a re-delivered duplicate, 0 oscillations among 450 dups). Duplication magnitude is tiny regardless, so this was always a cleanliness call, not a data-integrity one — but it's now decided on evidence, not assumption.

**Upside:** T0 for all also makes de-ghosting unconditional — T0 catches the co-temporal dups no positive threshold can reach, so a blanket T0 removes both collector block-replays and any ghost-sub bursts in one move, with no per-day Yes/No bookkeeping. That's why the throttling hypothesis (zero oscillation cost) being true would make T0 a pure win.

**04-07/04-08 — ghost-sub appears in orderBookL2 too:** 04-08: localT0 drops 24.5% vs localT500 17.3% — a large co-temporal ghost payload only T0 reaches (same event as instrument's 04-08). 04-07: T500 caught most (5.7% both) but T0 still removes ~26k extra real dupes. These are dupes, not oscillations — concrete proof of T0's de-ghosting value, all swept up by the T0-for-all choice.

**Table columns — `.old` vs new.** The **`.old`** columns (`local.old`, `localT0.old`, `localT500.old`, `antel.old`) are the **previous first-pass dedup on the original `_date_`-bucketed sources** (pre-rebucketing), kept here only for side-by-side comparison and **to be removed once the new run reaches 05-04** — the end of the old `.local` coverage; beyond it there's no `.old` to compare against. (The old `antel.T0`/`antel.T500` were all zero — no info — so they're dropped.) The unsuffixed columns (`local`, `localT0`, `antel`, `antelT0`) are the **current run: `data dedup -T0`, window 5M, on the rebucketed sources.** It's **T0 only** (decision settled above — no T0-vs-T500/per-day choice).

**Plan (updated — the earlier two-pass plan was dropped):** the rebucketing + dedup was done **directly on the original sources**, *not* as a second pass on top of a prior dedup. So the new columns are the single authoritative dedup of the rebucketed originals. **In progress** (alphabetical, both sources at once): local through 04-15, antel through 04-16; rest `?`. Sources from **2026-06-24 onward are born timestamp-bucketed** (journalist fix) — out of scope, coverage caps at 06-23.

**What the side-by-side shows so far:** healthy days are unchanged by rebucketing (new `localT0` == `localT0.old`); rebucketing only shifts the orig counts slightly (messages crossing day boundaries) and exposes a little more on the ghost days (04-07 5.7%→6.3%, 04-08 24.5%→24.7%) as cross-midnight dupes co-locate. New **`antelT0` stays 0** on every rebucketed day — reconfirming no oscillations even after rebucketing (the older pre-rebucket antel.T0 run had already shown 0 across 61 days).

**04-09 / 04-10 — extra mongo source (confounded, don't read as rebucketing):** these two days also had a small `.mongo` source alongside `.local` (the only days that did), and the new `local` is the **prepared merge of old local + mongo**. So `local.old` here is the **local + mongo sum** (04-09 77.7M, 04-10 86.1M). Their old↔new drop is large (04-10 86M → 52M) but **not** simple rebucketing redistribution — the missing ~34M does *not* appear in the neighbouring days. It's confounded by the prepared merge (which itself sorts/dedups the cross-source local+mongo overlap) and the early-April replay window, so it's not cleanly attributable. Treat these two days as not-comparable. (04-11 is just a genuinely small `.local` day, no mongo.)

**Rebucketing is otherwise count-conserving (measured over the 03-08…04-15 overlap):** per-day orig shifts are tiny (tens–hundreds of msgs) except adjacent **canceling pairs** where a boundary block moves to the neighbour (e.g. 04-05 +1,864,949 / 04-06 −1,864,634, net +315). Excluding the two mongo days, the 38 remaining days net **+0.05%**. And **dedup drops are identical old↔new on nearly every day**, larger only on the live cross-midnight ghost days (04-07 +386k, 04-08 +220k) — exactly the dupes rebucketing was meant to expose.

Corruption: 6 orderBookL2 days were corrupt (04-27, 05-21, 05-30, 05-31, 06-11, 06-12) — all sanitized and validated clean; handled inline by `tools data recover` (message-level sanitize).

| date | local.old | localT0.old | localT500.old | antel.old | local | localT0 | antel | antelT0 |
|------|------:|--------:|----------:|------:|------:|--------:|------:|--------:|
| 2026-03-08 | 36,155,432 | 0 (0.0%) | 0 (0.0%) | — | 36,155,512 | 0 (0.0%) | — | — |
| 2026-03-09 | 60,097,299 | 7,762 (0.0%) | 0 (0.0%) | — | 60,097,303 | 7,762 (0.0%) | — | — |
| 2026-03-10 | 53,819,575 | 0 (0.0%) | 0 (0.0%) | — | 53,819,548 | 0 (0.0%) | — | — |
| 2026-03-11 | 35,439,068 | 0 (0.0%) | 0 (0.0%) | — | 35,439,165 | 0 (0.0%) | — | — |
| 2026-03-12 | 50,965,679 | 0 (0.0%) | 0 (0.0%) | — | 50,965,628 | 0 (0.0%) | — | — |
| 2026-03-13 | 57,465,535 | 2,436 (0.0%) | 1,908 (0.0%) | — | 57,465,617 | 2,436 (0.0%) | — | — |
| 2026-03-14 | 36,871,112 | 0 (0.0%) | 0 (0.0%) | — | 36,871,005 | 0 (0.0%) | — | — |
| 2026-03-15 | 42,885,719 | 14 (0.0%) | 0 (0.0%) | — | 42,885,706 | 14 (0.0%) | — | — |
| 2026-03-16 | 61,519,778 | 0 (0.0%) | 0 (0.0%) | — | 61,519,798 | 0 (0.0%) | — | — |
| 2026-03-17 | 56,360,247 | 0 (0.0%) | 0 (0.0%) | — | 56,360,248 | 0 (0.0%) | — | — |
| 2026-03-18 | 54,249,342 | 13,945 (0.0%) | 12,805 (0.0%) | — | 54,249,366 | 13,945 (0.0%) | — | — |
| 2026-03-19 | 59,028,196 | 296 (0.0%) | 0 (0.0%) | — | 59,028,159 | 296 (0.0%) | — | — |
| 2026-03-20 | 56,658,340 | 0 (0.0%) | 0 (0.0%) | — | 56,658,331 | 0 (0.0%) | — | — |
| 2026-03-21 | 35,629,849 | 0 (0.0%) | 0 (0.0%) | — | 36,158,397 | 0 (0.0%) | — | — |
| 2026-03-22 | 31,158,335 | 896 (0.0%) | 0 (0.0%) | — | 30,670,104 | 896 (0.0%) | — | — |
| 2026-03-23 | 30,128,512 | 0 (0.0%) | 0 (0.0%) | — | 30,088,197 | 0 (0.0%) | — | — |
| 2026-03-24 | 41,768,762 | 0 (0.0%) | 0 (0.0%) | — | 41,843,310 | 0 (0.0%) | — | — |
| 2026-03-25 | 28,944,624 | 0 (0.0%) | 0 (0.0%) | — | 29,560,517 | 0 (0.0%) | — | — |
| 2026-03-26 | 35,993,061 | 0 (0.0%) | 0 (0.0%) | — | 35,746,097 | 0 (0.0%) | — | — |
| 2026-03-27 | 38,008,667 | 0 (0.0%) | 0 (0.0%) | — | 37,565,190 | 0 (0.0%) | — | — |
| 2026-03-28 | 45,147,611 | 134 (0.0%) | 0 (0.0%) | — | 45,147,623 | 134 (0.0%) | — | — |
| 2026-03-29 | 45,626,944 | 25,516 (0.1%) | 21,291 (0.0%) | — | 45,627,192 | 25,516 (0.1%) | — | — |
| 2026-03-30 | 60,640,773 | 0 (0.0%) | 0 (0.0%) | — | 60,691,074 | 0 (0.0%) | — | — |
| 2026-03-31 | 57,766,066 | 0 (0.0%) | 0 (0.0%) | — | 57,722,407 | 0 (0.0%) | — | — |
| 2026-04-01 | 50,685,206 | 821 (0.0%) | 0 (0.0%) | — | 50,987,811 | 821 (0.0%) | — | — |
| 2026-04-02 | 56,530,512 | 6,070 (0.0%) | 5,729 (0.0%) | — | 56,221,083 | 6,070 (0.0%) | — | — |
| 2026-04-03 | 46,617,557 | 0 (0.0%) | 0 (0.0%) | — | 46,617,496 | 0 (0.0%) | — | — |
| 2026-04-04 | 37,119,867 | 0 (0.0%) | 0 (0.0%) | — | 37,119,833 | 0 (0.0%) | — | — |
| 2026-04-05 | 41,125,740 | 0 (0.0%) | 0 (0.0%) | — | 42,990,689 | 0 (0.0%) | — | — |
| 2026-04-06 | 56,793,469 | 16,175 (0.0%) | 9,695 (0.0%) | — | 54,928,835 | 16,175 (0.0%) | — | — |
| 2026-04-07 | 64,815,556 | 3,700,999 (5.7%) | 3,674,940 (5.7%) | — | 64,824,033 | 4,086,570 (6.3%) | — | — |
| 2026-04-08 | 85,476,609 | 20,916,314 (24.5%) | 14,824,263 (17.3%) | — | 85,467,940 | 21,136,598 (24.7%) | — | — |
| 2026-04-09 | 77,723,761 | 7,076,150 (9.1%) | 1,629,809 (2.1%) | — | 71,500,903 | 1,731,512 (2.4%) | — | — |
| 2026-04-10 | 86,059,046 | 0 (0.0%) | 0 (0.0%) | 26,945,264 | 51,923,403 | 0 (0.0%) | 26,945,340 | 0 (0.0%) |
| 2026-04-11 | 1,680,998 | 0 (0.0%) | 0 (0.0%) | 51,780,385 | 2,210,835 | 0 (0.0%) | 51,780,370 | 0 (0.0%) |
| 2026-04-12 | 65,244,922 | 8,203,244 (12.6%) | 1,449,705 (2.2%) | 54,890,322 | 64,715,278 | 8,203,244 (12.7%) | 54,890,448 | 0 (0.0%) |
| 2026-04-13 | 51,753,627 | 0 (0.0%) | 0 (0.0%) | 56,931,866 | 51,759,479 | 0 (0.0%) | 56,931,909 | 0 (0.0%) |
| 2026-04-14 | 62,138,735 | 4,322,614 (7.0%) | 3,022,800 (4.9%) | 52,920,620 | 62,133,442 | 4,322,614 (7.0%) | 52,920,426 | 0 (0.0%) |
| 2026-04-15 | 44,906,144 | 0 (0.0%) | 0 (0.0%) | 55,775,144 | 44,905,427 | 0 (0.0%) | 55,775,195 | 0 (0.0%) |
| 2026-04-16 | 61,738,745 | 0 (0.0%) | 0 (0.0%) | 59,336,016 | 62,722,747 | 0 (0.0%) | 59,335,975 | 0 (0.0%) |
| 2026-04-17 | 59,564,471 | 0 (0.0%) | 0 (0.0%) | 58,797,964 | ? | ? | 58,798,006 | 0 (0.0%) |
| 2026-04-18 | 51,615,252 | 777,146 (1.5%) | 20,285 (0.0%) | 43,163,652 | ? | ? | ? | ? |
| 2026-04-19 | 70,584,693 | 31,248,945 (44.3%) | 31,247,452 (44.3%) | 44,876,117 | ? | ? | ? | ? |
| 2026-04-20 | 66,576,723 | 24,601,204 (37.0%) | 24,601,203 (37.0%) | 49,982,276 | ? | ? | ? | ? |
| 2026-04-21 | 46,679,416 | 15 (0.0%) | 15 (0.0%) | 50,389,970 | ? | ? | ? | ? |
| 2026-04-22 | 57,255,861 | 1,554,219 (2.7%) | 287,608 (0.5%) | 50,925,343 | ? | ? | ? | ? |
| 2026-04-23 | 61,406,007 | 2,703,593 (4.4%) | 598,003 (1.0%) | 49,213,886 | ? | ? | ? | ? |
| 2026-04-24 | 57,441,769 | 7,860,333 (13.7%) | 4,818,292 (8.4%) | 30,939,810 | ? | ? | ? | ? |
| 2026-04-25 | 1,784,181 | 0 (0.0%) | 0 (0.0%) | 33,967,152 | ? | ? | ? | ? |
| 2026-04-26 | 32,999,800 | 0 (0.0%) | 0 (0.0%) | 36,782,003 | ? | ? | ? | ? |
| 2026-04-27 | ? | ? | ? | 48,262,957 | ? | ? | ? | ? |
| 2026-04-28 | 45,117,222 | 0 (0.0%) | 0 (0.0%) | 41,130,147 | ? | ? | ? | ? |
| 2026-04-29 | 50,841,758 | 0 (0.0%) | 0 (0.0%) | 51,023,567 | ? | ? | ? | ? |
| 2026-04-30 | 47,929,344 | 1,435,366 (3.0%) | 18,284 (0.0%) | 43,473,735 | ? | ? | ? | ? |
| 2026-05-01 | 37,975,538 | 0 (0.0%) | 0 (0.0%) | 42,281,232 | ? | ? | ? | ? |
| 2026-05-02 | 31,077,563 | 0 (0.0%) | 0 (0.0%) | 31,111,492 | ? | ? | ? | ? |
| 2026-05-03 | 34,522,766 | 0 (0.0%) | 0 (0.0%) | 34,810,780 | ? | ? | ? | ? |
| 2026-05-04 | 49,923,240 | 0 (0.0%) | 0 (0.0%) | 54,162,738 | ? | ? | ? | ? |
| 2026-05-05 | ? | ? | ? | 43,877,593 | ? | ? | ? | ? |
| 2026-05-06 | ? | ? | ? | 54,639,051 | ? | ? | ? | ? |
| 2026-05-07 | ? | ? | ? | 54,675,835 | ? | ? | ? | ? |
| 2026-05-08 | ? | ? | ? | 51,503,978 | ? | ? | ? | ? |
| 2026-05-09 | ? | ? | ? | 39,247,157 | ? | ? | ? | ? |
| 2026-05-10 | ? | ? | ? | 49,741,603 | ? | ? | ? | ? |
| 2026-05-11 | ? | ? | ? | 56,009,690 | ? | ? | ? | ? |
| 2026-05-12 | ? | ? | ? | 52,888,427 | ? | ? | ? | ? |
| 2026-05-13 | ? | ? | ? | 55,403,695 | ? | ? | ? | ? |
| 2026-05-14 | ? | ? | ? | 51,967,819 | ? | ? | ? | ? |
| 2026-05-15 | ? | ? | ? | 56,919,398 | ? | ? | ? | ? |
| 2026-05-16 | ? | ? | ? | 41,924,261 | ? | ? | ? | ? |
| 2026-05-17 | ? | ? | ? | 42,320,290 | ? | ? | ? | ? |
| 2026-05-18 | ? | ? | ? | 62,718,462 | ? | ? | ? | ? |
| 2026-05-19 | ? | ? | ? | 52,221,357 | ? | ? | ? | ? |
| 2026-05-20 | ? | ? | ? | 52,649,520 | ? | ? | ? | ? |
| 2026-05-21 | ? | ? | ? | 54,181,487 | ? | ? | ? | ? |
| 2026-05-22 | ? | ? | ? | 53,895,480 | ? | ? | ? | ? |
| 2026-05-23 | ? | ? | ? | 48,342,005 | ? | ? | ? | ? |
| 2026-05-24 | ? | ? | ? | 44,978,096 | ? | ? | ? | ? |
| 2026-05-25 | ? | ? | ? | 46,161,093 | ? | ? | ? | ? |
| 2026-05-26 | ? | ? | ? | 56,622,794 | ? | ? | ? | ? |
| 2026-05-27 | ? | ? | ? | 58,301,366 | ? | ? | ? | ? |
| 2026-05-28 | ? | ? | ? | 60,701,301 | ? | ? | ? | ? |
| 2026-05-29 | ? | ? | ? | 55,871,344 | ? | ? | ? | ? |
| 2026-05-30 | ? | ? | ? | 41,934,439 | ? | ? | ? | ? |
| 2026-05-31 | ? | ? | ? | 43,141,248 | ? | ? | ? | ? |
| 2026-06-01 | ? | ? | ? | 59,088,972 | ? | ? | ? | ? |
| 2026-06-02 | ? | ? | ? | 68,134,973 | ? | ? | ? | ? |
| 2026-06-03 | ? | ? | ? | 70,636,884 | ? | ? | ? | ? |
| 2026-06-04 | ? | ? | ? | 82,865,191 | ? | ? | ? | ? |
| 2026-06-05 | ? | ? | ? | 87,982,750 | ? | ? | ? | ? |
| 2026-06-06 | ? | ? | ? | 63,635,556 | ? | ? | ? | ? |
| 2026-06-07 | ? | ? | ? | 59,807,529 | ? | ? | ? | ? |
| 2026-06-08 | ? | ? | ? | 63,127,821 | ? | ? | ? | ? |
| 2026-06-09 | ? | ? | ? | 60,483,896 | ? | ? | ? | ? |
| 2026-06-10 | ? | ? | ? | 66,541,182 | ? | ? | ? | ? |
| 2026-06-11 | ? | ? | ? | 59,876,379 | ? | ? | ? | ? |
| 2026-06-12 | ? | ? | ? | 62,015,502 | ? | ? | ? | ? |
| 2026-06-13 | ? | ? | ? | 48,767,942 | ? | ? | ? | ? |
| 2026-06-14 | ? | ? | ? | 48,485,991 | ? | ? | ? | ? |
| 2026-06-15 | ? | ? | ? | 63,685,643 | ? | ? | ? | ? |
| 2026-06-16 | ? | ? | ? | 60,493,816 | ? | ? | ? | ? |
| 2026-06-17 | ? | ? | ? | 63,934,195 | ? | ? | ? | ? |
| 2026-06-18 | ? | ? | ? | 62,568,174 | ? | ? | ? | ? |
| 2026-06-19 | ? | ? | ? | 56,259,298 | ? | ? | ? | ? |
| 2026-06-20 | ? | ? | ? | 49,202,360 | ? | ? | ? | ? |
| 2026-06-21 | ? | ? | ? | 49,272,551 | ? | ? | ? | ? |
| 2026-06-22 | ? | ? | ? | 60,489,750 | ? | ? | ? | ? |
| 2026-06-23 | ? | ? | ? | 61,269,017 | ? | ? | ? | ? |
