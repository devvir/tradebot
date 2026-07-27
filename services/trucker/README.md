# Trucker Service

Downloads each venue's published historical archives to the host, byte-for-byte as published.

It is the haulage stage: get files off the internet and onto disk. No transformation, no
common format, no vault — a later service brings these to a common shape, and it can only do
that honestly if what lands here is the venue's own bytes.

## What it does

- Fetches **107 datasets** from **binance, bitget, bybit, gate, htx, kucoin, okx** — trades,
  klines, order books, funding, borrowing, mark/index series, open interest and liquidations:
  everything each venue publishes as files, except options
- Stores under `<host dir>/<venue>/<the venue's own path>` — layouts are mirrored, not
  renamed, so a file is re-verifiable against its source and a URL maps to one path
- Takes **monthly files through June 2026 and daily files from 1 July 2026**, so the venues
  publishing both shapes never store the same trades twice
- Resumes by looking at the disk, so a re-run costs listings, not downloads
- Walks **month by month, oldest first**, across every dataset and symbol of a venue before
  moving on, so finished months are finished for everyone rather than for the symbols reached
  so far
- Publishes **one fact** for anything downstream — the month a venue is collected through, in
  `@shared/complete/<venue>.tsv`. A month at or below it is complete and will never change,
  which is all stocker or a cold-storage step needs to act
- Flags it when a venue **changes history it already published** — files withdrawn, backfilled,
  or a gap quietly filling — in `@shared/changes/<venue>.tsv`. Trucker collects what the venue
  now says and leaves the decision to a human, since re-tarring cold storage or rebuilding a
  partition is not a collector's call to make
- Records **what each venue publishes** once, in `@meta/inventory/`, so the month-major walk
  answers "what exists in this month?" from disk rather than asking the venue again for every
  month of every symbol. That is what lets a venue the size of binance finish a month at all
- Tracks a per-symbol cursor on disk, under `@meta/` beside the archives — always a day,
  whatever span a venue's files cover — so nothing but the data directory has to be kept. That,
  and everything else under `@meta/`, is trucker's own bookkeeping and not for outside
  consumption
- Re-sweeps every few hours, picking up newly published files through the same code path as
  the initial backfill
- Verifies checksums where published (Binance SHA-256, KuCoin MD5), and compares
  `Content-Length` everywhere else
- Backs off per venue on 429/5xx, honouring `Retry-After`; 403 too, except on Bitget, where
  it is how the CDN reports a missing file

Full technical detail — architecture, the granularity cutover, the progress model, per-venue
layouts and quirks — is in [docs/services/TRUCKER.md](../../docs/services/TRUCKER.md).
What is not collected yet and what is still open is in
[docs/planning/TRUCKER.md](../../docs/planning/TRUCKER.md).

## Storage

Trucker owns its storage. The host directory is mounted at a fixed container path, exactly
as vault does it, and must exist and be writable by uid 1000 before the service starts:

```bash
sudo mkdir -p /storage/tradebot/trucker
sudo chown 1000:1000 /storage/tradebot/trucker
```

The service checks writability at startup and fails immediately with the command to fix it,
rather than after a long listing pass.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATA_DIR` | yes | — | **Host** root of the tradebot tree; `@shared` lives at `$DATA_DIR/@shared` and mounts at `/data/shared` |
| `TRUCKER_DATA_DIR` | no | `$DATA_DIR/trucker` | **Host** archive directory, mounted at `/data/trucker` |
| `TRUCKER_VENUES` | no | _(all)_ | Comma-separated: `binance`, `bitget`, `bybit`, `gate`, `htx`, `kucoin`, `okx` |
| `TRUCKER_START_MONTH` | no | — | Oldest month fetched, **inclusive**. `yyyy-mm`, `yyyymm` or `yymm` |
| `TRUCKER_END_MONTH` | no | _(none)_ | Newest month fetched, **inclusive** — `2019-12` fetches through 31 December 2019. Unset fetches everything published. Walk the backfill an era at a time |
| `TRUCKER_SYMBOLS` | no | _(all)_ | Symbol tokens to keep, matched as case-insensitive substrings — `BTC` selects `BTCUSDT`, `BTC_USDT` and `BTC-USDT-SWAP` alike |
| `TRUCKER_CONCURRENCY` | no | `4` | Concurrent downloads **per venue**; venues run concurrently |
| `TRUCKER_RESCAN_HOURS` | no | `6` | Hours between sweeps for newly published files |
| `TRUCKER_MIN_FREE_GB` | no | `50` | Stop fetching when the volume drops below this |

`TRUCKER_DIR` overrides the container path when running outside Docker.

## Adding a venue

One file under [src/venues/](src/venues/) implementing `VenueArchive`: its datasets, how to
list symbols, and how to list files for a symbol. Register it in
[src/venues/index.ts](src/venues/index.ts). Download, resume, verification, backoff and
storage are shared and need no changes.

Discovery is the only part that genuinely differs — Binance, KuCoin and HTX publish an S3 XML
listing, Bybit an HTML index, Gate, OKX and Bitget nothing at all (URLs are constructed from a
date range and probed, so a 404 means "never published" rather than an error).

A dataset's `id` is its progress key and must stay stable; its `path` is the venue's own name
for the series, which is routinely different (`funding-rates`, `depth/orderbooklv50`). Whether
a series publishes months, days or both is read from the listing, so nothing needs declaring.

A venue that constructs URLs should bound each symbol by its listing date, or it will probe
years that cannot exist.

## Development

```bash
pnpm install
pnpm build
pnpm test
```
