# data sync

`data sync` scans the vault, identifies files that exist but haven't completed their pipeline journey, and offers to move them along. It is task-oriented: if a file is simply absent it's ignored — only existing files that should have been copied, moved, or prepared but weren't produce tasks.

**Read-only inspection** lives in `data status`. Both commands share the same scanner. See [DATA-STATUS.md](DATA-STATUS.md) for vocabulary, vault layout, env vars, scanner mechanics, and state data model.

---

## Data flows

Four one-way flows plus an optional local cleanup step. Remotes are pull-only; Mega is push-only.

```
remote(s)  ──pull──▶  local sources  ──prepare──▶  local buckets  ──(delete)──▶  ∅
                            │                             │
                        back up                      back up
                            │                             │
                            ▼                             ▼
                       Mega raw                     Mega vault
```

| Flow | What moves | Direction |
|---|---|---|
| **pull** | WS source files from remote → local | pull-only |
| **back up sources** | Local WS sources → `SOURCES_MEGA_RAW` | push-only |
| **prepare** | Local WS sources → local bucket | local |
| **back up buckets** | Local buckets → `SOURCES_MEGA_VAULT` | push-only |
| **delete local buckets** | Local buckets already in Mega → deleted | local, optional |

---

## Scope

Only days from **2026-01-01 onward** are considered. Earlier data is already fully handled outside this script.

---

## Task derivation

After scanning, `deriveTasks(state, mode)` walks the `VaultState` and produces a task list. A day that has no files anywhere produces no tasks — there is nothing to act on.

There are two derivation modes:

- **`planned`** — used once at startup to print the summary. Tasks are forward-looking: `backup-source` includes suffixes that will arrive via pull (marked `fromPull`); `backup-bucket` includes buckets that will arrive via prepare (marked `fromPrepare`); `cleanup` includes everything post-pipeline. The counts reflect "if everything you're about to run succeeds".
- **`live`** — used right before showing each task in the interactive loop, after refreshing the local-disk state. Predictive flags are off; a file is in the task only if it actually exists on disk now. If a prior task was skipped, failed, or is stubbed, its phantom outputs naturally drop out of the next task's view.

The summary shows the planned counts, the interactive prompt shows the live ones — so the prompt always reflects reality, but the summary still tells you what the full run would do.

### Refreshing state between tasks

Right before showing each task that consumes a prior task's output, the interactive loop refreshes the relevant slice of state:

| Task | What's refreshed |
|---|---|
| `clean-rsync-temps`, `pull` | nothing — first in the pipeline, nothing earlier could have changed |
| `backup-source`, `prepare`, `backup-bucket` | local disk only — `scanLocal` is re-run and overlaid onto the existing state via `refreshLocal(state)` |
| `cleanup` | full re-scan (local + remotes + Mega via `scanAll`) — cleanup decisions depend on which sources still exist on remotes and which buckets actually made it to Mega |
| `delete-local-buckets` | full re-scan — needs current Mega state to ensure it only proposes buckets that are actually there |

The cleanup and delete-local-buckets full re-scans are the ones that go back over the network. Everything else is a quick local walk.

### 0. Clean rsync temps (pre-flight)

Before the main pipeline, `findRsyncTemps(localBase)` walks the local vault looking for leftover rsync partial-transfer files (pattern: `.YYYYMMDD[.suffix].csv.gz.XXXXXX`). If any are found, a clean task is prepended to the list. This runs first so subsequent pulls start clean.

### 1. Pull (per remote, WS only)

A pull task is generated for a remote when it holds a WS source suffix that local doesn't have **and** the day has no bucket (local or Mega). One task per remote that has anything to pull. Each file is pulled individually with:

```
rsync -az --ignore-existing <user>@<host>:<path>/<table>/<year>/<file> <local-path>
```

Progress is printed per file (`Pulling <table>/<year>/<day>.<suffix>.csv.gz`) so long-running rsyncs are visible.

### 2. Back up sources (WS only)

Collect every WS source file that will be local after the pull but is not yet in `SOURCES_MEGA_RAW`. This counts both currently-local suffixes and suffixes that will arrive via pull. Each file carries a `fromPull` flag so the summary can show the breakdown.

At execution time, files that aren't on disk (because the pull was skipped or failed) are silently skipped — the next run picks them up. After the upload batch, every file is verified against Mega (see Execution → Upload verification).

### 3. Prepare (WS only)

Collect every WS day that will have local source files (after pull) but has no bucket anywhere — no finalised bucket in local or Mega, and no `.csv.gz.tmp` indicating a bucket is currently being written (e.g. by a concurrent `data prepare`). Groups by `(table, year)` for the summary display; execution is whole-vault (see Execution).

**Abnormal days:** the update command expects every prepared day to have sources from every defined collector — the local machine (`.local` suffix) and every configured remote. A day that has at least one source but is missing at least one expected suffix is flagged as **abnormal**. Abnormal prepare tasks:

- Show a `⚠` warning in the summary with the count of affected days.
- Default the prompt to **N** (instead of Y).
- Are **skipped silently** when `-y` / `--yes` is set.

