# Catalog UI

Catalog UI is a page for reading what the catalog holds, editing lenses, and starting and pausing
surveys. The catalog and prospector answer; this renders what they say, and sends back the requests
that change anything.

**Every fact on the page comes from an API answer**: what a venue publishes, what a lens costs, what a
survey is doing. The page groups and filters what it was given, and derives only presentation from it:
shares and percentages, durations, *N of M*, and the words it reads off `GET /status` fields
(`stalled`, `backfilling`, `updating`). A question this page cannot answer is one the APIs cannot
answer.

## What it is not

- **It holds no server-side state.** The server has no database, no cache and no session; reloading
  asks the services again. What persists is per browser, in `localStorage`: each lens's unconfirmed
  rule drafts, tagged with the version of the lens they were written from; a new lens not stored yet;
  each saved lens's last known size, shown until the next one arrives; and the lens last opened in the
  lenses section. One reading of `GET /lenses/options` is shared by the page for a minute before it is
  asked for again.
- **It does not know the venues.** Markets, datasets, variants and instruments are strings that arrive
  from the catalog; a venue prospector adds appears here with nothing changed.
- **It does not decide.** Every button is one API call, and what that call means for a venue is worked
  out by the service that answers it.

## The server and its proxy

The page is static. It is served by a small express process that also forwards the page's requests, for
two reasons:

**Neither service need be reachable from the browser.** Prospector's private API publishes no port
outside the module network, and the catalog's port need not be reachable from wherever the browser is
open. The page talks only to its own origin.

**The token stays on the server.** Where `CATALOG_TOKEN` is set, the server adds it as
`x-catalog-token` to every request it forwards, and the bundle never holds it. The server checks
nothing about who is asking: whoever reaches its port acts with the token, within the routes below —
starting and pausing surveys, and creating, editing and deleting lenses.

```
browser ── /api/catalog/<route>    ──▶ catalog-ui ── x-catalog-token ──▶ catalog     (CATALOG_API)
        ── /api/prospector/<route> ──▶            ── x-catalog-token ──▶ prospector  (http://prospector:8080)
        ── /api/where              ──▶            (answers from its own config)
        ── any other path          ──▶            (the page's static files)
```

`/api/where` answers `{ "catalog": <CATALOG_API> }`, which the page shows in its header, so nothing
about the deployment is baked into the bundle.

### What is forwarded

Only the requests the page makes. Each `:param` is one path segment, anything but `/`, so an encoded
`%2F` stays inside it; `GET` also admits `HEAD`.

| to | method | `<route>` |
|---|---|---|
| catalog | `GET` | `/venues`, `/venues/:venue`, `/venues/:venue/symbols`, `/venues/:venue/markets/:market`, `/venues/:venue/markets/:market/symbols` |
| catalog | `GET` | `/lenses`, `/lenses/options`, `/lenses/:slug/size` |
| catalog | `POST` | `/lenses` |
| catalog | `PUT`, `DELETE` | `/lenses/:slug` |
| prospector | `GET` | `/status` |
| prospector | `POST` | `/surveys`, `/surveys/pause`, `/venues/:venue/surveys` |

