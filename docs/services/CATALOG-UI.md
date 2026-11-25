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

Back comes the upstream answer's **status, content type, `Location` for a redirect, and body bytes**,
as they came; no other header is relayed. The services answer a refusal with a body saying what was wrong, and the page shows
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

**Contents** is what the catalog holds; **surveys** is what prospector is doing about it; **lenses**
are the named selections of it. One is a fact to read, one a thing to act on, one a decision that stays
until it is changed.

Surveys is the default, because it is the one that changes: what the catalog holds is still there
tomorrow, and whether anything is collecting it is the question somebody opens this page to answer.

Routing is `location.hash`, read as a path: `#surveys` (or nothing),
`#contents[/:venue[/:market]][?lens=:slug]`, `#lenses[/:slug]`. Every view is therefore a link
somebody can send, back and forward move between them, and the lenses tab returns to the lens last
opened there. Anything the hash does not name is the surveys view.

### Contents

Three depths, each a narrowing of the last: **venues**, then a venue's **markets**, then one row per
`(dataset, variant, grain)` a market publishes.

Filtering happens **in the page**, over the rows it already has: the catalog answered the question
once, and narrowing what is on screen is not another question. Symbol lists go the other way: they
are asked for behind a button rather than fetched with the view, because a venue can publish
thousands of instruments and almost every visit is about something else.

**A shape's span is two measurements**: the oldest period anything covers, and the newest file anybody
has seen. So a variant that stopped beside the one that replaced it reads as two adjacent spans, which
is what tells a reader to fetch both.

