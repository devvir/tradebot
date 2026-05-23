# db stats

`tools db stats [args]` reports MongoDB collection metrics. Two output modes selected by whether any date arg is present:

| Mode | Triggered by | Output |
|---|---|---|
| **Whole-collection** | no date args | Full per-collection metadata: docs, avg size, data size, storage size, index count, index size. Backed by `estimatedDocumentCount` + `$collStats`. |
| **Filtered** | any date arg | Plan-style table: one row per (collection, date) pair with approximate doc count and estimated data size. Storage/index columns omitted — they're whole-collection-only via `$collStats` and can't be filtered. |

Same arg parser as `db dump` and `db purge` — see [DB-DUMP.md](./DB-DUMP.md#argument-grammar).

---

## Examples

```
db stats                            # all collections, full stats
db stats quote                      # full stats for quote
db stats all                        # same as bare `db stats`
db stats 2024                       # filtered: every collection × 2024
db stats quote 2024                 # filtered: quote × 2024
db stats quote 2024 2025            # filtered: quote × {2024, 2025}
db stats -x quote 2024              # filtered, accurate count
```

---

## -x / --exact

`-e` was the obvious short flag but it collides with the global `-e, --env <path>` defined at the top-level CLI; we use `-x` instead (mnemonic: e**x**act).

By default, counts are **approximate**:

- **No-date mode**: `estimatedDocumentCount` — instant, reads collection metadata.
- **Filtered mode**: the shared two-tier strategy from `dump`/`purge`:
  - **Small collections** (< 1M docs total) → single `countDocuments({_id: range})` — fast on a small index.
  - **Large collections** → bracket the active span with two PK seeks, then one PK seek per day in the span, decoding the `position` field from each day's max `_id`. Sub-second per year even on billion-doc collections, but assumes dense slot packing (true for append-only vault writers).

With `-x` / `--exact`, both modes switch to `countDocuments` (no metadata, no PK-seek tricks). Accurate even if slot packing turns out to be sparse, but slow on large collections — a year of quote takes ~80 seconds to count exactly vs ~1 second approximate.

The flag is **stats-only**. `dump` and `purge` always run with the fast approximate path.

---

## Output

### Whole-collection mode

```
Collection      Documents  Avg Size     Data  Storage  Indexes  Index Size
──────────────────────────────────────────────────────────────────────────
quote       2,992,790,402    141.0B  393.7GB   78.9GB        1      41.4GB
trade         523,456,789    268.0B  131.5GB   29.2GB        1       7.1GB
```

### Filtered mode

```
Collection   Period   ~ Documents   ~ Size
──────────────────────────────────────────
quote        2024     245,123,456   33.0GB
quote        2025     310,567,890   41.8GB
──────────────────────────────────────────
Total        2 pairs  555,691,346   74.8GB
```

The `~` prefix on Documents/Size in filtered mode flags both as approximate.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DB_URL` | yes | MongoDB connection URI. |
| `DB_DATABASE` | yes | Database name. |

`db stats` does no filesystem or Mega operations — `DB_DUMP_DIR` / `DB_DUMP_MEGA_DIR` are not consulted.

---

## Flags

| Flag | Description |
|---|---|
| `-x, --exact` | Force `countDocuments` for accurate counts. Slow on large collections. |