This ensures incomplete days are never silently prepared in unattended runs, and are always visible when running manually.

### 4. Back up buckets (WS and REST)

Collect every bucket that will exist locally after prepare runs but is not yet in `SOURCES_MEGA_VAULT`. A day whose only local bucket is a `.csv.gz.tmp` (still being written) is not collected — it's not a finalised bucket yet. This includes:

- Buckets currently on disk under `<year>/` (`fromPrepare: false`)
- WS days that the prepare task will produce a bucket for (`fromPrepare: true`)

Each file carries a `fromPrepare` flag so the summary can show the breakdown. Applies to both WS and REST (REST never has `fromPrepare: true`).

At execution time, predicted-prepare files that aren't on disk yet are silently skipped — the next run picks them up. After the upload batch, every file is verified against Mega (see Execution → Upload verification).

### 5. Delete local buckets (optional)

Find local buckets that are already present in `SOURCES_MEGA_VAULT` — their local copy is now redundant. Groups them by `(table, year)` and prompts once per range.

**This step is always manual.** It is never auto-run under `-y` / `--yes` and does not support the `a` (accept-all) option from other tasks. The prompt is `y/N/q` per range, with `N` as the default. `q` stops asking and skips remaining ranges.

**Execution:** `fs.unlinkSync` each bucket file in the range. Failures are reported but do not abort the remaining ranges.

---

## Summary

After scanning, `data sync` prints a summary before asking to execute anything. The summary is a bullet list: one line per task type that has work, nothing for task types with nothing to do.

```
  • 1 interrupted rsync temp file can be removed
  • 47 sources for 3 tables can be pulled from mtav
  • 61 (54 present, 7 pulled) source files from 3 tables can be backed up in Mega
  • 12 dates for 2 tables can be prepared (sources → bucket)  ⚠ review required
  • 14 (7 present, 7 prepared) bucket files from 4 tables can be backed up in Mega
  • 28 (14 local, 14 remote) source files from 4 tables can be moved to .trash
  • 9 local bucket files from 2 tables can be deleted (backed up in Mega) (2 ranges)
```

Backup-source and backup-bucket counts are **predictive** — they include files that will exist locally after the previous step (pull / prepare) runs. The breakdown after each count shows what's already on disk versus what depends on the prior step succeeding. The breakdown is omitted when all files are already present (no dependency to flag).

If there is nothing to do: `✓ everything is up to date`.

---

## Interactive loop

After the summary, the command walks each task in order. For each task it shows a short preview (up to ~8 files, then "… N more") and prompts:

```
Run this task? [Y/n/a]  (Y = yes, n = skip, a = accept all remaining)
```

For tasks flagged abnormal (`isAbnormal: true`) the hint changes to `[y/N/a]` — N is the default — and a `⚠` warning explaining why precedes the prompt.

With `-y` / `--yes` set, all tasks are auto-accepted without prompting, **except** abnormal ones, which are skipped with a warning. This is the same mechanism for every task type — prepare days missing collector sources, cleanup with the "bucket-built-without-this-source" pattern, etc.

**Delete-local-buckets is always manual.** Even under `-y` or after accepting all, this task is skipped with a notice. It uses its own `y/N/q` prompt per range — there is no `a` option. `q` stops asking and skips the remaining ranges.

---

## Cleanup

The last task in the pipeline. Sources that have completed their journey are moved aside — never deleted programmatically. `.trash` is a holding area for manual review and eventual deletion by the user.

**What gets trashed**, based on **predicted post-pipeline state** (i.e. assuming all prior tasks succeed):

- **Local sources** for a day whose bucket exists (in local, Mega, or will be prepared). Includes suffixes that are currently local *and* suffixes that will be local after pull.
- **Remote sources** for any day with a bucket somewhere (local or Mega) — the bucket made these sources redundant.

**Where they go**:

- **Local files** → `VAULT_DATA_DIR/.trash/<table>/<year>/<file>`
- **Remote files** → `<remote-vault-root>/.trash/<table>/<year>/<file>` (via SSH `mv`)

**Collision handling** (both local and remote): never overwrites. If the target name is already taken, a numeric suffix is inserted before the extension: `20260410.local.csv.gz` → `20260410.local.1.csv.gz` → `20260410.local.2.csv.gz` → …

**Refresh before execution:** the cleanup task that ships in the summary is *predictive*; right before running it, the command re-scans local/remotes/Mega and re-derives the live list. Files that didn't actually reach Mega (because an earlier task was skipped or failed) won't be moved.

**Size check before a remote move:** when a remote source is being trashed *and* its local counterpart is on disk, the remote file's byte size is compared against the local one before the move. A mismatch means the two copies diverged (e.g. an interrupted pull) — the remote file is left in place and reported, not trashed.

