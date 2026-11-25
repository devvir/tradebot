<!-- ─────────────────────────────────────────────────────────────────────────────
     Planning. Live scratch, not a description of anything that exists.
     Cut what is settled into the real docs; delete the file when nothing is left.
     ───────────────────────────────────────────────────────────────────────── -->

# Hauler — what is left

How hauler works is [HAULER.md](../services/HAULER.md). This is only the outstanding work on it.

## The first haul

In order:

1. **Finish the first haul** through `backfill-20` into the archives directory. A clean catalog
   produces no `.bak`; bitget's seed is one known cause of them (see
   [BUGS.md](BUGS.md#bitget-the-catalog-holds-the-poorer-of-two-copies-of-some-days)).
2. **Look at what it did not touch.** Every file the catalog lists gets the pass's date as its
   modification time, so a file under the archive with an older date is one nothing listed —
   misfiled, withdrawn, or junk.
3. **Compare the new catalog against `catalog.bak`** once every backfill has completed.

**A walk whose first listing request is refused waits 30 minutes, not 5.** Connection failures and
`5xx` from the catalog are waited out and asked again, and a listing that fails after its first page
keeps what the walk fetched. What is left is a `4xx` before the first page: the walk fails and rests
the quiet interval. Whether it should come back sooner is undecided.
