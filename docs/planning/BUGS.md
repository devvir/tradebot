# Open bugs

Known defects that are not fixed. One entry each, with **how to check it is still real** — an
entry nobody can re-verify is a rumour, and this file is only worth keeping if every line in it
can be confirmed against the live system in under a minute.

Close an entry by deleting it. A fixed bug leaves a test and a docblock behind; it does not need
a headstone here.

---

## The audit's month counts measure cold storage, not what exists

**Verified 2026-08-13.**

The first line of every dashboard cell reads `108 mo (2017-07 → 2026-06)`, and it is derived from
`cold.sqlite` — so it counts **months cold storage holds parts for**, not months of data that
exist. That makes an inventory out of a backup backlog.

The proof is bybit: its vault parts were purged on 2026-08-13 while every partition stayed on disk,
and the column went to `—`. Nothing was lost and the number said everything was.

It should come from the producers: the vault's ledger, and the catalog for the archives. Cold storage
stays the authority for lines two and three, which are about what is backed up, and that is the one
thing it does know.

**How to check:** compare a venue's first-line month count against the `vault` topic of the facts
store (`@shared/facts/vault.sqlite`), which knows nothing about backups.

Fixing it belongs to the cold scripts' move onto hauler's archives.

---

## Bitget: the catalog holds the poorer of two copies of some days

**Observed 2026-10-07**, when hauler passed over files downloaded before the catalog existed and
found 370 of bitget's that differed from what the catalog describes — 652 a day later, with spot klines
and spot quotes. Each was moved aside as `.bak`
and the catalog's copy fetched in its place. In every pair looked at, the file that was already on
disk is the fuller one. Two separate causes, and **neither is understood well enough to fix yet** —
what follows is what was seen, and what was not checked.

### Klines: an era-1 file that is an empty archive, where the era-2 file holds the day

75 files, perp `klines,1m`: seven symbols (ADA, BNB, BTC, DOGE, SOL, XLM, XRP — all `…USDT`) on
eleven days between 2022-01-19 and 2023-01-05. These are era-2 keys dated before era 2 began, which
[BITGET.md](../venues/BITGET.md) already knows about and reads as duplicates of era 1.

Seen:

- The venue serves both for the same day. For `ADAUSDT` 2022-01-19:
  `kline/ADAUSDT/ADAUSDT_UMCBL_1min_20220119.zip`, 66,009 bytes, modified 2022-11-01, which is the
  catalog's entry; and `kline/ADAUSDT/UMCBL/20220119.zip`, 67,274 bytes, modified 2024-07-30, whose
  checksum is the file that was on disk.
- Ten pairs unpacked and compared hold the same candles, time for time and value for value —
  1,440 of them in the one counted. Only the header's case differs, as BITGET.md says.
- **Ten of the 75 era-1 files are 22-byte archives with nothing in them**, and their era-2 copies
  are full-sized. For `ADAUSDT` 2022-04-03 the venue answers 22 bytes at the era-1 path and 64,051
  at the era-2 one. `BNBUSDT` 2022-01-19 and 2022-05-18 are two more.

**Spot `klines,1m` does it too**: 125 more files by 2026-10-08 (105 when these were counted), seven symbols (AAVE, ADA, BNB, BTC,
DOGE, PYUSD, QKC — all `…USDT`) on 43 days between 2022-01-19 and 2023-10-31. In the one pair
opened, the file that was on disk was generated 2024-07-30 and its replacement 2022-11-08, as on the
futures line. None of the 105 replacements is an empty archive. Nothing else about them was looked
at — `QKCUSDT` and `PYUSDUSDT` are 58 of them and all in 2023, which may be another matter.

Not checked: how many era-1 kline files across the catalog are empty archives, and whether each has
an era-2 copy. The days BITGET.md counts as "the only copy" may have been found by an era-1 key
being absent, which an empty one is not.

**How to check:**
`curl -sI -A Mozilla/5.0 https://img.bitgetimg.com/online/kline/ADAUSDT/ADAUSDT_UMCBL_1min_20220403.zip`
answers `content-length: 22`, and the same for `…/kline/ADAUSDT/UMCBL/20220403.zip` answers 64051.

### Perp depth: a series reading a folder that holds a fragment

295 files, perp `quotes`: `ZKUSDT` (151) and `TAIKOUSDT` (144). The catalog reads each through a
`url_symbol` — `ZKSYNCUSDT` from 2024-07-27 and `TKOUSDT` from 2024-09-09 — and the files that were
on disk came from the folder under the plain symbol. Every replacement is far smaller.

Seen, for `ZKUSDT` 2024-07-27:

- `depth/ZKSYNCUSDT/2/20240727.zip`, the catalog's entry: 4,643 bytes, one sheet named
  `20240727_7.xlsx`, **3 rows**.
- `depth/ZKUSDT/2/20240727.zip`: 129,133 bytes, one sheet named `20240727_2.xlsx`, **4,317 rows**,
  and the size of the file that was on disk.
- Both quote around 0.16 on that day.

For `TAIKOUSDT` only sizes were compared — 2024-11-16 is 46,715 bytes now and was 246,688 — and the
venue was not asked.

Not checked: whether `depth/ZKUSDT/2/` is one instrument for its whole range or an earlier holder of
the ticker; the range each folder covers; and whether this is the futures-line counterpart of *Depth
can be spelled differently from the rest of an instrument* in BITGET.md, which was measured on spot.
A larger file is not proof of the right file.

**How to check:** the same request for `depth/ZKSYNCUSDT/2/20240727.zip` and
`depth/ZKUSDT/2/20240727.zip` answers 4643 and 129133.

**Spot `quotes` too**: 157 files by 2026-10-08. Not opened — only counted.

### What it costs meanwhile

A hauler pass that meets one of these on disk replaces the fuller copy with the catalog's, keeping
the old one as `.bak`. Restoring a `.bak` is undone by the next pass for as long as the catalog
describes the other copy.

Fixing it belongs to the bitget seed, and to nothing quicker: bitget reuses tickers, moves folders
and has changed its paths more than once, so every pairing above is to be confirmed against the
venue before the seed is touched.
