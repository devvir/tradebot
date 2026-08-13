# cold push

`cold push [origin] [venues…]` packs whatever a producer has finished that is not in cold storage yet, uploads it to Mega, and records where each file went. See [COLD.md](COLD.md) for the namespace, origins, and why Mega belongs to this command.

**The link is the constraint.** At a few megabits an upload is hours per tar while packing one is minutes, so this does not pack everything and then upload it — that would fill the disk with terabytes of tars waiting on a week of bandwidth. It keeps just enough packed to keep the queue fed and stops while the queue is deep enough.

Every step is resumable, because a run measured in days will be interrupted.

**A venue filter is optional and comes after the origin, never instead of it.** `cold push vault gate` confines a run to one tree's one venue; `cold push binance` is an unknown *origin* rather than a guess about which tree was meant, because the two namespaces are separate and a venue name is not evidence of a tree.

The filter reaches everything that acts — what gets planned, which stale plans are dropped, which parts are packed and uploaded, and which orphans are offered. It deliberately does **not** narrow the source scan, because the scan is what discovers which venues exist: filtering it would let the filter decide what it is filtering, and reading a tree costs nothing next to uploading one.

Two things stay unfiltered on purpose. **Recovery** resolves whatever tars an earlier run left staged, whichever venue they belong to — a stale tar ignored because this run was scoped elsewhere is worse than one verified or discarded. And the **orphan sweep** removes only what was already approved, and approval never exceeds what was listed, so scoping it again would achieve nothing.

---

## Environment

Read from `dev/tooling/.env`.

| variable | default | |
|---|---|---|
| `DATA_DIR` | — | the data root the rest hang off |
| `MEGA_ROOT` | — | where this project's trees live in Mega |
| `SOURCES_COLD_DIR` | `<DATA_DIR>/@cold` | staging tars, the locks, and `cold.sqlite` |
| `VAULT_DIR` | `<DATA_DIR>/vault` | the tree the `vault` origin backs up |
| `ARCHIVES_DIR` | `<DATA_DIR>/archives` | the tree the `archives` origin backs up |
| `COLD_QUEUE_TARGET_GB` | `10` | GB still queued before packing pauses |

**The trees are named for themselves — not for the service that fills one, and not for `cold`.** The vault is the vault whether or not stocker is deployed on this host, and it is still the vault when something other than `cold` wants it. Reusing the service's own variable looks like it keeps the two in agreement and does the reverse: that name is set in the service's module `.env`, which tooling reads only when asked for it by name, so the two agree exactly until somebody overrides the default. A host that backs up a vault built elsewhere may not have that module checked out at all, and nobody would think to edit an inactive module's configuration to make a backup run.

A default is still worth stating; where any given installation actually keeps its trees is what the variable is for, and only it knows.

**Every local path defaults under `DATA_DIR`, and every one can still be overridden.** Those two are not in tension. The default is what keeps the data root from being the same decision taken again in every path — move the data to another partition and it is one variable, not a search — while the override is there for a host that genuinely needs one tree elsewhere. Writing the root into each path would not be a default; it would be a duplicated decision.

The part cap is **hardcoded rather than configured**, because it decides the shape of what lands in cold storage and a value that drifted between runs would make the archive inconsistent for no benefit. It is 2 GB for `vault` and 5 GB for `archives` — a restore means a different thing in each tree, so the number does too. The vault is queried by symbol, so pulling one back should not mean downloading a venue-month of unrelated data; archives are restored a venue-month at a time and are not read routinely, so there is no fine-grained restore to protect and a larger part is simply fewer objects for Mega to carry.

The queue target is in the environment instead, because it depends on the link rather than on the data — a host with real bandwidth should run further ahead. It is carried in **GB from the environment to the log line**, converted to bytes only where a comparison needs them, so the number you set is the number you read.

---

## What a part is

