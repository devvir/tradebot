# db purge

`tools db purge <args>` permanently deletes documents from MongoDB matching the same collection × date filters that `db dump` uses. Designed around one safety question: *is this data backed up on Mega before I throw it away?*

Same arg parser as `db dump` — see [DB-DUMP.md](./DB-DUMP.md#argument-grammar).

---

## Safety flow

1. **Parse args** → pairs (collections × dates).
2. **Scan Mega** for each pair via `mega-ls` (one per unique collection, parallel). Builds a `local/mega` status map.
3. **Identify unbacked-up pairs** — those whose `<DB_DUMP_MEGA_DIR>/<collection>/<date-key>.archive.gz` is missing from Mega.
4. **If any are unbacked-up** → print them and prompt:
   ```
   Not backed up on Mega:
     quote/2014.archive.gz
     trade/2015.archive.gz

   ? Skip 2 unbacked-up pairs? [Y/n]    ← default Y
   ```
   - **Y** → drop those pairs. If nothing remains, abort cleanly.
   - **n** → keep them in the list. **Second guard prompt** required:
     ```
     ⚠ 2 pairs have no Mega backup — deleting them is irreversible.
     ? Really delete unbacked-up data? [y/N]    ← default N
     ```
5. **Count** surviving pairs (shared `gatherRows`, approximate counts).
6. **Plan table** with `⚠ DESTRUCTIVE — will permanently delete from MongoDB` footer.
7. **Final confirm**:
   ```
   ? PERMANENTLY DELETE 5 pairs from MongoDB? [y/N]    ← default N
   ```
   Both the proceed prompt and the unbacked-up guard default to **No** — must actively type `y`.
8. **Append to `purge.log`** — timestamp, args, skipped pairs, pairs being deleted *without* a Mega backup, plan table.
9. **Execute** — one `deleteMany({_id: {$gte, $lt}})` per pair, sequential. Live "Xs elapsed" status updated every second per pair, final "deleted N in Ys" line on completion.
10. **Append outcomes** to `purge.log` (deleted counts, durations, any failures).

If `DB_DUMP_MEGA_DIR` is unset, the tool warns up front that Mega backup verification is impossible — every pair will be flagged as unbacked-up and the guard prompt kicks in for the entire list.

---

## What gets deleted

Each pair becomes one MongoDB delete:

```js
db.<collection>.deleteMany({ _id: { $gte: <startId>, $lt: <endId> } })
```

For pairs with no date filter, `{}` — the whole collection's documents (collection itself remains).

The plan table renders directly from the same `Pair` objects used in the delete filter — what you see is exactly what gets deleted. Counts are approximate (same fast strategy as `db dump`); the list of collections and periods is exact.

---

## purge.log format

Plain ASCII, append-only. Two block types per run: the plan (written at confirm time) and the results (appended after deletion).

```
════════════════════════════════════════════════════════════════════════
2026-05-23 12:00:00Z  —  purge  —  args: quote 2014

skipped — not on Mega (1):
  quote/2015.archive.gz

⚠ deleting WITHOUT Mega backup (1):
  quote/2014.archive.gz

Collection  Period  ~ Documents   ~ Size
─────────────────────────────────────────
quote       2014    12,345,678    1.2GB
─────────────────────────────────────────
Total       1 pair  12,345,678    1.2GB

results:
  ✓ quote/2014  deleted 12345678 docs in 32.1s
  total: 1 ok, 0 failed
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DB_URL` | yes | MongoDB connection URI. |
| `DB_DATABASE` | yes | Database name. |
| `DB_DUMP_DIR` | no | Where `purge.log` is written. Default `./db-dump`. |
| `DB_DUMP_MEGA_DIR` | recommended | Mega base path for backup verification. Without it, every pair is treated as unbacked-up. |

---

## External dependencies

| Tool | Purpose | Required |
|---|---|---|
| `mega-ls` | Backup verification on Mega. From `mega-cmd`. | only if `DB_DUMP_MEGA_DIR` is set; missing CLI degrades silently to "no mega backups found". |

No mongodump or mongorestore involvement — purge is a pure MongoDB operation.