Any other method or path under `/api/catalog` or `/api/prospector` answers `404`
`{"error":"Not forwarded"}` without leaving the process, and so does a path whose dot segments (`..`,
`%2e%2e`) would resolve outside what was matched. What each route does is the service's own: see
[CATALOG-API.md](../modules/CATALOG-API.md) and [PROSPECTOR.md](PROSPECTOR.md#the-api).

### What is refused first

Ahead of forwarding, a request under either prefix is refused where another site, or another name,
could have made a browser send it:

- `403` where `CATALOG_UI_HOSTS` lists names and `Host` is none of them (as `host` or `host:port`);
  empty, any `Host` is served.
- `403` where `Sec-Fetch-Site` is present and is neither `same-origin` nor `none`.
- `403` where `Origin` names a host other than `Host`.
- `415` for a write other than `DELETE` whose body is not `application/json`. A browser sends such a
  body cross-origin only after a preflight, and no CORS header is ever sent.

### What passes, each way

Upstream goes the path below the prefix and the query string as sent, the token, `x-catalog-lens`
where the page sent one, `Accept` (`application/json` where the client sent none), and the JSON body
where there is one, with `content-type: application/json`. Nothing else of the client's request is
passed on, and an upstream redirect is not followed.

Back comes the upstream answer's **status, content type and body bytes**, as they came; no other
header is relayed. The services answer a refusal with a body saying what was wrong, and the page shows
that whole rather than a generic failure.

Where there is no answer to relay:

- **`502`** `{"error":"Could not reach <service>"}` where the service cannot be reached; the URL it
  tried is in this server's log.
- **`504`** `{"error":"No answer from <service> within 120 s"}` where nothing has come back within two
  minutes (`UPSTREAM_TIMEOUT_MS`, above the catalog's slowest answers).

### When the page stops waiting

The page aborts a request it no longer wants: leaving a view, a newer request for the same thing, a
poll that stops. When the browser's connection closes before the answer, the server aborts its
upstream request and answers and logs nothing. The catalog then sees its own connection close and
drops the request if its work has not started; a request already running completes, because its work
is synchronous ([CATALOG.md](CATALOG.md#requests-nobody-waits-for)).

## The three sections

**Contents** is what the catalog holds; **surveys** is what is being done about
it; **lenses** is how a consumer sees a slice of it. They answer different
questions and change on different clocks — one is a fact to read, one a thing to
act on, one a decision that stays until it is changed.

Surveys is the default, because it is the one that changes. What the catalog
holds is still there tomorrow; whether anything is collecting it is the question
somebody opens this page to answer.

Routing is `location.hash`, read as a path: `#surveys`,
`#contents[/:venue[/:market]][?lens=:slug]`, `#lenses[/:slug]`. Every view is
therefore a link somebody can send, back and forward move between them, and the
lenses tab returns to the lens last opened there — a router here would be a
dependency that reimplements `location.hash`.

### Contents

Three depths, each a narrowing of the last: **venues**, then a venue's
**markets**, then one row per `(dataset, variant, grain)` a market publishes.

Filtering happens **in the page**, over the rows it already has — the catalog
answered the question once, and narrowing what is on screen is not another
question. Symbol lists are the exception in the other direction: they are asked
for behind a click rather than fetched with the page, because a venue can publish
thousands of instruments and almost every visit is about something else.

**A shape's span is two measurements**: the oldest period anything covers, and
the newest file the catalog has seen. So a variant that stopped beside the one
that replaced it reads as two adjacent spans — bybit's perpetual books are
`incremental,500` reaching 2025-08-20 and `incremental,200` from the 21st —
which is what tells a reader to fetch both.

**The contents can be seen through a lens.** A picker beside the breadcrumbs narrows every list and
count below it to what the lens lets through, by sending its slug as `x-catalog-lens` — so the page
shows exactly what a downloader through that lens would be offered. The lens is part of the address,
so it follows a click from a venue into a market and survives a reload; cleared, it is the whole
catalog. What changes under a lens is in [CATALOG-LENSES.md](../modules/CATALOG-LENSES.md).

### Surveys

One row per venue, polled every ten seconds: a survey runs for hours and reports
nothing when it starts, so a view that loaded once would show a stale word for as
long as somebody left it open. **Every poll on the page is one request at a
time**: the next is asked ten seconds after the last answer, never on a clock
that fires whether or not it came back, which would stack requests on a slow
service and make it slower.

**The state says what is happening, not how.** `walking` and `updating` are the
two mechanisms the catalog has, and naming a venue's state after one of them
answered a question nobody asked while hiding the one they did: whether this is
the first long read of a venue or the daily top-up. So the word is the occasion —
**backfilling** the first time, **updating** every time after, from
`lastRun.first` — and the mechanism stays as a small icon and a tooltip, for
whoever wants it. A walker reads an index page by page; a magnifier asks about
one constructed key at a time.

That distinction is not the same as the mechanism and cannot be derived from it.
A venue that cannot be listed backfills by generating keys, and one that re-reads
itself by walking updates by walking — so both readings would be wrong on some
row, and the catalog answers it directly instead.

**An order is shown as heard the moment it is given.** Clicking Update, Start,
Resume, Refresh or Pause marks the row `starting` or `pausing` at once, disables
everything in it, and polls every two seconds instead of ten. The row is handed
back when the status shows the order done — the venue `starting`, going, or
paused, a pass that began after the click, or a resumed venue no longer paused
(one paused while waiting goes back to waiting) — and not before, so a second click
cannot land on an order still in flight. A request that fails frees the row and
says why; an order with no sign of being acted on after two minutes is let go of
and said to have lapsed, rather than holding the row for ever.

The page's own mark covers only the seconds before the catalog reports anything.
After that the catalog's `starting` state carries it, which is also what a
scheduled pass shows during its preamble — nobody clicked, and the venue is just
as much on its way.

The same word runs through the badge under a venue's name (*Backfill in
progress*, *Updated 2026-09-23*) and through the `Runs` column, with the
mechanism in each one's tooltip.

**`WIP` distinguishes zero from inapplicable.** A venue whose listing states
every file parks no candidates ever, and `0` there reads as *nothing outstanding*
— as though something had just finished. A dash says the column is not about that
venue; the figure appears when anything is parked, or when the pass works by
probing, which `/status` answers as `probing`.

**One state is this process's to report, not the catalog's: `stalled`.** A job
open with nothing working it is not a survey in progress, and every field the
catalog returns says it is — `state` reads `walking`, the run reads *started at*,
the venue's badge reads *in progress*. Only this process can tell, because
whether a loop is alive is a fact about it rather than about the catalog.

It is shown in red, in the state badge itself. It is a fault rather than a phase,
so it belongs where somebody is already looking rather than in a column of its
own — which is what it was, answering *Yes* / *Stalled* / *—* where two of the
three repeated the row.

Two things leave a venue there: a loop that threw its way out while its run row
stayed open, and a job no deployment in scope will pick up. The killed container
is no longer one of them — startup resumption claims an open job within
milliseconds of the process starting.

**What a venue last did is read from the catalog's run rows, not from
`surveying`.** A walk interrupted by a kill is still the venue's last pass, and
saying so is more use than saying nobody is on it — and a venue mid-survey has
not "never" been surveyed, which is what reading it off this process would say.

**The `Runs` column reports one kind of event, and the same one on every row:**
the pass that is happening, or the newest one that finished — *Update started
at*, *Backfill completed at*, or *Not started yet* where no pass has ever run. It
took whatever the *state* happened to make available before: a pause time on one
row, a next-update time on another, a job start on a third. No two rows answered
the same question, and most answered none — `was waiting` named the phase a pause
had interrupted, which for a venue between updates is the phase nearly every
venue is in nearly all of the time.

**Being paused is not a case in that column.** A pause neither closes a run nor
undoes one, so it changes neither which pass is newest nor when it happened, and
the state badge one column to the left already says a person stopped this venue.
Waiting is not a case either: a venue waiting for its next update is one whose
update *completed*, which is what it says.

**Under it, smaller, the context.** A waiting venue says when its next update is
due. A venue with a pass running says what it last finished — *Backfill completed
in 26m* or *Last update completed in 1h*, from `lastRun.previous`. There is only
ever one backfill, the first pass, so it is never "last"; every pass after it is
an update, whether it walks or probes.

#### The controls

**A word asks a venue to go; everything else is a shape.** Asking is the
decision this page exists for, so it keeps a word:

| state | word | call |
|---|---|---|
| **not started** | Start | `POST /venues/:venue/surveys` |
| **waiting** | Update | the same call with `update: true`, which skips the wait |
| walking, updating, paused | none — the slot is held empty | — |

**The word comes from `completedEver`, and from nothing else.** `Start` is a
venue no pass has ever finished for; `Update` is one a pass has. How the venue is
read does not enter into it: taken from `listable`, okx and bitget would read
`Update` on their first ever pass, because theirs generates keys rather than
walking; taken from the newest run's `kind`, a venue that re-reads itself by
walking would read as starting again every day. Both are true statements about
this service's internals and neither is what somebody clicking is deciding, so
`GET /status` answers the question directly.

**And it is asked of every one of a venue's servers.** Bybit publishes from two,
and a venue whose second host has never read itself through has not been surveyed
before — it is half read, and the word for that is `Start`. The same rule decides
the badge's `backfilling` against `updating`, so the two cannot disagree about
the same venue.

The slot keeps its width on every row, empty or not, so the icons beside it line
up down the column whatever each venue is doing.

The icons are **hold or go**, and **start over**:

| icon | means | enabled for | call |
|---|---|---|---|
| ⏸ | pause | walking, updating or waiting | `POST /surveys/pause` |
| ▶ | resume | a paused venue | `POST /venues/:venue/surveys` |
| ⟳ | refresh | a venue that is `listable` | `POST /venues/:venue/surveys` with `refresh: true` |

**Pause and resume share one slot**, because they are opposite and no venue is
ever both: a venue going is stopped there, a stopped one carries on from there.
Two slots would grey one of them out on every row. The shape says which is
offered and the colour follows it — grey for stopping a venue, teal for setting
one going, the colour the `Start` word carries. Resuming is the same request as
starting, since a pause keeps every cursor and the catalog has no separate resume
verb to offer.

**Pausing a venue that is only waiting is the case this page used to have no way
to ask for.** The two readings of pause are the same request: mid-pass it stops
after the current page and keeps every cursor, and waiting it means *do not start
the next update when it falls due*. Without it, a venue whose interval was about
to come round could only be stopped by catching it once it had started.

**`update: true` is only sent by a venue that is waiting.** A forced update is
refused where nothing has ever completed, and a venue mid-pass is already doing
it — so everywhere else the word sends the plain request and lets the catalog
work out what it means.

**Refresh asks first** — it drops a venue's run rows and walks the whole archive
again, the one control here that throws work away. It is **disabled entirely for
a venue that is not `listable`**: okx and bitget serve no listing, so their series
are declared rather than discovered and a re-walk has nothing to re-read. The
button would drop their run rows and walk nothing.

All three are disabled in place rather than removed, so they occupy the same
three positions on every row, and a disabled one says in its tooltip why it
cannot be clicked. Dropping one shifts the others and the column stops reading as
a column.

The shapes are drawn in the page rather than installed: three glyphs at one size
do not carry an icon package, and a `currentColor` path inherits each button's
colour and its disabled state.

**A row is held while it is mid-change**, and that means two waits rather than
one. The request in flight is over in milliseconds; `stopping` — the loop told to
halt and not having noticed yet — lasts as long as the page it is on. Reading
only the first handed the buttons back while a pause was still taking effect, and
acting there asks a venue to stop for something that has already stopped it.

**A resumed update is reported as one.** Where the catalog answers `resumed`
rather than `started`, the page repeats that word: carrying on from cursors that
already exist is not the same as planning fresh scopes, however alike they look.

### Lenses

A lens is a named way of looking at the catalog: where one is in force, what it
lets through *is* the catalog as far as whoever looks through it is concerned. So
this section is not a shopping list — it is the definition of a view, and what it
has to make obvious is what that view leaves out.

**Includes minus excludes, in no order.** A lens lets through what its includes
match, less what its excludes match, so *everything up to a date, except books,
except recent trades* is three rules — and rules have no order to arrange. The list
is per venue, keyed by name, and a venue with no rules is not in the lens at all.

**The page shows a block for every venue regardless**, because a lens is written
by reading down the venues and saying what each contributes, and "nothing" is an
answer an empty block gives and a missing one does not. The definition is
unaffected: a block with no rules is not written, so the stored document still
names only the venues the lens actually speaks about. The per-venue Clear stores the
lens without any of that venue's rules, after asking, and leaves the block where it
was.

**A rule states only what it constrains**, and every dimension left alone is shown
as `every` rather than as a blank — because the difference between "all datasets"
and "no datasets chosen yet" is the whole meaning of the rule. Each list offers
what the venue actually publishes, so a dataset that venue has never had cannot be
picked. What every venue publishes is asked for once, from `GET /lenses/options`,
and each block takes its own rows from that one list.

**A market or a dataset says where it is found when it is pointed at** — chosen
already, or still in the list. A market names the venues that publish anything in
it; a dataset, the markets of each venue that publishes it, for the variant chosen
or for any. It is read off the same list, in every block, so the answer does not
need a rule under *All venues* to be had.

**A rule is stored on its own.** Writing one sends nothing: *Add rule* puts a draft
on the page, outlined in yellow until it is confirmed, and editing it costs the catalog nothing.
**Confirm** stores the lens with that rule; **Drop Rule** stores it without one
already stored; **Discard** throws a draft away and **Revert** takes an edited rule
back to what is stored. Only the rule confirmed is sent — other drafts stay drafts,
and an unsaved name or note stays unsaved. **Save** is for the name and the note.

**A new lens is the page's until it is first stored.** *New Lens* names it and
opens it, and nothing reaches the catalog until Save or the first Confirm, which
creates the lens with its name, its note and that rule.

**The catalog decides what can be stored.** A confirm the catalog refuses comes
back with its problems, shown on the rule, which stays a draft. Two of them are
about meaning rather than spelling, and both are silent faults: a venue whose rules
**include nothing** lets nothing through, since an exclude only takes away; and an
**empty list** in a dimension matches nothing, where leaving it out matches all of
it.

**The lens carries what it costs** — the saved lens's size, exact, summed over its
partitions — refreshed after every confirm and drop. A draft is never sized: what a
rule would cost is answered by confirming it.

**Drafts can be thrown away.** Drafts and unsaved names are kept in the browser, so a
reload does not lose them — and by the same token cannot undo them. *Reload as
saved*, beside *Save*, puts back what is stored and drops every draft; it appears
only while there is something to drop.

**And how much of it is already on disk.** A bar under the total shows the share
downloaded by weight, not by count — files run from kilobytes to gigabytes, so a
count says little about the wait. The size is asked again every thirty seconds,
so the bar moves while a downloader works through the lens.

**A rule picks a bundle, never an instrument.** *Both*, *Per instrument* or *Buckets* — the files
of one instrument each, the venue-wide files carrying every instrument of a market, or the two
together. What a rule selects is therefore always whole.

**Instruments are searched, not browsed.** A venue lists more of them than anyone
scrolls, so the field stays quiet until three characters make it worth answering,
and what has been chosen sits beside it as badges — five, then a count carrying
the rest in its tooltip.

**A half-written lens survives a reload.** A rule list is minutes of work and the
section is a route, so a glance at the Contents tab would otherwise take all of
it. Drafts are kept in `localStorage` per lens, tagged with the version they were
written from — so a lens saved somewhere else replaces them rather than silently
reviving edits to a document that has moved on. A new lens not stored yet is kept
the same way.

## How it is built

`web/` is the page: React and Mantine, built by Vite into `dist/web`, which express serves as static
files. `src/` is the server: config, the proxy, and nothing else. Building and running it in
development are in the [service README](../../services/catalog-ui/README.md#development).

The types in `web/types.ts` are **mirrors of the catalog's and prospector's own**, not a model of its
own. A field added upstream appears here by being added to one of them, never by this service learning
to compute it.

**Layout lives in the components, not here.** Column widths, badge treatment,
what is disabled when, why a rule beats Mantine's — those change with the design
and are argued beside the markup they act on. A document that has to be edited
for a padding is describing the wrong layer.