```
local    <cold>/<origin>/<venue>/<yyyymm>.pNN.tar
remote   <MEGA_ROOT>/sources/archives/<venue>/<yyyy>/<yyyymm>.pNN.tar
         <MEGA_ROOT>/vault/<venue>/<yyyy>/<yyyymm>.pNN.tar
```

**The vault is not a source.** `sources/` holds the trees data arrives in — the venue archives, and the REST and websocket captures to come — each a record of what somebody else published. The vault is the other end: the normalised product consumers read, derived from those sources and reproducible from them. Where each origin sits is decided in code rather than configured, for the same reason the local paths are — the layout is one decision, not one per deployment.

**The name carries no meaning.** It is not derivable from the contents and the contents are not derivable from it — the database is the only thing that knows what a tar holds.

That is deliberate. It lets bin packing put twenty thin symbols in one tar and a fat one on its own, without the name having to express either. A name that *did* encode its contents would force one tar per symbol per dataset, which is exactly the failure Mega handles badly: hundreds of thousands of sub-megabyte files.

The prefix exists only so the remote tree is navigable by a human. Paths inside a tar are relative to the source root, so a restore can extract anywhere.

### Dividing a venue-month into parts

The one place the two trees genuinely differ, because a restore asks a different question of each.

**`vault` never divides a symbol.** Pulling half an instrument's month back from cold storage is not something anyone wants, so the symbol is the atom whatever it costs the bin, and files are packed first-fit-decreasing under the cap. FFD lands within about 11/9 of optimal, far past what this needs — a loose bin costs a slightly smaller tar and nothing downstream cares. A symbol whose month exceeds the cap gets a part of its own and overshoots it, which is the rule working: the cap exists to stop *unrelated* symbols being dragged along, and a symbol is never unrelated to itself.

The atom is `(market, symbol)` and **not symbol alone**. A venue may list `DOGE_USDT` as both spot and perp — different instruments, different subtrees — and 477 of 6,022 (venue, symbol) pairs are in that position. Grouping by bare symbol would fuse two instruments and distort every bin they appear in.

**`archives` holds nothing together.** An archive restore asks for a venue-month, not a symbol, and the seven venues use seven tree shapes with no level that reliably names one — `bybit/trading/BTCUSDT/…` against `okx/trades/monthly/202502/…`. Encoding each venue's hierarchy to protect a boundary nobody restores at would be a per-venue rule in a place that has managed to avoid every other one. So files are simply filled to the cap in path order, which still buys contiguity for free: a part covers a continuous range, so related files stay together whatever hierarchy a venue happens to use. A file larger than the cap gets a part to itself rather than being split.

Both sort deterministically, so a re-run produces the same parts and an interrupted plan can be resumed rather than re-derived.

---

## The record

```
part    id, origin, venue, month, seq, name, remote, local,
        bytes, files, planned_at, uploaded_at, handle
member  part_id, path, bytes, mtime,
        venue, month, market, symbol, dataset, variant
month   origin, venue, month, closed_at
superseded  remote, path, bytes, mtime, recorded_at
```

`member` is at **file** grain, with whatever the path could be made to say alongside it, so "which parts hold this symbol's history" is an index lookup rather than a scan that parses filenames.

**`venue` and `month` are all that is ever known.** They are what the tars are organised by, so every origin yields them. The rest is the vault's hive partitioning, which the raw archives simply do not have — rather than invent a symbol level per venue, archives leave them null and let the path stand for itself.

`variant` holds the vault's extra path levels verbatim — `interval=1m` for klines, empty for most, whatever an order-book series eventually declares. Keeping the raw `key=value` text means a new kind of extra costs no schema change and no branch. It comes from the **path**, not the filename: a filename gives the extras positionally as bare values (`…AAVE-USDT.4h.202603.parquet` says `4h` without saying it is an interval) while the path names them.

`handle` is Mega's own identifier for the stored object (`H:7BtQjCAL`), recorded after upload. It identifies the file independently of its path, which a size cannot, so a later consistency check can prove the database and Mega still agree on *which* object a row describes.

