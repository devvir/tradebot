<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Cold storage — what is left

`cold push archives` stores partitions: how it works is [COLD.md](../tooling/COLD.md) and
[COLD-PUSH.md](../tooling/COLD-PUSH.md). What follows is not built.

**Everything below is rebuilt from what was there before**, not from nothing: the earlier commands,
their tests and the docs of the push they shared are kept in
`dev/tooling/src/tools/cold/legacy/`, and [COLD-EVICT.md](../tooling/COLD-EVICT.md) and
[COLD-AUDIT.md](../tooling/COLD-AUDIT.md) still describe `evict` and `audit` as designed. The
decisions in them stand unless one is about something that no longer exists — the per-file record,
the facts store, the venues' own tree shapes.

**A first real push.** The flow is tested in pieces — planning against the real catalog, grouping,
the record, the disk check, correcting a tar — and has not yet packed and uploaded a tar end to end.
Two things in it are unverified against Mega itself: the column `mega-transfers` names a
download's local path by, and that uploading over an existing name leaves a new handle.

**`cold push vault`.** The vault's partitions are stocker's: a month of a vault slice, at a
revision. Nothing serves them as the catalog serves the archives' yet.

**`cold evict`.** Reclaiming local disk once cold storage provably holds what is deleted: for the
archives, a partition whose tar is stored at the version the catalog holds.

**`cold audit`.** Checking the record against Mega: every stored tar present, at its size and
under its handle.

**`cold pull`.** Bringing partitions back: the record says which tars hold them.

**A partition the catalog withdraws entirely** stays in its tar. Nothing removes it.
