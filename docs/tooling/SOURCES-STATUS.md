# sources status

`sources status` is a read-only audit. It scans every location the vault lives in — local disk, configured remotes, Mega cold storage — and prints a wide per-table grid showing what's where. Nothing is written, no prompts are issued.

The scanner lives at `sources/scan/` so `sources update` can reuse it without depending on `status/`.

---

## Vocabulary

| Term | Meaning |
|---|---|
| **source file** | WS-origin `.csv.gz` with a collector suffix (e.g. `.local`, `.mtav`, `.tardis`). Needs preparation before use. |
| **bucket** | Ready-to-use `.csv.gz` with no suffix, one per table/day. WS buckets come from `sources prepare`; REST buckets are written directly by collection services. |
| **`.tmp` file** | A `.csv.gz.tmp` alongside a regular file name — collection or download in progress. |
| **local** | `VAULT_DATA_DIR` on this machine (default `/data/bitmex/vault`). |
| **remote** | Named SSH host listed in `SOURCES_REMOTE_VAULTS`. Holds its own vault — WS source files only. |
| **Mega** | Mega cloud, accessed via `mega-cmd` aliases. Two roots: `SOURCES_MEGA_VAULT` (buckets) and `SOURCES_MEGA_RAW` (raw WS sources). The grid treats them as one logical "Mega" column. |

---

## Tables (13 total)

**WS (7):** `announcement`, `chat`, `connected`, `instrument`, `liquidation`, `orderBookL2`, `publicNotifications`

**REST (6):** `compositeIndex`, `funding`, `insurance`, `settlement`, `trade`, `quote`

`trade`/`quote` are downloaded from BitMEX S3 by `courier`; the other four REST tables are paginated by `scribe`. The status tool doesn't distinguish between them — both arrive on disk as direct buckets, no preparation needed.

---

## Vault layout

```
<base>/
  <table>/
    <year>/
      YYYYMMDD.csv.gz                ← bucket (suffix-less)
      YYYYMMDD.<suffix>.csv.gz       ← source file (WS)
      YYYYMMDD.csv.gz.tmp            ← bucket downloading (REST)
      YYYYMMDD.<suffix>.csv.gz.tmp   ← source file downloading
```

Sources and their resulting bucket live side by side; they're distinguished by suffix presence. `sources prepare` writes the bucket directly into the year folder.

**Mega — year tarballs:** every year prior to the current one is stored as `YYYY.tar` directly inside the table dir (e.g. `<SOURCES_MEGA_VAULT>/orderBookL2/2021.tar`), replacing the year folder entirely. The current year keeps the normal `<year>/YYYYMMDD.csv.gz` layout.

**Local — never tarballed.**

---

## Environment variables

| Variable | Description |
|---|---|
| `VAULT_DATA_DIR` | Local vault root (set in root `.env`, default `/data/bitmex/vault`). |
| `SOURCES_REMOTE_VAULTS` | Comma-separated remotes. Format: `<name>:<user>@<host>:<path>`. |
| `SOURCES_MEGA_VAULT` | Mega path for ready buckets (current: `/User/Tradebot/vault`). |
| `SOURCES_MEGA_RAW` | Mega path for raw WS source files (current: `/User/Tradebot/wsSources/fs`). |

---

## Source file suffixes

| Suffix | Collector |
|---|---|
| `.local` | journalist (this machine) |
| `.<remote-name>` (e.g. `.mtav`) | journalist on the named remote, pulled via rsync |
| `.tardis` | tardy service |

REST files have no suffix — they're buckets from birth.

---

## Build & test

The Bash tool's non-login shell doesn't expose `pnpm` on PATH. **Always invoke pnpm by absolute path:**

```bash
/home/x/.local/share/pnpm/pnpm --filter @tradebot/tooling build
/home/x/.local/share/pnpm/pnpm --filter @tradebot/tooling test
```

Never run `npx tsc`, `tsc -b`, or any other raw TypeScript invocation from the repo root.

---

## Architecture — five layers

```
src/tools/sources/
  scan/            scanner (shared by status and update)
    index.ts       scanAll(config) → VaultState
    config.ts      loadConfig() — parses env vars
    tables.ts      ALL_TABLES, tableOrigin()
    types.ts       RemoteConfig / ScanConfig / DayState / TableState / VaultState
    local.ts       fs.readdir walk of VAULT_DATA_DIR
    remote.ts      ssh + find on each remote
    mega.ts        mega-find on both Mega roots; year-tar detection; checkMegaAvailable
    parse.ts       parseVaultPath / parseMegaTar

  status/
    run.ts         runStatus() — entry point; loads config, checks Mega, scans, prints
    state.ts       CellState type + per-day state factories (localState / remoteState / megaState)
    range.ts       buildRanges<A>() — generic hole-aware date-range walker
    holes.ts       structural-hole rules (sync + async) + HoleResult
    layout.ts      buildLayout(VaultState) → Layout  (ranges + table grouping)
    display.ts     printTable(VaultState) — all labels, colors, grid, notes
```