**The scheduler is a query.** What to pack is the source scan minus what `member` already covers — the same operation whether this is a first pack, a month collected since, a dataset nobody was collecting before, or a re-run after a crash. There is no branch for any of those cases.

A file whose size or mtime has changed counts as not covered, so a partition its producer has rebuilt is packed again rather than assumed backed up on the strength of a tar holding its previous contents.

### The month gate

`month` is what `archives` consults before walking anything, and the vault writes no rows in it at all.

**It is a gate, not a record of what is packed.** `member` remains the authority on what is in cold storage; a `month` row only says that a venue-month has been examined against a given closing. A month whose closing has not moved since is skipped without being walked; one the collector re-closes carries a different time, is walked again, and contributes only the files that are genuinely new — appended as further parts rather than repacked.

It exists because the alternative does not scale. The vault rebuilds its whole path map every run, which is fine at 190,000 partitions; the archives hold 4.9 million files today and are expected to grow by tens of terabytes, and rebuilding that map every run to discover that nothing closed months ago has changed is work with a known answer.

A row is written **last**, after every part of the month is recorded, so a crash part-way through leaves the gate open rather than closed over a month that was only half planned. And when an unpacked plan is discarded, its month row goes with it — otherwise the month would be remembered as examined, having just had the result of that examination thrown away, and would never be looked at again.

### What makes an archive month a candidate

The producer's own signal, and nothing inferred: a venue-month is a candidate once trucker has published it as collected through, as `topic=archives, fact=complete` in the facts store.

**The tip is the unbroken run of closed months, not the highest one.** A month that fails part-way through collection is left open while the months after it go on closing, so the closings are not necessarily a range. Reading the maximum as the tip vouches for every month beneath it including the hole — bybit's read 202501 over open 202402 and 202405, and stocker built 2,091 partitions from two months that were never finished. Stopping at the break costs the closed months above it until the hole is filled, and filling it releases all of them at once.

**Not because a later file could not be handled.** The record is at file grain and a month can be appended to at any time, so correctness does not need the month closed. Packing an open month would simply produce a stream of tiny parts, one per collection pass, for ever.

Nothing here knows what a dataset is, which symbols exist, or how any venue organises its tree. A file's month is read off its path in one of four forms, and a path carrying no date is skipped and counted rather than filed under a guess. A directory named for a period after the tip is skipped whole — several venues put the month or day in a directory, and that is where the bulk of a busy archive sits.

### What makes a vault month a candidate

The same principle, from the producer that owns the vault: **a venue-month is packed only when every partition stocker says it built for that month is either on disk or already in cold storage.** Otherwise the month is dropped from the plan and reported.

**The files present say which partitions are here, never whether that is all of them.** Packing whatever is on disk records a fragment as a finished month, and the record then reads as coverage that does not exist. Most of bybit's vault was parked on another disk while the real one was full, and 45 months went into cold storage from the remains — one of them holding a single partition of the 133 stocker had built. Nothing in cold storage could have noticed: it packed exactly what it found, which is all it was ever asked to do.

**On disk *or* in cold storage**, because those are two different reasons a partition is absent and only one is a hole. A partition [`cold evict vault`](COLD-EVICT.md) reclaimed is gone deliberately and cold storage has it, so it must not block the month it belongs to.

**There is no override.** An incomplete month is not a formality to wave through — it means partitions stocker built are missing and nothing anywhere has them. A flag to pack anyway would turn the one signal that surfaces that into a prompt people learn to answer.

A venue nothing has been said about is left alone rather than refused. An absent record is not evidence of a missing partition, and blocking on it would stop a venue nobody has a record for from ever being backed up.

**A run that withheld months does not close by saying everything is backed up.** The count crosses back out of the planner for that one reason: `Everything from bybit is in cold storage` printed three lines under a refusal would undo the refusal, and it is the last line anybody reads.

```
⚠ 33 months not packed — 20,191 partitions stocker built are neither on disk nor in cold storage
      bybit      33 months · 20,191 partitions missing · worst 202110 (132 of 133)
      Restore what is missing and run again; nothing is packed until a month is whole.
ℹ Nothing to push — 33 months withheld above, and nothing else is outstanding
```

