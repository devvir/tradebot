# Prospector: jobs and passes

How prospector holds a pass: the job and its run rows, resuming, when a job closes, how a venue is
scheduled, enrolled and paused, how the probe settles the backlog, what ends a key, and how
"established" is answered. What a pass is, and the two kinds of it, is
[PROSPECTOR.md](PROSPECTOR.md#how-a-pass-works); how a walk pages its scopes is
[PROSPECTOR-WALK.md](PROSPECTOR-WALK.md), and how an update generates its keys is
[PROSPECTOR-SERIES.md](PROSPECTOR-SERIES.md#generation-which-keys-an-update-asks-about).

## Jobs

One pass over one of a venue's hosts is a **job**, and it is the only unit here. A job is a row at
the empty scope plus one row per scope, written together:

```sql
run(venue_id, kind, scope, cursor, requests, found, started, completed, asked, sent)
```

`kind` is `walk` for a listing pass and `update` for a generated one. Probing keeps no run rows:
`wip` is its work list. The kinds keep separate rows because a job is opened and resumed per kind
(`openJob`, `openPartitions`), and an update's scopes say nothing about the keyspace a walk covers.

**A job belongs to one host.** `run` rows are keyed by the `venue` row, which is a server, so bybit's
two hosts keep two jobs for one pass over the venue. VOCABULARY's [run](../VOCABULARY.md#archives),
one pass over a venue across its hosts, is those jobs together; the `run` table holds their rows.

**A host has at most one open job of each kind**, and a scope at most one open row: `run_open` is a
unique index over the rows not yet completed. Ordinarily only one job is open on a host at all; an
update forced over an unfinished walk (see [Surveying](PROSPECTOR.md#surveying)) leaves both open, and
what goes out from then on is counted to the update.

**`requests` counts pages; `asked` and `sent` count requests.** A page is a listing page on a walk
and a thousand generated keys on an update, so `requests` measures progress and says nothing about
what the venue saw.

`asked` is one per request the job needs — a key to probe, a page to list, a directory to map —
counted once however many attempts it then takes. `sent` is what actually went out for them, every
retry included. **Two numbers because only the first is a property of this service:** what a walk
costs against what an update costs is `asked`, which a bad link on the day cannot move, while what a
pass cost the venue that day is `sent`, and the gap between them is how much of it the network wasted.

Both are held per host, counted in `send`, which every archive request passes, and written onto that
host's newest open job by whatever is already writing a run: a page of a sweep, a batch of probes,
the end of a pass however it ended, and shutdown. Nothing schedules a write of its own.

A count with no open job waits for the next one, which is where the requests that map an archive
belong: they are sent before the walk they plan has a row. What an HTTP handler sends to confirm one
key goes the same way, onto whatever job is open next. **Instrument listings are not counted at all**
— they go to a venue's API rather than its archive
([PROSPECTOR-TRANSPORT.md](PROSPECTOR-TRANSPORT.md#asking-a-venue-about-itself)), and they are a
handful of requests a pass.

**A first pass is not a special case.** It is a job with no predecessor: same rows, same walk, same
code. The only decision anywhere is whether to build a new set of scopes or continue the open
one:

```
asked to survey
  a job is open?   →  walk the scopes it still has open
  no job open?     →  map the archive, open a job over it, walk it
  refresh: true?   →  drop the run rows first, so the second line applies
```

Nothing below that line asks which kind of survey it is in, because nothing needs to. **Nothing above
it consults a clock either** — see [scheduling](#scheduling-nothing-starts-unasked-and-nothing-stops-on-its-own).

### Scopes are read, not re-derived

The work list is `SELECT … FROM run WHERE completed IS NULL` — the scopes that still have
keyspace nobody has read. A scope leaves that list by being walked to exhaustion, so resuming
needs no record of what an earlier attempt managed and no filter over what descent produced.

The set is committed **in one transaction with the job row**. That atomicity is what makes the rows
safe to treat as the work list: a half-written set would look exactly like a finished one, and the
scopes never written would be skipped in silence.

**A resumed job does not re-map the archive**, so a directory that appeared after the job began
waits for the next job. That costs nothing. The guarantee is only *present when the job started and
still there when it finished*, and something that appeared midway was never inside it.

Every row in a job shares one `started`, so a scope walked hours later still claims the archive
as it was when the job began — the conservative direction, and the one the cascade wants. A job
begun on Monday and finished on Friday is a Monday snapshot; dating it Friday would claim four days
it never looked at.

### A job closes only when every scope did

A scope that cannot be walked keeps its row and its cursor, and the job **stays open**. That is
not bookkeeping fussiness: the job sits at the empty scope, which is every prefix's first ancestor,
so closing it around a failure would answer "established" for the whole venue — including the
prefix nobody has read.

**A page that fails is asked again where it is, before its scope is given up on.** What fails a
page is nearly always what would fail any other at that moment — the link, the venue, a write that
could not get its turn — so moving on to another prefix gains nothing and leaves this one half read.
The page is read again from the same cursor, up to twelve times, after a wait that doubles from two
seconds to a minute: about seven minutes in all. A refusal is the venue's answer and is not
repeated, and neither is a page the venue answered by standing us down. Nothing of a page counts
until its cursor is written, so asking again costs one request.

Only a page that outlasts that fails its scope, and the job stays open over it. The next turn of
the loop finds a job to resume and takes up exactly the scopes that failed, half a minute later,
**for as long as the service runs**. Nothing counts passes and nothing gives up.

That is safe because there is no per-scope failure that stays failed. A prefix that no longer
exists answers `200` with an empty listing — a successful walk of an empty scope, not an error. A
given page is a fixed URL, so it cannot deterministically fail while its neighbours succeed. What is
left is transient (a 5xx, a 429, a reaped connection), venue-wide (a bucket whose policy changed,
which fails descent first), or local — and every one of those is cured by asking again later.

Resuming is also cheap, because it does not re-map: one listing request per remaining scope.

**A pass that ends with scopes still open says how many failed, and names none of them**: each
was said as it happened, kept its cursor, and is resumed. A scope that is open with no failure
to explain it — stopped to be split and never queued again — is named, since nothing else would say
so.

### A pass that probes closes when its drain does

A job closes when its pass is over, and every scope finishing is not the end of a pass that
probes.

**A walk over a venue that states everything in its listing ends there**: the keyspace has been read,
the bounds are on disk, and that closed job is what `phaseOf` and `establishedAt` read.

**Every other pass leaves it open, and that is the whole of resuming one.** Every scope finishing
means *generation* is done — the keys are in `wip` and mostly unasked, and probing them is where the
hours go: on htx, generation finishes with some 185,000 keys still queued. A job closed at that
moment would leave a restart during the drain nothing open, so it would plan the pass again and
discard the per-series record of every series already generated.

That is equally true of a **walk** on a venue whose listing cannot state a size or an etag, which
parks those keys for a probe exactly as an update does. Closed at the end of listing, such a venue
would report itself *waiting* with its whole backlog outstanding, schedule its next pass from a pass
that has not finished, and lose the drain entirely on a restart, with nothing in the catalog saying
the work was owed.

So the condition is whether the pass probes, never which kind it is: `surveyVenue` closes a walk only
where nothing will probe, and otherwise the drain returning is what closes it — `closeWalk` for a
walk, `clearUpdate` for an update. On an update the shape is:

| | |
|---|---|
| **a row per series, written when the pass is planned** | closed as that series' keys are written |
| **rows existing at all** | the last pass did not reach reconciliation |
| **`wip`** | the whole of probing's progress; nothing else records it |
| **reconciliation's last act** | delete the per-series rows, close the job row |

Resuming therefore means: no preamble, no re-planning, and every series the interrupted pass had not
reached still generated — once per series, not zero, not twice. Probing needs no equivalent because a
key is on the list until it is answered, so a restart picks up exactly what is left, `tries` intact.

**A resume is a resume, whatever its age.** Nothing decides that an interrupted pass has been sitting
too long. An open job with nothing working it is what a killed container leaves and what a pause
leaves, and both continue from their cursors — stopped at 3am and restarted a fortnight later resumes
exactly as one restarted at 8pm does. Judging a paused walk stale is a person's call, and `refresh`
is how they make it; code guessing at it would restart a multi-day walk because a deployment sat idle
over a weekend, the expensive outcome chosen by nobody. Scopes planned against tips that have moved
since cost one pass of a narrower range, and the next pass widens it; discarding the pass costs
everything it had already read.

**`run` is a progress table, not a log.** A finished htx pass leaves **one row, not 39,296**: the job
row, closed, carrying the pass's start, end and totals. It cannot be mistaken for outstanding work,
because progress is read from the scopes' rows.

### Generated keyspace is scopes and cursors too

Nothing is fetched to produce an update's keys, or a constructed-key venue's — they come out of
arithmetic over the bounds. That is an implementation detail and **must not leak into how the survey
is structured**: the same scopes, the same `run` rows, the same cursors committed page by page, the
same job that stays open until every scope is exhausted. A generator that ignored all that would still
produce the right URLs and would lose everything the run table is for.

The reason is the cost asymmetry between the two kinds of listing, which is easy to state and easy to
forget:

- **A listing that carries metadata.** Size, ETag and last-modified arrive with every key, so
  re-walking a prefix is a no-op for every file that has not changed — `putFiles` compares and writes
  nothing. A refresh is cheap by construction.
- **Keys that carry nothing.** Every key emitted is a candidate, and every candidate that is not
  already settled lands in `wip` for the probe to ask about. A file already catalogued is not
  disturbed — a bare sighting writes nothing — but everything else means a `HEAD`, and there are
  millions of them.

So **a refresh is hours of probing and a resume must never become one**. What keeps them apart is
exactly the run table: a resume reads the open scopes and continues from their cursors, so it
emits only what is ahead of them and re-parks nothing. Regenerating the whole keyspace "because it is
cheap to generate" would be true about the generation and catastrophic about what follows it.

**A scanner that does no I/O must hand the event loop back.** A listing scanner yields as a side
effect of awaiting a socket; a generating one is pure arithmetic behind an `async` signature, so
awaiting its pages resolves on the microtask queue and the process never reaches its I/O phase. Left
alone, one venue holds everything: its own log lines are produced and never flushed, and every other
venue's sockets go unserviced — a service running flat out that is indistinguishable from a wedged
one. The walk yields between pages for exactly this reason, at a cost of one turn per thousand keys.

## Scheduling: nothing starts unasked, and nothing stops on its own

A survey begins when something asks for one, over [the API](PROSPECTOR.md#surveying). From then on
that venue **keeps itself current** — across any number of restarts — until it is paused or refreshed:

```
[ backfill ] → sleep → update → sleep → update → … → walk on a scheduled day → sleep → update → …
```

**A venue is never finished, only current.** The archives grow every day, so reaching the end of one
is not a state to stop in — it is the point at which the cheap half becomes possible. The first pass
is a walk where there is a keyspace to read and an update where there is not; every pass after it is
an update, except where the walk schedule makes it a walk. `passFor` decides (see
[PROSPECTOR.md](PROSPECTOR.md#a-scanner-is-handed-a-context-never-an-adapter)); nothing else chooses.

**A day between passes, measured from the start of the last one.** Every venue here publishes at
most one file per series per day, so asking more often is asking the same question twice. Measuring
from the start rather than the end is what stops a venue whose pass runs longer than a day drifting a
day later on every turn: a pass that took thirty hours goes straight round again.

**The start is read from the pass's own run row, never from a clock**, because a pass this process
*resumed* began before this process did; timed from the moment it was picked up, a restart would
change the venue's cadence. A walk and an update alike leave their `scope = ''` row behind, closed,
which reconciliation deliberately keeps — and it is the same field `dueFor` reads when a venue is
picked up on startup, so the two paths cannot disagree.

**Two different questions, and only one of them is ours.** *Whether* a venue should be surveyed at
all depends on what somebody is waiting for and what the disk can take, neither of which is visible
from in here — so it is asked for over the API. *How often a venue already being surveyed needs
re-reading* is not that question: the archives move once a day, so the answer is a day, and it is not
worth asking anybody.

### When an update is a walk

**Probing finds no shape that did not exist before** (see [where series come
from](PROSPECTOR-SERIES.md#where-series-come-from)), so every venue that can be listed has to be
walked now and then, and a walk of a large one is days on a slow link. How often that can be afforded
is a fact about where this runs, so it is set per deployment, in `src/walk-schedule.yaml` — a file that
is not versioned and need not exist (`walk-schedule.example.yaml` beside it shows the form):

```yaml
binance: 15        # walks on the 15th of each month
kucoin: 1,10,20    # on the 1st, the 10th and the 20th
gate:              # never walks for an update
```

- **A venue the file does not name walks once a month, on the day that is its own number**: the
  lowest id its servers have in the `venue` table, wrapped to a day from 1 to 30. Nobody chose, so no
  two venues walk the same night.
- **Only a venue that can be listed may be named.** One that cannot is never walked.
- **Days run from 1 to 30**, since that is what every month but February has; a month without the day
  is passed over.

**A walk runs when it is due, not on its day**, because this service can be down for days. At each
update the question is whether a scheduled day has come round since the last walk began: the update
is a walk where the last walk began before the newest scheduled day that is today or earlier (UTC),
and more than 24 hours ago. So a day missed is made up at the next update, a day is walked once, and
a walk that began the evening before its day is not repeated at midnight.

**The file is read once, at startup, and has to be right.** A venue that does not exist or cannot be
listed, a day that is not a whole number from 1 to 30, a line that is not `venue: days`, a venue
named twice: any of these is logged as `The walk schedule cannot be used — fix it or remove it;
stopping`, naming the line or the venue, and the service exits with status 78 (`EX_CONFIG`, a
configuration error) before it surveys anything. A supervisor that restarts failed services starts
it again into the same refusal, logged at every start, until the file is fixed or removed. What is in
force is logged as `Walk schedule in force`.

### Enrolment, and what a restart means

**A venue is surveyed because somebody asked once, and that is recorded rather than inferred.** The
`survey` table holds one row per venue — `enrolled_at`, and `paused_at` which is null while it runs.
Keyed by **name**, not `venue.id`: a venue is what a person starts and pauses, while `venue` has a
row per host, so keying on the id would enrol bybit's books separately from its trades. No foreign
key for the same reason — `venue` is unique on `(name, host)`, so there is no single row to point at.

| | |
|---|---|
| **no row** | nobody has ever asked. Nothing runs, ever |
| **row, `paused_at` null** | enrolled. Walking, updating or waiting — the run rows say which |
| **row, `paused_at` set** | enrolled and stopped, and it stays stopped, including across a restart |

**A pause flag rather than a state, because absence already carries the third case.** Whether a venue
is walking, updating or waiting is the run rows' business, and a second copy here would be free to
disagree with them.

So **a restart picks up what was already running and asks nothing new**. For each enrolled venue —
`PROSPECTOR_VENUES` still applying — an open job resumes at once from its cursors, a venue between
passes waits out the remainder of its day, and a paused one stays paused. A venue nobody enrolled is
untouched for ever, which makes **read-only a real state** rather than a convention: a deployment
that collects nothing is one where nobody started a survey.

**Resumption is per host, because the passes are.** Bybit's two servers keep separate run rows and
separate cursors, and one being mid-walk says nothing about the other — so each is picked up from its
own state, and a venue with one host walking and one waiting is exactly that.

**A restart cannot change a venue's cadence**, because the interval runs from the start of a pass
(see [above](#scheduling-nothing-starts-unasked-and-nothing-stops-on-its-own)). A venue updated an
hour before its container was replaced is not owed another update. Completing a walk is the end of a
pass, not a prelude to a special first update: the next is due a day after the walk began, which for
a walk that ran longer than a day means immediately.

**Unprobed files are outstanding work, and belong to no job.** A probe's subjects are rows rather
than keyspace, so they outlive the walk that discovered them: bybit's books carry no metadata in
their index, and a completed walk leaves hundreds of thousands of names still owed. That is why a
venue counts as busy until its probe drains, and why `GET /status` reports `wip` beside the job.

**A restart loses nothing, and starts only what was already going.** Whether anything is
*currently* walking a venue is a different question from whether work is outstanding, and
`GET /status` answers both — `state` for where the venue stands, `surveying` for whether this process
has a loop alive. Open and not surveying is what a killed container leaves behind between one start
and the next, and the one state worth acting on.

### A pause is not a cancellation

**And there is no resume verb to go with it.** The flag is read between pages, so the page in flight
is committed, every scope keeps its cursor and the job stays open — the state a killed container
leaves behind, reached deliberately. A request waiting on the venue — a retry's backoff, or a wait the
venue asked for — stops waiting within a quarter of a second and is left owed. Starting a paused venue
therefore *is* resuming it, and puts it back to what the pause interrupted: walking on from its
cursors if it was stopped mid-pass, waiting if it was waiting. A venue paused while it waited is not
owed an update for having been paused.

**The probe stops on the same flag, and reads it where it has a boundary of its own.** Its unit is
the batch, not the pass: a pass ends when the backlog empties, which on a venue whose keys are
constructed is a week's work, so a flag read once per pass is one that lands long after anybody cares.
It is therefore read each time a batch of `wip` rows is loaded — after the previous batch has settled
what it settled, recorded its attempts and moved the cursor, and before the next is asked for. What
that costs is the seconds one batch takes; what it buys is that nothing is cancelled mid-flight and no
row is asked twice. The pass says `stopped` rather than leaving the drain to infer it from counts,
which is the same reason it says `abandoned` — the two end in the same place and mean opposite things
about whether the venue should start itself again.

**The pause is written down before the loop is touched**, because it has to outlive the process: a
deployment that resumes what it finds open would otherwise restart a venue somebody had deliberately
halted. Two separate things: the row in `survey` is what keeps a venue stopped, and an in-memory set
is how a *running* loop is told to stop now — deliberately forgotten on a restart, since there is no
loop left to stop. `GET /status` reports the second as `stopping`, the moment between asking and the
loop noticing.

**Only a person's decision writes the row.** A refresh and a forced update both have to stop a running
loop before they can do their own work, and neither is anybody deciding the venue should be stopped —
so both take the in-memory half alone (`halt`), never `pause`. During that gap the venue reports
`stopping`, never `paused`, which is the one word meaning a person stopped it.

## Probing: settling what a listing could not carry

A walk establishes **what is there**; a probe establishes **what it is**. On a listing venue the two
arrive together, because a listing states size and checksum. On an index venue it states neither, so
the catalog holds paths and dates until something asks — and "how much disk does this cost, and how
long will it last" is unanswerable from paths alone. An update's generated keys are the same case:
nothing has seen them.

So a pass that probes — every update, and a walk on a venue whose adapter says `probes` — runs a
**second loop** beside its generating half, settling files a `HEAD` at a time. Neither waits on the
other while there is work: a file found in the first minute should not sit unestablished until the
last scope closes, so during a backfill the probe runs for hours behind the walk. A probe and a
listing page pass the same gate and count against the same budget
([PROSPECTOR-TRANSPORT.md](PROSPECTOR-TRANSPORT.md#cadence-and-concurrency)).

**Whether a pass probes is a property of the pass, not of the adapter**, stated once (`probing` in
`survey.ts`): an update always probes, because it generates keys rather than reading them, so a
listing venue that never probes while walking starts probing the moment it stops. The pass, the log
line and the closing of a walk's job all read that one expression.

### A probe is the second half of a pass, and ends with it

While indexing is under way an empty backlog means *not yet*, so the loop waits and asks again. Once
the generating half stops nothing more is coming, and the probe is draining: it keeps taking rounds
until the backlog is empty and then logs *Survey complete* — the same line a pass that does not probe
logs when its scopes are done. A pass that finishes generating while a probe still owes logs
*Candidates generated; probing them* instead: half a million names nobody has established are not a
surveyed venue. Until the probe stops, the venue counts as running: `POST /surveys` skips it rather
than starting a second loop against the same host.

**A drain ends only by emptying the backlog.** A refusal or a fault says nothing about the rows —
they are still owed and the venue is simply not answering. A round ends early where the venue stands
us down, or where it has refused 50 times (`giveUpAfter`) and settled nothing; the probe then waits for
as long as the venue's gate, or its declared stand-down, says, and tries again. A round in which the
venue answered nothing about any key is logged as an error
(`Probing is getting no answers; still trying`) and asked again. There is no give-up rule, so the pass does not finish until the rows are
answered (see [what ends a key](#what-ends-a-key-absence-confirmed)).

**A round follows the one before it as soon as there is work** — a round that settled, retired or
confirmed anything goes straight round. Only a round that moved nothing waits, for thirty seconds:
an empty backlog while the walk is still running, or a venue that has stopped making sense. The
attempts that are supposed to be spread over time are spread by the *update* schedule, a pass a day,
not by pausing inside one pass.

### The work list is a query

**So there is no state to keep.** A pass asks `wip` for its rows and settles them; a row leaves that
list by being settled or set down, so the query *is* the cursor and a restart resumes by asking again.

**In the order the rows were parked, which is `wip.seq`.** Whoever produced the work chose the order
— a walk offers a venue's keys in the venue's order, generation emits a series ascending by date —
and the probe imposes nothing of its own on top.

Ordering by *date* would be wrong, because the two halves of a pass run at the same time. Generation
is still parking keys while the sweep reads them, so a row written for a date the cursor has already
passed would be invisible until the next round however old it is; a sweep that had reached 2023 would
**not** have asked about everything below 2023. A `seq` only ever grows, so a key parked mid-sweep
always lands ahead of the cursor and is asked in the pass that produced it.

Which is why the column is `AUTOINCREMENT` and not a plain rowid. This table's *highest* rows are
the ones deleted, constantly, as they settle; with `max(rowid) + 1` the counter would run backwards
after every drain and reopen exactly that hole.

The consequence worth knowing: generation walks its series sequentially, so probing completes one
series at a time rather than advancing every series' date together. A pass cut short has answered
whole series rather than a part of every one.

The cursor is a **value**, one integer, rather than an open statement. SQLite will let a query step
while the same connection rewrites the rows it is walking, and what happens then depends on which
index the planner chose: rows visited twice, or skipped, with nothing said. A keyset cannot be wrong
that way, and it moves past rows that did *not* settle, so one stubborn file cannot hold the rest of
an archive behind it. A pass ends when the query comes back empty; the next starts from the
beginning, which is what picks up files a walk has found since.

### Nothing is parked that the catalog already holds

Generation reads the tip and nothing else, so an update emits every key between the tip and the
frontier whether or not its file arrived days ago.

Probing them could not change anything either. Settling acts only on parked rows and inserts
`ON CONFLICT DO NOTHING`, so a held file is never corrected by an update; a correction goes through
`correctFile`, which an update never calls.

So the question is asked at the one moment the row is still cheap not to write — parking — as a
`NOT EXISTS` against `file`'s primary key. One index probe, against an insert, a read and a request
later on. What stays parked is what the patience window is for: the periods nobody has answered for
yet.

**A withdrawn file is not a held one.** Its row stays as the record that the venue once served it,
and the check reads `existence <> 'absent'`, so a file that went away is asked about again — which is
the only way to learn it is back. Settling it writes over the absent row, and over no other.

**A first settling is not a revision.** Learning a size for the first time is not the file changing,
so the trail is appended to only when something known differs — otherwise every probed file would land
in `revision` on its first sighting and "what changed since I last looked" would answer "everything,
once".

### One module owns `wip`, because the count has to be exact

`wip` reaches tens of millions of rows on a venue whose keys are constructed, and `count(*)` over
that is not a slow query but a stall: `node:sqlite` is synchronous, so the count freezes the whole
process — every socket, every timer, every other venue — for as long as it runs: 1.8 seconds on a
25-million-row backlog.

The answer is a maintained count, and a maintained count is only safe while nothing can change the
table behind its back. So every write to `wip` goes through `catalog/wip.ts`, and the count is kept as
a consequence of the writes rather than as a duty laid on every caller. Three rules make it hold:

- **The count is seeded once per venue per connection**, by the one real `count(*)` that nothing can
  avoid, and maintained from then on.
- **Deltas are applied after the commit, never inside it — and immediately after, with nothing
  awaited in between.** A transaction that rolls back did nothing to the table, and a counter moved
  before the commit would keep the change anyway. But a delta held *past* its commit is as wrong: the
  batched parker commits a batch and then yields, the probe settles those rows in the gap, and their
  removal would reach the counter before their arrival did. The counter clamps at zero, so the
  removal would be lost and the arrival land on rows that are already gone. `putFiles` and
  `settleFiles` own their transactions, because a file must not arrive without leaving the backlog;
  they take statements from the module and report what moved once it has committed.
- **It is held against the connection, not in a bare map keyed by venue.** A count describes one
  database and venue ids repeat across them, so a figure keyed by venue alone would outlive the
  catalog it was read from and be quietly wrong about the next one.

**The count is for reporting; the table decides.** Whether a pass may finish is asked of `wip`
itself — `EXISTS` on `(venue_id, seq)`, one index probe whatever the backlog's size — and only once
generation has finished, since an empty backlog while keys are still being produced means *not yet*.
A counter can be wrong in a way nothing detects; where the table says empty and the counter
disagrees, the counter is forgotten and re-read, so the status endpoint stops reporting a backlog
nobody has.

### What ends a key: absence, confirmed

**Absence is the only answer that takes a key off the list**, and the core takes it only once the
venue has given it more than once — unless the adapter's rule answers `'drop'`, which sets the key
down on that answer. A single 404 is a moment, not a fact: a key probed the instant before it was
published answers truthfully and is wrong about the archive, and a pass that took the first miss as
final would let reconciliation retire the whole period without ever asking again. `probingLag`
already keeps the frontier past each venue's publication delay, so the second ask buys little where
nothing new is due; it is the guard for where something is.

**How many attempts depends on who said the key was there** — the `existence` the row was parked
with, never the pass doing the asking (`CONFIRMATIONS`):

| parked as | attempts | why |
|---|---|---|
| `confirmed` | 30 | a listing named it, so absence contradicts evidence. A venue mid-write or having a bad minute looks identical from here, and being slow to write a key off costs requests where being quick costs the file |
| `assumed` | 2 | built from a pattern and a date. Absence is the ordinary answer to a guess, and confirming it thirty times spends thirty requests proving what the first already said — on keyspaces that are mostly empty |

How a venue *spells* absence is the adapter's to say. In the probe, absence is a `404` or a `'drop'`
and nothing else. Where a status also means *we* are being turned away, the two separate by headers
rather than by code, through `refusesUs` and `ruleOnFailure`. An adapter may also name further
absence statuses in **`notFoundCodes`**, and none does: such a status is counted as a miss rather than
a refusal, and a report's confirmation of a single file reads it as absence, but the probe sets a key
down only on a `404` or a `'drop'`. A `404` or `403` is never retried at the HTTP level — only 5xx,
429 and transport failures are ([the retry ladder](PROSPECTOR-TRANSPORT.md#the-retry-ladder)).

Each non-settling answer is put to the adapter's `ruleOnFailure` first:

| verdict | meaning |
|---|---|
| `null` | as you were — a `404` is absence, confirmed as the table above says; anything else is not |
| `'drop'` | absent now: the row is spent on this answer, with no confirmation count |
| `'keep'` | not absence, whatever the status says |

Which adapters answer `'drop'`, and for what, is in [PROSPECTOR-VENUES.md](PROSPECTOR-VENUES.md#venue-by-venue):
bitget for its bucket's `403`, okx for every `404`.

**A rule can ask which pass it is in**, through `surveying(adapter)`. bybit/secondary uses it to keep
a key its index named through up to 100 `404`s while a walk is running, and defers to the core
outside one. The helper is ambient rather than an argument because the question is: an adapter rule
is handed one answer about one key and cannot be told which pass it belongs to without threading a
parameter through every caller in between. It is keyed per venue, since one process surveys all of
them at once, and scoped so that no ending — a throw, a pause, a venue blocking us — leaves a venue
looking like it is still walking. It does not follow a row: walked keys an update inherits from an
undrained backlog get the core's 30 attempts, not bybit's 100.

**Everything else keeps its row, for as long as the service runs.** A 429, a 5xx, a reaped connection
say nothing whatever about the file, so there is nothing to conclude and no count to run down. The row
stays in `wip` and the drain keeps asking — there is no give-up rule and no round limit.

So the pass simply does not finish: nothing is reconciled, and the venue does not move on to the next
day's keys until somebody looks. That is the intended shape rather than a gap. Every venue here is S3,
OSS or a known CDN in front of one, and one answering with something that is not an answer is a venue
to go and fix, not one to design around. It says so every round, as an `error` naming the venue and
what is left.

**Leaving `wip` is not a claim about the archive.** A row that is given up on is deleted, never
marked: a ruling of `absent` is a statement that a venue withdrew something it published, and it
belongs to `file`. Nothing is recorded as absent — "not there now" is not a claim about what was ever
published — and the next update generates the key again while its period is above the tip. What
eventually retires the period is [reconciliation](PROSPECTOR-SERIES.md#reconciliation-what-a-completed-pass-is-worth),
not a count and not a clock.

So **every row in `wip` is outstanding**, which is what makes the backlog a `count(*)` rather than a
filtered scan of tens of millions of rows per venue.

### What a settled probe means: `ruleOnSuccess`

A probe that settles is still put to the adapter, through `ruleOnSuccess(row, size)`, for the case of
an archive whose published key is not the file:

| it returns | meaning |
|---|---|
| nothing | the ordinary case, and every venue today |
| `action: 'accept'` | settle the file as usual |
| `action: 'replace'` | discard it — it never reaches `file`. For an archive whose key names a manifest rather than the data |
| `next` | keys to park in `wip`, inheriting this row's series and period |

A file a probe settles is a sighting of its series, and widens its bounds as a listed one does
([PROSPECTOR-SERIES.md](PROSPECTOR-SERIES.md#a-sighting-states-the-bounds-a-finished-pass-checks-them)).

## Asking what is established

`establishedAt(prefix)` answers with the latest `started` of the completed runs covering it — job
row or scope, at the prefix itself or any ancestor, since a walk of `spot/` settles everything
beneath it. **Only the kind that establishes the venue counts**: walks at a venue that has ever been
walked, updates at one that never has (okx, bitget), since an update reads only the newest stretch of
each series and says nothing about the rest of a walked tree. **A completed ancestor does not count
while an open scope of the same kind lies below it**: splitting closes the parent and hands the
rest of its keyspace to children, so the parent's `completed` says the run stopped, not that the
prefix is established.

Where several qualify the answer is the **latest**: each is a true statement about the prefix, so the
strongest one wins. Taking the shortest instead would let a venue-wide pass from last month shadow a
walk of that very prefix from an hour ago.