**The contents can be seen through a lens.** A picker beside the breadcrumbs narrows every list and
count below it to what the lens lets through, by sending its slug as `x-catalog-lens`, so the page
shows what a reader through that lens is offered. The lens is part of the address, so it follows a
click from a venue into a market and survives a reload; cleared, it is the whole catalog. What changes
under a lens is in [CATALOG-LENSES.md](../modules/CATALOG-LENSES.md#reading-through-a-lens).

### Surveys

One row per venue, from prospector's `GET /status`, polled every ten seconds. **Every poll on the page
is one request at a time**: the next is asked ten seconds after the last answer, never on a clock that
fires whether or not it came back, which would stack requests on a slow service. A failed poll keeps
the figures last read and shows the error beside them.

What each `/status` field means is prospector's: see [PROSPECTOR.md](PROSPECTOR.md#status). This
section is about what the page makes of them.

**The state says what is happening, not how.** Prospector's states for a pass, `walking` and
`updating`, name its mechanism. The badge names the occasion instead — **backfilling** for the first
pass, **updating** for every one after, from `lastRun.first` — because that is what somebody looking
wants to know, and the occasion cannot be derived from the mechanism. The mechanism stays as a small icon
(a walker for reading a listing, a magnifier for probing files) and a tooltip.

**`stalled` is this page's word**, shown in red in the state badge, for a venue prospector reports as
`walking` or `updating` with `surveying: false`: work outstanding and no loop of prospector's doing
it. It is a fault rather than a phase, so it goes where somebody is already looking. Prospector
reports that pair for a venue whose survey loop ended on a fault while its job stayed open, and for an
open job of a venue outside this deployment's `PROSPECTOR_VENUES`.

**An order is shown as heard the moment it is given.** Clicking Start, Update, resume, refresh or pause
marks the row `starting` or `pausing` at once, holds everything in it, and polls every two seconds
instead of ten. The row is handed back when the status shows the order done (the venue going, paused,
a pass begun since the click, or a resumed venue no longer paused) and not before, so a second click
cannot land on an order still in flight. A venue prospector declines in its answer is handed back at
once; a request that fails frees the row and says why; an order with no sign of being acted on after
two minutes is let go of and said to have lapsed. After the page's own mark, prospector's `starting`
state carries the row, which is also what a scheduled pass shows during its preamble.

A row is also held while prospector reports it `stopping`, the loop told to halt and still finishing
its page, and while its state is `starting`.

**Under the venue's name, a badge says what it last did**: *Backfill in progress*, *Updated
2026-09-23*, *Never surveyed*. The badge names the occasion; its tooltip names the mechanism.

**The `Runs` column reports one kind of event on every row:** the pass that is happening (*Update
started at …*), or the newest one that finished and how long it took (*Backfill completed in 26m*), or
*Not started yet* where no pass has ever run. Paused and waiting are not cases of their own: a pause
neither closes a run nor undoes one, and the state badge already says it. Under it, smaller, the
context: while a pass runs, what the venue last finished (*Last update completed in 1h*, from
`lastRun.previous`); while it waits, when its next update is due (*Next update at …*, or *due now*
once that time has passed). Only one backfill ever runs, so every pass after it is an update.

**`WIP` distinguishes zero from inapplicable.** A venue whose listing states every file parks no
candidates, and `0` there would read as *nothing outstanding*. A dash says the column is not about
that venue; the figure appears when anything is parked, or when `/status` reports the pass `probing`.

**`Files`** carries, under the count, how many of the venue's series hold at least one file out of
how many there are.

#### The controls

**A word asks a venue to go; everything else is a shape.**

| state | call |
|---|---|
| **not started** | `POST /venues/:venue/surveys` |
| **waiting** | the same call with `update: true`, which skips the wait |
| any other | none; the slot is held empty |

**The word comes from `completedEver`, and from nothing else**: `Start` is a venue no pass has ever
finished for, `Update` one a pass has. How the venue is read does not enter into it; the badge's
`backfilling` and `updating` rest on prospector's same answer, so the two do not disagree about a
venue. `update: true` is sent only by a waiting venue, since prospector refuses a forced update where
nothing has ever completed and a venue mid-pass is already doing it.

The icons are **hold or go**, and **start over**:

| icon | means | enabled for | call |
|---|---|---|---|
| ⏸ | pause | walking, updating or waiting | `POST /surveys/pause` with `{ venue }` |
| ▶ | resume | a paused venue | `POST /venues/:venue/surveys` |
| ⟳ | refresh | a venue `/status` reports `listable` | `POST /venues/:venue/surveys` with `refresh: true` |

**Pause and resume share one slot**, because no venue is ever both. Resuming is the same request as
starting: a pause keeps every cursor. Pause works on a waiting venue too: mid-pass it stops after the
current page and keeps every cursor; waiting, it means do not start the next update when it falls due.

**Refresh asks first**: it drops the venue's run rows and walks the whole archive again, the one
control here that throws work away (see [PROSPECTOR.md](PROSPECTOR.md#refreshing)). Where `/status`
reports `listable: false` there is nothing to walk, so it is disabled.

The word's slot keeps its width on every row, and all three icons are disabled in place rather than
removed, each saying in its tooltip why it cannot be clicked, so they line up down the column.

Under the table, **Start/Resume All** (`POST /surveys`) and **Pause All** (`POST /surveys/pause`) do
the same to every venue. Where prospector answers that it resumed a venue rather than starting it, the
page says *resumed where it stopped*.

### Lenses

What a lens is and how its rules combine is in
[CATALOG-LENSES.md](../modules/CATALOG-LENSES.md#the-definition). This section is the editor.

**A lens is picked from a bar**, beside **New Lens**, and opened at `#lenses/:slug`. An address that
names no lens opens the first one instead.

**Every venue has a block, whether or not it has rules**, below one for **All venues** (`*`, applied
together with each venue's own rules). A lens is written by reading down the venues and saying what
each contributes, and "nothing" is an answer an empty block gives and a missing one does not. The
blocks are the venues that publish anything, plus any venue the lens has rules for. A block with no
rules is not written into the definition. A block's **Clear** stores the lens without any of that
venue's rules, after asking.

**A rule is two rows.** The first is what it does: **Action** (Include or Exclude), **Grain** and
**Bundle**. The second is what it is narrowed by: **Markets** and **Datasets**. Beside them are the
months **From** and **To**. Grain, Markets and Datasets offer only what the venue publishes (any
venue, under All venues), from one `GET /lenses/options` reading shared by every block;
Bundle always offers both forms.

- **Grain** offers *Any*, *Only &lt;grain&gt;*, and for an include *Prefer &lt;grain&gt;*. **Bundle**
  offers the same over *per Instrument* and *Market Bundles*. Turning an include into an exclude drops
  a preferred form, and turning it back restores it if nothing else changed.
- **Markets** and **Datasets** are typed to narrow the list, each choice a pill. A dataset and its
  variant are one choice, `klines (1m)`, with `klines (any)` for every variant where there are several
  and `(default)` for the data with no variant. Pointing at a market names the venues that publish
  anything in it; pointing at a dataset names the markets of each venue that publishes it.
- A dimension left alone shows **All** (markets, datasets), **Any** (grain, bundle) or **Open** (a
  month), never a blank.

**A rule is stored on its own.** *Add rule* puts a draft on the page, outlined in yellow until it is
confirmed; editing it sends nothing. **Confirm** stores the lens with that rule; **Drop Rule** stores
it without a rule already stored; **Discard** throws a draft away and **Revert** takes an edited rule
back to what is stored. Only the rule confirmed is sent: other drafts stay drafts, and an unsaved name
or note stays unsaved. **Save** is for the name and the note.

**A new lens is the page's until it is first stored.** *New Lens* asks for a name, an address (the
slug) and what it is for, and opens it; nothing reaches the catalog until Save or the first Confirm.
There is one unsaved lens at a time: naming another replaces it, after asking.

**The catalog decides what can be stored.** A confirm the catalog refuses comes back with its
problems, each shown on the field of the rule it names, and the rule stays a draft. A problem about no
particular rule is shown above the blocks; a refusal with no problems is shown as the request's
failure. What is refused is in [CATALOG-LENSES.md](../modules/CATALOG-LENSES.md#what-is-refused).

**The saved lens carries what it costs**: its size, from `GET /lenses/:slug/size`, asked again thirty
seconds after each answer and at once after every confirm, drop or clear, and every two seconds while
the catalog reports the lens `updating` (shown as *Updating…*). Under it, a bar shows the share
already downloaded by weight, not by count: files run from kilobytes to gigabytes, so a count says
little about the wait. A draft is never sized here. What the figures mean is in
[CATALOG-LENSES.md](../modules/CATALOG-LENSES.md#what-a-lens-costs-and-how-far-along-it-is).

**A half-written lens survives a reload.** Drafts of rules, name and note are kept in `localStorage`
per lens, tagged with the version they were written from, so a lens saved somewhere else replaces them
rather than having stale edits revived on it. *Reload as saved*, beside Save, puts back what is stored
and drops every draft; it appears only while there is something to drop.

**Delete** removes the lens after asking.

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