Grouped by venue with the worst month named, because one month short is a partition that has not landed yet and forty months short is a disk that went missing — and only the aggregate and the ratio tell those apart.

The gate asks the facts store, not stocker's files — one query per venue for `topic=vault, fact=built`, with the partition id rebuilt from the columns it is filed under.

**That closed a hole rather than moving one.** Parsing the flat file took the id with a regex assuming `"id":"` with no space after the colon, and 4,480 lines of `klines.bitget.jsonl` were written by a repair using `json.dumps` defaults, which puts one there. The gate saw 16,531 bitget partitions where the file holds 20,964, so a bitget month missing any of those 4,433 passed as whole. Verified across all six venues after the move: identical counts everywhere else, 4,433 recovered on bitget, and **nothing that was in the files is missing from the facts**.

---

## The venue filter reaches the scan

`push <origin> <venues…>` narrows the run, and the narrowing happens **inside the planner** rather than to whatever it returns. Filtering afterwards is too late twice over: the venue has already been walked — millions of directory entries for a result that is then discarded — and the planner has already reported on it. `push vault bitget okx` warned at length about bybit's incomplete months, which are neither news nor anything that run could act on.

The vault still walks its whole tree, since `venue=` is the top level today and may not be tomorrow, and the walk is cheap next to the per-file comparison and the gate's queries that the filter skips. The archives skip a venue before walking it at all, which is the slowest thing this command does.

## It answers Ctrl-C

Node delivers a signal through the event loop, so no handler can run while a synchronous stretch holds the stack — and scanning one archive venue is millions of directory entries with no natural await anywhere in it. The signal is not lost; it is queued behind work that has to finish first, which reads exactly like a command ignoring you. A `^C^C^C` sat there while four more venues scrolled past.

So the walk hands the loop back every few thousand entries. A tick costs microseconds against the directory reads it sits between, and Ctrl-C lands in milliseconds instead of after the scan.

---

## How a run proceeds

1. **List Mega once.** One recursive listing per origin, before anything is decided — a few hundred objects with their sizes and handles in a single call. Both guards below need to know what is already there, and asking per part would be hundreds of round trips for a question one listing answers.
2. **Lock.** One push per origin — `cold.<origin>.push.lock`. What two pushes would collide over is a tree and the tars staged from it, and none of that crosses origins; the upload queue is shared and is meant to be. An `evict` over the same origin takes its own lock and runs alongside, the files being disjoint by construction. A lock whose recorded pid is no longer running is cleared without asking — a `SIGKILL`, a lost terminal or a machine going down all leave one behind, and putting that to a person only teaches them to say yes. A lock somebody *is* holding still asks.
3. **Sweep.** Every `.tar.tmp` is deleted unconditionally. It exists only because a rename did not happen, so there is nothing to weigh up.
4. **Expire plans** that were never acted on — see below.
5. **Scan and plan.** The origin's planner says which venue-months hold files that are not backed up; everything after that is shared. Rows are written **before** the tar exists.
6. **Confirm**, showing parts, bytes and venues.
7. **Recover**, settling every tar an earlier run left.
8. **Pack, queue, settle**, one part at a time, paced by the two backlogs.

### A plan is kept only if it already cost something

A plan describes the tree as it was when it was made, and files move between disks, get rebuilt by their producer, or go away. A tar built from a stale list either fails on a path that is no longer there or captures something the row does not describe.

So rather than working out which plans drifted, **every part that has not been packed is discarded and planned again from what is on disk now.** What survives is what already cost something: a part whose tar exists — queued or not, it makes no difference — or one already uploaded. Planning is cheap next to uploading; the scan happens either way and the rest is a hash-map diff and a sort.

This is what makes the database self-healing. Deleting `cold.sqlite` recreates the schema on the next run; leaving it lets the expired plans clear themselves.

