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