**Abnormal pattern** (per remote source file we'd trash) — flags the whole cleanup task as abnormal:

> A bucket already exists for this `(table, day)` in local or Mega, AND local has at least one source for this day, AND this remote's matching source is **not** among the local copies.

The normal expectation is that sources for a day move in lockstep: either all are present locally pre-cleanup, or all have been cleaned up. This asymmetry — a bucket built without one collector's contribution, while other collectors' sources are still on disk — deserves human review before any trash move happens. Behaviour: warning printed, prompt defaults to N, skipped silently with `-y`.

**What's never touched:**

- Anything in `.trash` — the user empties it manually when satisfied.

---

## Architecture

```
src/tools/data/
  scan/            shared scanner (see DATA-STATUS.md)

  sync/
    run.ts         runSync() — entry point: find rsync temps → scan → derive → summarise → execute
    tasks.ts       deriveTasks(state) → Task[];  findRsyncTemps(localBase) → CleanRsyncTempsTask | null;  deleteLocalBucketsTask(state) → DeleteLocalBucketsTask | null
    types.ts       Task union + all task/file interfaces
    display.ts     printSummary(tasks) — bullet list; printPreview(task) — file preview
    interactive.ts runInteractive(tasks, state) — Y/n/a loop with abnormal-task guards; delete-local-buckets uses a separate per-range y/N/q loop and is never auto-run; refreshes local or full state before each task
```

**Cross-subcommand rule:** `sync/` never imports from `status/`. Shared code lives at `data/` or `data/scan/`.

---

## Execution

- **Clean rsync temps:** `fs.unlinkSync` each temp file.
- **Pull:** `rsync -az --ignore-existing <user>@<host>:<path>/<table>/<year>/<file> <local-path>` per file, sequential.
- **Back up sources:** `mega-put -c <local-source-file> <SOURCES_MEGA_RAW>/<table>/<year>/` per file, sequential. `-c` creates the destination dir if it doesn't exist. The batch is verified afterwards (see Upload verification).
- **Prepare:** spawn `data prepare <vault>` as a subprocess with inherited stdio, so its progress streams live. `-C` and `--from` are forwarded. `data prepare` discovers preparable days itself, so no path/group arguments are passed — it processes the whole vault. A non-zero exit is reported as a warning but does not abort the run; a re-run picks up anything missed.
- **Back up buckets:** `mega-put -c <local-bucket-file> <SOURCES_MEGA_VAULT>/<table>/<year>/` per file. Buckets live alongside their sources in the year dir, so no promotion step is needed. The batch is verified afterwards (see Upload verification).
- **Cleanup:** re-scan first; then for each file, `fs.renameSync` (local) or one SSH call running a shell snippet (remote). Single SSH per remote file. The remote snippet checks the source exists (exit 100 if not — distinguished from real failures), compares its byte size against the local counterpart when one is on disk (exit 101 on mismatch), then does mkdir + collision-safe `mv`.
- **Delete local buckets:** re-scan first (needs fresh Mega state); then for each confirmed range, `fs.unlinkSync` each bucket file. Never auto-run.

**Upload verification.** After each `mega-put` batch, one `mega-ls -l` is run per destination directory and the Mega-reported byte size of every uploaded file is compared against the local file. A file missing from Mega, or whose size differs, is counted as a failure — so a silent or partial upload is caught before the next run treats the file as done.

---

## Flags

| Flag | Effect |
|---|---|
| `--from <date>` | Restrict days to ≥ this date (`YYYYMMDD` or `YYYY-MM-DD`). |
| `--log [dir]` | Mirror output to `<dir>/update.log` (default `<cwd>`). |
| `-C, --concurrency <n>` | Parallel workers for `prepare`. No effect on other tasks. |
| `-y, --yes` | Auto-accept all tasks — except abnormal tasks (skipped with a warning) and `delete-local-buckets` (always skipped; must be confirmed manually). |

---

## Parallel uploads (future option)

Currently each `mega-put` blocks until the upload completes. A faster alternative for large batches:

1. Queue all files with `mega-put -q <file> <dir>` — returns immediately; mega-cmd manages parallel uploads internally.
2. Poll `mega-transfers --only-uploads --summary` until the queue drains. The summary line looks like `Transfers: 3 queued, 1 active, 12 completed` — done when active + queued = 0.
3. Run `mega-transfers --only-uploads --show-completed --output-cols=FILENAME,STATUS` to collect per-file results and detect failures.

Trade-offs vs the current sequential approach:
- **Faster** for batches of many files — mega-cmd uploads several in parallel.
- **Loses per-file progress feedback** during the run — we'd only know pass/fail after the whole batch completes.
- **More complex error recovery** — need to parse `mega-transfers` output rather than catching a process exit code.
- **Interleaves with other mega-cmd activity** — any other transfers running in the session show up in the poll.

Worth revisiting if a single backup task regularly contains more than ~10 files.

---

## Failure handling

Failed operations are reported and counted but do not abort the run. Re-running `data sync` is always safe — tasks are re-derived from the current state, so any file that failed to transfer will appear again. No explicit retry within a session. This includes upload-verification failures and remote-cleanup size mismatches — both are counted as failures and re-surface on the next run.

Interrupted rsync transfers leave `.YYYYMMDD[.suffix].csv.gz.XXXXXX` temp files in the local vault. The next run detects them and offers to remove them before pulling again.