### Recovery walks the directory, not the plans

A tar on disk is a fact. The row that ought to describe it may be missing, may belong to a plan since dropped, or may already claim the part is in cold storage — so recovery starts from what is there and asks the database about it, rather than the other way round.

**Iterating plans instead leaves anything the plans do not mention permanently invisible**, and because the staged total is measured from the directory, an invisible tar counts against the buffer for ever and eventually pauses the run for good. That is not hypothetical: five tars marked uploaded but never deleted held 6.4 GB that nothing could have reclaimed.

Every tar leaves recovery sent, gone, or already travelling:

| recorded | in Mega | outcome |
|---|---|---|
| — | in the queue | already on its way: left alone |
| uploaded | yes | local copy reclaimed |
| uploaded | no | the claim was wrong: retracted, verified, queued |
| outstanding | yes | recorded, local copy reclaimed |
| outstanding | no | verified, then queued |
| nothing at all | — | orphan: nothing can say what is in it, so deleted |

**The queue is asked before Mega, because that is the direction a transfer travels.** Asking Mega first leaves a window: a tar still uploading is absent from Mega, and by the time the queue is read it has finished and left — so both answers are "no" and it is sent a second time.

**A tar left travelling is still owed a confirmation**, and gets it from the capacity check rather than here — the transfer it is waiting on outlives recovery by hours, and resolving it in place would mean waiting out an upload before packing anything at all.

### Replacing what Mega already holds

**Overwriting is deleting and adding in one step**, so it carries the risk of a delete: if the new tar lacks anything the old one had, that data leaves cold storage. Part names are deterministic from `(venue, month, seq)` and a sequence restarts once a venue-month has no parts left, so a replanned part landing on an existing object is ordinary rather than exotic.

The decision is made from the **data**, not the record — the record says what was packed, never what was removed afterwards.

| Mega at that path | | |
|---|---|---|
| nothing | not an overwrite | uploads, silently |
| every old member present and unchanged | an update that only adds | says so, proceeds |
| a member removed or changed | data would leave cold storage | names them, prompts, default no |
| an object nothing describes | unknowable | prompts |

The first row is what lets a bad object be repaired by hand: delete it in Mega and the next run simply rebuilds it, with nothing to warn about.

**Membership decides it, not size.** A smaller tar is not evidence of loss and a larger one is not evidence of safety — files get repacked, compressed differently, redistributed between bins. And "unsafe" means *asked*, not refused: accepting a removal is a legitimate answer, after which a smaller tar correctly replaces a bigger one.

A part whose replacement is declined keeps its tar and its plan, and the run reports it rather than finishing as though everything went out.

### New tars append; updated tars go back over their own names

A month's pending files are one of two things, and recording them the same way is what puts three copies of one partition in cold storage.

**New** — no pending path is a member of any part of that month. The tar holds nothing another tar holds, so it appends as the next `pNN` and every object already in Mega stays exactly as it is.

**An update** — some pending path is already packed, because the producer rewrote a partition under the same path. Appending there would leave the old copy beside the new one forever, which is how one partition came to sit in three tars of three different sizes with nothing saying which was current. So the month is **replanned whole**: every member it holds, restated from disk, plus the pending files, packed into `p01…pN` and written back over the names it already occupies. Mega replaces rather than accumulates.

**The comparison is month-wide, and it has to be.** Bin packing puts a symbol wherever it fits, so which tar holds a member is an accident of the last plan — repack and a symbol moves from `p01` to `p02` having lost nothing at all. Asking "does `p01` still hold what `p01` held" reports every such move as a loss. The question worth asking is whether the *month* still holds everything the month held, and it is asked once, when the plan is made.

That is why a replanned part carries a flag: the per-part guard above must not ask again on something already judged, or the answer becomes a prompt people learn to accept without reading.

A member cold storage holds that disk no longer has cannot be repacked. It is the one case that stops — it would drop silently out of the new tars while the old tars holding it are overwritten, which is cold storage losing data *by being updated*. It is named and asked about, and declining leaves the month untouched.