**Layer responsibilities (do not cross):**

1. **Scanner** (`scan/*`) — pure read-only. Returns `VaultState`; no expectations, no statuses, no pending-work concepts.
2. **State factories** (`status/state.ts`) — decide what a single day means per location: `absent`, `missing`, `sources`, `buckets`, `stored`, `progress`, `incomplete`, `mixed`, or `half`. No presentation strings.
3. **Range walker** (`status/range.ts`) — groups days into maximal contiguous ranges sharing one attribute tuple. Generic — no table, cell, or hole knowledge; callers supply `attrFor`, `isFilled`, `equal`.
4. **Holes** (`status/holes.ts`) — codifies known-permanent gaps per table/origin, with sync rules (pure predicates) and async rules (external API). Always pairs silencing with a visible caption — never silences quietly.
5. **Layout** (`status/layout.ts`) — drives the range walker per table, computes Mega spans, and collapses tables with identical content into groups.
6. **Display** (`status/display.ts`) — the only place labels, colors, and formatted strings live. Consumes the structured `Layout`; no state computation.

**Cross-subcommand rule:** `status/` never imports from `update/` and vice versa. Shared code lives at `sources/` or `sources/scan/`.

---

## Scanning

| Sub-scanner | Method |
|---|---|
| **local** | `fs.readdir` walk of `VAULT_DATA_DIR/<table>/<year>/`. Includes `.csv.gz` and `.csv.gz.tmp`. |
| **remote** | `ssh <user>@<host> "find <path> -type f \( -name '*.csv.gz' -o -name '*.csv.gz.tmp' \)"`. List-only. |
| **mega** | `mega-find <SOURCES_MEGA_RAW>` and `mega-find <SOURCES_MEGA_VAULT>`. Year tarballs detected by `parseMegaTar`. |

`scanAll()` runs Mega and all remotes in parallel; local is fast and sequential.

`mega-cmd` is verified by calling `mega-whoami` up front; missing binary → install hint; not logged in → "run `mega-login` first". Never authenticates programmatically.

**`--from` filter** is applied in the scan orchestrator after all data is gathered (`scan/index.ts: applyFromFilter`). For large vaults this is inefficient — open question whether to push into the scanners.

---

## State data model

```typescript
interface DayState {
  day: string;                                  // YYYYMMDD

  localSuffixes:     string[];                  // finalized WS source files
  localTmpSuffixes:  string[];                  // .tmp WS source files
  remoteSuffixes:    Record<string, string[]>;  // per remote name
  remoteTmpSuffixes: Record<string, string[]>;  // per remote name, .tmp
  megaSources:       string[];                  // suffixes in SOURCES_MEGA_RAW

  localBucket:    boolean;                       // true if a finalised local bucket exists
  localBucketTmp: boolean;                      // .tmp bucket exists locally (REST download, or WS prepare in progress)
  megaBucket:     boolean;                      // bucket present in SOURCES_MEGA_VAULT
}

interface TableState {
  name:     string;
  origin:   'ws' | 'rest';
  days:     Map<string, DayState>;              // only days with data in any location
  megaTars: number[];                           // years stored as <table>/YYYY.tar
}

interface VaultState {
  config:    ScanConfig;
  tables:    TableState[];
  scannedAt: Date;
}
```

---

## Display model

The grid is **(table × range) × location**.

| Column | Content |
|---|---|
| 1 | Table name(s), with origin label (`WS`/`REST`) and overall status (`up to date` / `partial`) beneath. Multiple tables with identical content collapse into one group with stacked names. |
| 2 | Range label. |
| 3..N | One column per location: `Local`, each configured remote, `Mega` last. |

WS table names are **bold white**; REST names are standard white (slightly dimmer) for quick visual differentiation.

### Cell vocabulary

| Cell | Color | Meaning |
|---|---|---|
| `stored` | green | Mega has the expected artifacts. For WS: both bucket (MEGA_VAULT) and sources (MEGA_RAW); for REST: just the bucket. A tar year also reads as `stored`. |
| `sources stored` / `bucket missing` | green / yellow | WS Mega only. Sources uploaded; bucket not yet there. Two stacked lines in the same cell. |
| `bucket stored` / `sources missing` | green / yellow | WS Mega only. Bucket uploaded; raw sources not there. |
| `missing` | yellow | Gap that should have data. In Mega: any past day in the table's date range with no artifact. In local/remote: today for WS tables (live collection expected). |
| `sources` | green | Source files present. |
| `buckets` | green | Bucket file present. |
| `mixed` | yellow | Local has both sources and a bucket for the same day — anomalous; sources should have been archived after bucketing. |
| `downloading` | cyan | `.tmp` file present. For WS: today only (live collection). For REST: any day (REST tools backfill historically). |
| `pending close` | cyan | WS only. `.tmp` for yesterday during the 00:00–00:59 UTC grace window — `sources prepare` waits one hour after midnight before finalising the day, so a late `.tmp` here is expected, not stalled. |
| `incomplete` | yellow | Leftover WS `.tmp` from a past day (outside the grace window) — collection didn't finalize. |
| `—` | dim | Nothing relevant in this location for this range. |

