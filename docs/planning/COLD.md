<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Cold storage — what is left

`cold push`, `cold evict`, `cold pull` and `cold audit` work on the archives and the vault, and the
catalog's database has a push and a pull of its own: how is [tooling/COLD.md](../tooling/COLD.md). What
follows is either not built or has not yet run against Mega itself.

## Not run against Mega

**A first real push.** The flow is tested in pieces — planning against the real catalog, grouping,
the record, the disk check, correcting a tar — and has not yet packed and uploaded a tar end to end.
Two things in it are unverified against Mega itself: the column `mega-transfers` names a
download's local path by, and that uploading over an existing name leaves a new handle.

**A first real run of the vault commands.** `cold push vault`, `cold evict vault` and `cold pull
vault` are tested against a stand-in for Mega and have not stored, removed or fetched a real file.
Unverified against Mega itself: that a file stays in Mega's list of downloads until it is whole
under its final name, which the pulls rely on beside its size.

**`cold audit` against real Mega.** Its check of the record against Mega has read only a stand-in's
listing.

## Not built

**A partition the catalog withdraws entirely** stays in its tar. Nothing removes it.

**Leaving the running month out of the catalog's copy.** A partition of the running month changes
with every update, so every `cold push catalog` sends it again. Left out, the copy would be of the
catalog as it was some days back, and a restore would set each series' tip back to match, so that
the next update finds the newest files again by asking the venue. The copy would then change only
where history does.

**Months with a gap between them.** A venue whose stored months are not one unbroken run is the
shape a lost or skipped month makes. It is not proof of loss — a venue may have published nothing
that month — so an audit would point at it, not offer to put it right. The audit `cold` had before
it stored partitions looked for this (`gaps` in `dev/tooling/src/tools/cold/legacy/audit.ts`, last
present at commit `69fb0fd7430562e66d06b5acf3b8e2f678e10b33`).

**One page, venue by venue, across both trees.** What exists — the catalog's partitions, the
vault's ledger — against how much of it is stored in Mega, in one table for the archives and the
vault together, with which tree is holding a venue's eviction back and what freeing it would give.
`cold stats` shows one tree at a time. The same earlier audit printed such a page (`coverage` and
`reclaim` in the file and commit above).

**REST and WebSocket captures.** Once they are collected they are raw data to back up like the
archives; `cold` knows two origins, the archives and the vault.