### Orphans, and the only thing here that is deleted

A month that replans into fewer parts leaves its highest-numbered objects behind, holding members that now live in the other tars. Overwriting cannot reach them; they have to go.

Nothing is deleted while it might still be the only copy, and two locks say so: an orphan goes only once it has been **approved**, and only once its own month has **no unsent part**. A run interrupted between the two leaves both copies standing rather than neither.

**Permission is asked for at the start, not earned at the end.** An orphan becomes removable when its replacements land, which on a backfill is weeks away — so asking at that moment is asking nobody, since the point of a long run is that it is left alone. Instead every recorded orphan is listed before any packing begins and settled in one prompt, default no. The deletions then happen unattended, each month's as soon as its own replacements are confirmed, rather than at the end of a run that may have days left in it.

Declining means *not yet*, never *never*: the objects stay and the next run asks again.

The condition is about **state**, not about an event a run happened to witness — "does this month still have an unsent part". So parts that landed while the tool was not running count exactly the same, and starting a run is enough to tidy up everything already complete.

### Descriptions of what is about to be replaced

A plan is discarded the moment its tar is missing, which is right — and it takes with it the only record of what Mega holds at that path. Without that list the comparison above is impossible, and the replacement becomes a blind commitment.

So **before a plan is dropped, if Mega holds its object, its member list is copied to `superseded`**, keyed by the remote path. In the database rather than for the run: an interruption between the drop and the upload would otherwise leave the object with nothing describing it, which is the failure the whole mechanism exists to prevent.

**The table is keyed by object and nothing else, so every reader scopes itself to its own origin's remote root.** A run holds a listing of its own tree only, so another origin's rows read as objects Mega does not have — and settling them on that basis is how a vault run came to forget, every time, what every archives object was known to hold. A remote path is built from `megaRoot`, so the prefix separates them exactly.

They are removed as soon as they stop mattering. Ordinarily that is when the replacement is confirmed. But a run stopped mid-upload never sees its own success — Mega completes the transfer while nothing is watching — so **every start settles the ones left over**, deciding from the size Mega reports, since a member list predicts a tar's bytes exactly:

| Mega reports | |
|---|---|
| nothing at the path | the object is gone; forget it |
| the size the old description implies | the replacement never landed; keep it and offer the part again |
| anything else | the replacement landed, or something else did; forget it and say so |

### What verification proves

A tar is checked two ways before it is trusted: its member list must match the plan exactly, and `tar -d` must find no difference against the source tree.

**Both are needed.** `tar -d` compares what is *in* the tar, so it catches a member deleted, moved or rewritten since packing — but says nothing about a member the plan lists and the tar never had. That file is not examined, the diff passes, and the part uploads while the database records a file that is not inside it. Nothing later notices, because the path is in `member` and no future run considers it unpacked. Part names are deterministic, so a leftover tar is adopted by whichever plan lands on its name — and a venue-month that has gained a partition since produces a plan wider than the tar sitting there.

A tar that fails either check is deleted rather than skipped. It is valid or it is gone; keeping a doubtful one invites it being uploaded later by something that did not look.

**One part failing does not end the run.** It is left going overnight against days of uploading, and the producer is writing to the same tree meanwhile. The part keeps its plan and comes round on the next run.

---

## Pacing

```
queued = TOTAL - UPLOADED          (mega-transfers --summary --only-uploads)
staged = bytes of .tar under <cold>/<origin>/

if queued < COLD_QUEUE_TARGET_GB and staged < COLD_QUEUE_TARGET_GB:
    take the next part
else:
    wait and ask again
```

**Two backlogs, and either one full is a reason to stop.** What Mega still has to send says whether the link is busy; what is staged on disk says whether the buffer is full. They are not the same number — a tar Mega has finished is still on disk until the next confirmation removes it, and a queue shared with another origin can be deep while nothing of ours is staged.

