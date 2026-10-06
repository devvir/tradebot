<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Cold storage — what is left

`cold push` and `cold evict` work on the archives and the vault, and `cold pull` on the vault: how
they work is [COLD.md](../tooling/COLD.md), [COLD-PUSH.md](../tooling/COLD-PUSH.md),
[COLD-EVICT.md](../tooling/COLD-EVICT.md) and [COLD-VAULT.md](../tooling/COLD-VAULT.md). What follows
is not built.

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

**A first real run of the vault commands.** `cold push vault`, `cold evict vault` and `cold pull
vault` are tested against a stand-in for Mega and have not stored, removed or fetched a real file.
Unverified against Mega itself: that a download lands under its final name only once it is whole,
which `pull` relies on beside the size.

**`cold evict archives` and a vault that is partly away.** It takes a partition in the ledger as
stocked whether or not the vault's files are on disk.

**`cold audit`.** Checking the record against Mega: every stored tar present, at its size and
under its handle.

**`cold pull archives`.** Bringing partitions of the archives back: the record says which tars hold
them. Wanted for looking at the raw files again, and for restocking after a fix to how something is
stocked. The command offers the archives today and says it is not built.

**A partition the catalog withdraws entirely** stays in its tar. Nothing removes it.
