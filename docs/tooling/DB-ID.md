# db id

`tools db id <value>` translates between a vault record `_id` and the ISO date it encodes. Pure offline arithmetic — no MongoDB connection.

---

## Encoding

Vault records use a deterministic 53-bit integer `_id` built from:

```
_id = dateOffset × 2^38 + slot × 2^8 + reserved
```

| Field | Bits | Range |
|---|---|---|
| `dateOffset` | 15 | days since 2000-01-01 UTC |
| `slot` | 30 | 0-based position within the day (1-based `position` = slot + 1) |
| `reserved` | 8 | 0–255 |

Encoding/decoding lives in `shared/utils/src/mongoIds.ts`. This command owns the date-vs-id disambiguation.

---

## Direction

The single `<value>` argument is auto-detected:

| Input | Action |
|---|---|
| Integer ≥ 100,000,000 | **Decode** — print `date`, `position`, `reserved`. |
| Date-shaped (YYYY, YYYYMM, YYYYMMDD; dashes optional) | **Encode** — print the minimum `_id` for that date (slot 0, reserved 0). |
| Anything else | Error. |

The 100M threshold cleanly separates the two input spaces:
- Max valid `YYYYMMDD` value: `20991231` ≈ 21M, well below.
- Min real `_id` (day 1 after epoch): `1 × 2^38` ≈ 274 billion, well above.

---

## Examples

```
$ db id 2024-03-15
id  1745169775198208

$ db id 20240315
id  1745169775198208

$ db id 1745169775199234
date      2024-03-15
position  5
reserved  2
```

---

## Use cases

- Building MongoDB range queries by hand: `{_id: {$gte: db id 20240101, $lt: db id 20240102}}` — though `db dump` / `db purge` / `db stats` all do this internally from date args.
- Decoding an `_id` seen in compass / logs to figure out which day and position it represents.
- Sanity-checking the encoding round-trips.

No environment variables required.