**There is no warming phase.** Filling the buffer and finding it already full are the same question, so the check runs before *every* part rather than only before one that needs packing — otherwise a run resuming onto a pile of packed tars sails past both limits without asking.

**What fills the buffer and what drains it are the same set.** The staged total comes from the directory, which holds every venue's tars whatever this run was scoped to. Confirming an upload is what removes one, so the check confirms from the *directory* too, and not only from the parts this run set out to send — those are narrower twice over, being filtered to the venues asked for and excluding anything already recorded as backed up.

Getting that wrong deadlocks a run, and did: `cold push vault kucoin` found seven binance tars an earlier run had left in flight, reported them as already on their way, and carried on. Their uploads finished, no kucoin part described them, and they held 11.7 GB against a 10 GB target — nothing queued, nothing packing, and only a restart able to clear it.

`mega-put -q` hands a tar to Mega's queue and returns, so **Mega is the uploader** and there is no second loop here. `TOTAL` is the queue as it stands — active plus waiting, with finished transfers already gone — so the difference is what remains.

**The summary is global on purpose.** There is one link and one FIFO queue, so a trucker backup running beside this one, or an upload started by hand, is genuinely in front of the next tar. Filtering to our own transfers would make the packer build tars that then sit on disk for days. `--summary` also sidesteps the per-transfer listing's default of showing only the first ten rows, which would quietly undercount a long queue.

Because a tar stops counting as *waiting* the moment Mega picks it up, a single very large symbol cannot stall packing: the packer runs ahead behind it for as long as it uploads.

An upload is confirmed from Mega's own listing rather than from an exit code — the file is published only once it is whole, so its presence at the right size is the proof.

---

## What it shows while it runs

A fixed block at the foot of the terminal, with the log scrolling above it. One bar, because Mega sends one file at a time.

```
[12/407] Packing 201805.p02.tar · 1.5GB · 1113 files
↑ 201805.p01.tar  ████████░░░░░░░░░░░░░░░░  24.9% of 2.0GB
  12/407 parts sent  ·  5.4GB queued  ·  packing 201805.p02.tar
```

**It polls rather than being driven by the loop.** Packing a two-gigabyte tar is minutes inside a single `await` while the upload advances the whole time, so a block that only redrew when the loop said something would sit frozen through both. On a non-TTY the block cannot hold still, so the same facts are logged every half minute instead, which keeps a redirected run readable and greppable.

## Interrupting it

Ctrl-C is safe at any point and exits 130. The lock and the database handle are both released on the signal path, not only in a `finally` — `process.exit` inside a handler skips every pending `finally`, so anything relying on one would simply not run.

What the next run finds depends on where it stopped, and the state table above says what each case resumes to. Nothing is left half-done: a tar is either complete and renamed or a `.tmp` that gets deleted, and a plan that never became a tar is discarded rather than trusted.

---

## What it does not do

**It does not delete partitions.** It removes a tar once Mega confirms it, and nothing else. Reclaiming the source tree is [`cold evict`](COLD-EVICT.md), and stays separate.

**It cannot restore.** That is the gap below.

---

## Known issue: a rebuilt month whose other members were evicted

A month is replanned whole whenever a pending file's path is already packed — the producer rewrote a partition in place, so the new tars must be written back over the names Mega already holds rather than added beside them. Replanning restates every member of that month from disk, and a member that was evicted is not there to restate.

Push **refuses** the month, names the files, and moves on. It does not offer to proceed: agreeing would write tars without those files over the tars that have them, which is cold storage losing data by being updated, and the operator cannot make the alternative true from a prompt.

What the month actually needs is its evicted members pulled back from Mega before it is repacked. **`cold pull` does not exist yet**, so today the way out is a manual restore of that venue-month followed by another push. Until it does, this is the one situation where eviction has a cost that is not just a download away.

It is narrow by construction. A **new dataset** in an already-evicted month is all-new paths, so it appends as the next part and never triggers a replan — only an **in-place rebuild** collides. The vault is where it can happen at all, since the archives are never rewritten.
