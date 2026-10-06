<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Cold storage — what is left

`cold push archives` stores partitions and `cold evict archives` removes them from disk: how they
work is [COLD.md](../tooling/COLD.md), [COLD-PUSH.md](../tooling/COLD-PUSH.md) and
[COLD-EVICT.md](../tooling/COLD-EVICT.md). What follows is not built.

**Everything below is rebuilt from what was there before**, not from nothing: the earlier commands,
their tests and the docs of the push they shared are kept in
`dev/tooling/src/tools/cold/legacy/` — the earlier `evict`, as designed, beside them in
`legacy/docs/COLD-EVICT.md` — and [COLD-AUDIT.md](../tooling/COLD-AUDIT.md) still describes `audit`
as designed. The
decisions in them stand unless one is about something that no longer exists — the per-file record,
the facts store, the venues' own tree shapes.

**A first real push.** The flow is tested in pieces — planning against the real catalog, grouping,
the record, the disk check, correcting a tar — and has not yet packed and uploaded a tar end to end.
Two things in it are unverified against Mega itself: the column `mega-transfers` names a
download's local path by, and that uploading over an existing name leaves a new handle.

**A partition that changed after it was evicted.** Only the files that changed are downloaded
again, so the partition is on disk in part and its tar cannot be corrected from disk alone. `cold
push` handles it without a hand: it sees a stored partition whose version changed, confirms that
every file that changed is on disk, brings the tar back, and makes the partition whole from the two
— the unchanged files from the tar, the changed ones from disk — before storing it again. Whether it
uses `cold pull` to do so is open.

**`cold push vault`.** The vault's partitions are a month of a vault slice, at a revision, and the
vault's ledger lists them. They are recorded as the archives are: `tar` and `held` rows under the
`vault` origin, a `held` row being a vault partition at its revision.

**`cold evict vault`.** Removing vault partitions that cold storage holds, on request rather than
as a matter of course: the vault is what everything downstream reads. It writes `evicted.csv` in the
vault — partition, revision, whether it is evicted, and when — so that what stocks the vault knows
the files are meant to be absent. Until it exists, `cold evict archives` takes a vault partition
marked as moved out as not accounted for.


**`cold audit`.** Checking the record against Mega: every stored tar present, at its size and
under its handle.

**`cold pull`.** Bringing partitions back: the record says which tars hold them.

**A partition the catalog withdraws entirely** stays in its tar. Nothing removes it.
