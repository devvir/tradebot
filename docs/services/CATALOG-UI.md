# Catalog UI

Catalog UI is a browser for what the catalog holds and a set of controls for
surveying it. Prospector establishes what every venue publishes and serves that
over HTTP; this renders it, and sends back the requests that change anything.

Everything it does follows from one rule: **it renders what the API said, and
adds nothing.** No reshaping, no defaults, no computed fields, no second opinion.
That is not modesty about scope — it is what makes the page worth having. A
question this cannot answer is a question the catalog cannot answer, and finding
that out costs a page load rather than an afternoon.

## What it is not

- **It does not hold state.** No database, no cache, no session. Reloading asks
  everything again, and two browsers open on it cannot disagree.
- **It does not compute.** Counts, spans, states and totals arrive finished. The
  page groups and filters what it was given — it never derives a figure the API
  did not state.
- **It does not know the venues.** Markets, datasets, variants and instruments
  are strings that arrive from the catalog, and adding a venue to prospector adds
  nothing here.
- **It does not decide.** Every button is one API call, and what that call means
  for a venue is worked out at the other end.

## Why there is a server at all

The page is static and could have been served from anywhere. It is served from a
small express process that also proxies, for two reasons that outlive the page.

**Prospector is meant to run wherever the link to the venues is good** — another
machine, another network. That is the whole point of it being an HTTP service
rather than a library. A page calling it directly works only while it happens to
be reachable from whichever browser is open, and stops the day the survey moves.

**And the token would otherwise travel with the browser.** Where `CATALOG_TOKEN`
is set, a page calling the catalog itself has to carry it — which means shipping
the secret in the bundle and sending it from wherever the page is open. Here it
stays on the server, added to each forwarded request, and the page never sees it.

CORS is a consequence of that arrangement rather than a reason for it: the
catalog sends no such headers today, so a browser could not call it across
origins anyway — but that could be changed, and it is not what decides this.

```
browser ── /api/catalog/* ──▶ catalog-ui ── x-catalog-token ──▶ prospector
        ── /api/hauler/*  ──▶            ──────────────────────▶ hauler
        ── /api/where     ──▶            (answers from its own config)
```

**The answer is handed back unchanged** — status, body and all. These services
answer a refusal with a sentence saying what was wrong with the request, and that
sentence is the most useful thing on the page when something is wrong, so it is
shown whole rather than replaced with "could not load".

**A missing hauler is absent, not broken.** A deployment surveying on one machine
and hauling on another may not be able to reach one, so `HAULER_URL` unset makes
`/api/hauler` answer `503` with a sentence, rather than a proxy to nowhere that
times out and reads as a bug.

**An unreachable service is a `502` naming the URL it tried.** Which of the two
is unreachable, and at what address, is the first thing anybody wants and the
thing a bare failure hides.

`/api/where` exists so nothing about the deployment is baked into the bundle: the
page asks where it is pointed and puts it in the header, so the same image serves
any arrangement of these services.

## The two sections

**Contents** is what the catalog holds; **surveys** is what is being done about
it. They answer different questions and change on different clocks — one is a
fact to read, the other a thing to act on.

Surveys is the default, because it is the one that changes. What the catalog
holds is still there tomorrow; whether anything is collecting it is the question
somebody opens this page to answer.

Routing is `location.hash`, parsed into `{ section, venue?, market? }`. Every
view is therefore a link somebody can send, which is all the routing this needs —
a router here would be a dependency that reimplements `location.hash`.

### Contents

Three depths, each a narrowing of the last: **venues**, then a venue's
**markets**, then one row per `(dataset, variant, grain)` a market publishes.

Filtering happens **in the page**, over the rows it already has — the catalog
answered the question once, and narrowing what is on screen is not another
question. Symbol lists are the exception in the other direction: they are asked
for behind a click rather than fetched with the page, because a venue can publish
thousands of instruments and almost every visit is about something else.

**Where a shape reaches and whether it is finished are two facts, and both are
shown.** `last` is the newest file the catalog has seen; `open` is whether it
still expects more — the same question prospector asks before generating a key.

They were one field once, with `last: null` meaning "still publishing", which
threw the measurement away to make the claim: every shape reported no end at all,
and a variant that stopped beside the one that replaced it was unreadable. That
is exactly what somebody reads this table to find — bybit's perpetual books are
`500,incremental` reaching 2025-08-20 and closed, `200,incremental` open, which
is what tells a reader to fetch both.

### Surveys

One row per venue, polled every ten seconds: a survey runs for hours and reports
nothing when it starts, so a view that loaded once would show a stale word for as
long as somebody left it open.

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
at*, *Walk completed at*, or *Not started yet* where no pass has ever run. It
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

#### The controls

**One button decides whether a venue is meant to be running**, and its word says
which of three things clicking it will mean:

| state | word | call |
|---|---|---|
| **not started** | Start | `POST /venues/:venue/surveys` |
| **paused** | Resume | the same call |
| walking, updating, waiting | Pause | `POST /surveys/pause` |

Pausing and starting are genuinely opposite and cannot be one request. *Starting*
and *resuming* are the same request — a pause keeps every cursor, so the catalog
has no separate resume verb to offer — so the word changes and the endpoint does
not. Two buttons would ask somebody to know that; one that says `Start` on a
venue surveyed for a month would be lying about what happens next.

**Resume carries less weight than Start**, though they are one call. A table of
paused venues is the ordinary sight here, and at Start's weight every row of it
reads as something demanding to be clicked. The venue nobody has ever asked for
is the one that wants noticing, so it keeps the filled tint and resuming gives up
the fill for an outline — same word, same colour, one step behind.

It gives up the fill and nothing else. Resume is the button most often *wanted*
on this page, and dropping it to no background at all buried the common action to
make room for the rare one.

**Update** brings the next update forward, and is disabled where it cannot act:
enabled for a venue waiting out its interval, and for one paused partway through
an update, which it resumes.

**Refresh** asks first — it drops a venue's run rows and walks the whole archive
again, the one control here that throws work away. It is **disabled entirely for
a venue that is not `listable`**: okx and bitget serve no listing, so their series
are declared rather than discovered and a re-walk has nothing to re-read. The
button would drop their run rows and walk nothing.

Both are disabled in place rather than removed, so that three buttons occupy the
same three positions on every row. Dropping one shifts the others and the column
stops reading as a column.

**A row is held while it is mid-change**, and that means two waits rather than
one. The request in flight is over in milliseconds; `stopping` — the loop told to
halt and not having noticed yet — lasts as long as the page it is on. Reading
only the first handed the buttons back while a pause was still taking effect, and
acting there asks a venue to stop for something that has already stopped it.

**A resumed update is reported as one.** Where the catalog answers `resumed`
rather than `started`, the page repeats that word: carrying on from cursors that
already exist is not the same as planning fresh scopes, however alike they look.

## How it is built

`web/` is the page — React and Mantine, built by Vite into `dist/web`, which
express serves as static files. `src/` is the server: config, the proxy, and
nothing else.

The types in `web/types.ts` are **mirrors of prospector's own**, not a model of
its own. A field added upstream appears here by being added to one of them, never
by this service learning to compute it.

`pnpm --filter @tradebot/catalog-ui dev` runs Vite against the built server on
`:8080`, so the page behaves in development exactly as it does in the container.

**Layout lives in the components, not here.** Column widths, badge treatment,
what is disabled when, why a rule beats Mantine's — those change with the design
and are argued beside the markup they act on. A document that has to be edited
for a padding is describing the wrong layer.