### Range labels

| Condition | Label |
|---|---|
| Today's range | `today` |
| Single day | `YYYY-MM-DD` |
| Multi-day; both endpoints year-aligned (Jan 1 / Dec 31) | `YYYY` or `YYYY → YYYY` |
| Multi-day; mixed alignment | `YYYY-MM-DD → YYYY-MM-DD` (year shorthand on any endpoint that lands on Jan 1 / Dec 31) |

### Range building

A **range** is a maximal date-contiguous span where every per-location `CellState` is identical across the real days inside it. The range walker (`range.ts`) steps day by day from the table's earliest date through yesterday, then appends today as a separate range that never merges with the past.

**Structural holes** are days that can never have data — e.g., days other than the 1st of the month before WS bucketing went live, because Tardis's free monthly archive only exposes day 01. These are codified in `holes.ts` as per-table or per-origin rules. The range walker treats filled days as transparent: they don't open a range, don't contribute to attribute comparison, and never split one.

Every structural fill is paired with a **caption** printed under the grid. Silenced gaps are always surfaced, never quietly hidden.

### Table grouping

Tables with identical origin, range structure, and notes collapse into one display group. The grouping key is a structural JSON of `{origin, ranges, notes}` — no presentation strings are involved, so label tweaks can't silently affect grouping.

### Overall status

`partial` if any cell in any range of the table has a bad state (`missing`, `incomplete`, `mixed`, or a `half` cell where either side is `missing`). `up to date` otherwise. `downloading`, `pending close`, and `—` do not downgrade status.

### Expectations driving "missing"

Mega is the final destination for all data — it must contain everything without gaps, from a table's first known date through yesterday. Local and remotes are staging areas; the only thing they're required to hold at any given moment is today's live collection for WS tables.

- **Mega, any past day in the table's date range, no artifact** → `missing`. The range starts at the earliest year with data in any location (including Mega tar years) and runs through yesterday.
- **Mega, today** → `—` (never expected; data for today isn't complete yet).
- **Local / remote, today, WS table** → `missing` when absent (live collection is expected).
- **Local / remote, any other day** → `—`.

Structural holes (filled by `holes.ts`) are excluded before the check. Unexplained gaps still produce `missing`.

---

## Structural holes

Holes are codified in `holes.ts` as typed rules:

- **`SyncHoleRule`** — pure date predicate, no external data.
- **`AsyncHoleRule`** — fetches external data to determine which days are absent. Returns `null` on failure; `computeHoles` adds a fail caption and skips filling so raw rows remain visible.

Current rules:

| Rule | Applies to | What it fills |
|---|---|---|
| WS Tardis archive | All WS tables | Days where `day < 2026-03-08` and `day` is not the 1st of the month — only day 01 of each month exists in Tardis's free archive. |
| Settlement | `settlement` table | Non-settlement days from 2026-01-01 onward. Fetched from `https://www.bitmex.com/api/v1/settlement?...` with 5 retries. Failure adds a note but leaves gaps visible. |

---

## Flags

`sources status` inherits parent `sources` flags it cares about:

| Flag | Effect |
|---|---|
| `--from <date>` | Restrict days to ≥ this date (`YYYYMMDD` or `YYYY-MM-DD`). |
| `--log [dir]` | Mirror output to `<dir>/status.log` (default `<cwd>`). |

Status ignores `--dry-run`, `--concurrency`, and `-y` — none apply to a read-only audit.

---

## Open questions

1. **`--from` push-down into scanners.** Currently the filter runs after Mega/local/remote scans return everything. For multi-year vaults `mega-find` returns a lot. Worth pushing the cutoff into the scanners?

2. **Stale `.tmp` from interrupted pulls.** If a previous `rsync` was killed, an `.mtav.csv.gz.tmp` may sit locally with no upstream activity. Currently reads as `incomplete` (since it's not today). Distinct flag worth it?

3. **Today's REST in Mega.** Currently shows `—` for REST tables when Mega is empty for today. Plausibly we'd want `missing` once enough time has passed. Skipped for now — no time-of-day logic.

4. **Structural-hole rules hardcoded.** `holes.ts` carries `WS_BUCKETING_START = 20260308`. If/when more cutoff dates accumulate (per-table, per-collector), worth lifting to a config table or env-driven map.

5. **`compositeIndex` 2019 missing day.** Known upstream gap, not yet encoded as a structural hole. Until then it shows as a `missing` cell in the 2019 row.
