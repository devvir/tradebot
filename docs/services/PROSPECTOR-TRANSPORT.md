# Prospector: pacing and transport

How prospector's requests reach a venue: the gate every archive request passes, how cadence and
concurrency relate, what a refusal does, what is retried, how requests are carried off the main
thread, the network gate in front of all of it, and the separate path for a venue's own API. What
the requests are for is [PROSPECTOR.md](PROSPECTOR.md); what each venue tolerates, and the evidence
for it, is that venue's doc under [docs/venues/](../venues/).

## Pacing: one gate per venue per host

**A venue counts our requests to one address, so the limit is counted per venue per address.** The
walk, the archive mapping and the probe are three callers of one host, and a limiter belonging to any
one of them caps a fraction of the traffic while the host meters all of it. So every request to a
venue's archive passes one `Pace`, held for the life of the process and keyed by the adapter's label
(the venue, plus its `host` where one venue has two adapters, as bybit has) and the URL's host —
`paceFor` in `pace.ts`. **Two venues behind one endpoint are two budgets**: binance and gate are both
listed at `s3-ap-northeast-1.amazonaws.com`, one bucket each, and a limiter keyed by the host alone
would pace both by whichever reached it first. Calls to a venue's own API are not paced here at all —
see *[asking a venue about itself](#asking-a-venue-about-itself)*.

**A venue is listed and probed at one address.** `base` in the `venue` table is that address, with
`key_root` the prefix every key shares, and every lookup of a venue's gate asks at `base`. Where a
venue's bucket answers directly, `base` is the bucket and not a CDN in front of it — a CDN can answer
a listing plausibly and wrongly, and can ban at rates the bucket behind it takes without a refusal.
Other addresses that serve the same files under the same keys are recorded beside it, in
`alternative_hosts`, a JSON array of bases; nothing here asks them. Which address each venue is
listed at is in [PROSPECTOR-VENUES.md](PROSPECTOR-VENUES.md#venue-by-venue).

**The gate is inside the fetch.** `send` in `http.ts` is the one function every archive request goes
through — `fetchPage` for a listing page, `fetchHead` for a probe — which makes it the only place a
limit can be complete. It waits first for the [network gate](#the-network-gate-is-tuned-for-this-service-not-taken-as-it-comes),
then for the venue's slot. Putting it there also brings the retry ladder inside the count: a call
that retries five times is five requests the venue sees, and a gate wrapped around the call instead
of inside it would let those go out at five times the cap — at exactly the moment a venue is already
unhappy.

The counter is a **sliding second**: the times requests went out, with anything older dropped. A
request goes when fewer than `perSecond` of them fall inside the last second, and otherwise waits
exactly as long as it takes the oldest to fall out. The check and the claim happen in the same tick,
so two lanes cannot both see one free slot and both take it.

**Cadence layers**: a built-in default (`STEADY` in `pace.ts`, 100 a second with 100 in flight), and
over it the venue's adapter, which declares its own `pacing` beside a pointer to the venue doc that
holds the evidence for it. Every venue surveyed today declares one. A venue still on the default is
one nobody has had a reason to measure, not one that was measured and found generous.

**The rate is not configurable, deliberately.** What a venue tolerates is a fact about that venue and
does not change because the client moved to a host with more bandwidth, so it belongs beside the
evidence for it rather than in an environment file. What *is* local is how many requests this machine
will hold open at once — and that cannot outrun the venue's rate, only fail to reach it.

## Cadence and concurrency

**Cadence and concurrency are different things, and only one of them is a limit.** A venue budgets
requests per second; concurrency sets a rate only by accident, multiplied by whatever latency happens
to be that day. So the rate is capped directly.

`perSecond` is the cadence — the figure a venue would object to. It lives in the adapter beside the
evidence for it, and nothing in the environment can raise it.

`concurrency` is not a limit at all. It is how many requests may be in flight so that the cadence
can actually be reached: at one at a time, 100/s is unreachable whatever the gate allows, because a
request spends most of its life waiting. It cannot breach the cadence either, since every request
passes that gate regardless — which is why a venue's `concurrency` is a ceiling rather than a target,
and a venue yielding fewer scopes simply uses fewer lanes.

**So the figure that reaches a cadence is the cadence times how long one request takes**, and below
it the venue is held by concurrency rather than by its limit. The time that matters is a *missing*
key's, because that is most of what an update asks and it is the slow one wherever a CDN fronts the
bucket: a cached file answers from the edge, a missing one goes to the origin.

**Probing is not paced separately.** A probe and a listing are the same thing to a host — one
request, one socket, one ticket — and both pass the same gate, so the count a venue sees includes
both. That the link is shared and something else may need it is what the machine-wide pool below
answers, for every caller at once.

**How many lanes a venue gets follows from the same figure.** A lane holds one request at a time, so
more of them than the venue's own `concurrency` is not parallelism but queueing, with a scope
held open behind each one. The count is therefore the adapter's number, capped by
`PROSPECTOR_CONCURRENCY` (`lanesFor` in `pace.ts`) — and it is also what the archive is split for, so
a venue is split for the lanes it will actually have. Since a scope is a serial chain, lanes are only
useful where there are scopes to give them ([PROSPECTOR-WALK.md](PROSPECTOR-WALK.md#2-walk-each-scope)).

The limit on concurrency is therefore our own resources rather than the venue's: S3 documents 5,500
GET/HEAD per second per prefix, which nothing here approaches.

### A limit opens gradually rather than all at once

`concurrency` is for keeping the pipe full while answers are outstanding, not for arriving in a
single instant: a host that serves 100/s sustained can still refuse to be met with 100 sockets in the
same millisecond, leaving every one unanswered until it dies on its own deadline. So a fresh limiter
allows a tenth of its figure in the first second and a further tenth each second after, reaching the
full number at nine. A limit of four or fewer has no burst to guard against and opens whole.

The ramp starts again when a stand-down lifts, which is the moment it matters most: every lane held
by a pause wakes within an instant of the same moment, and the venue that just refused us is the
last one to meet with everything at once. While the limit is still opening, a waiting lane is woken
by the clock rather than by a departure — a rising limit moves on its own, and a lane parked on the
queue would otherwise sleep through every step until something happened to finish.

### The machine-wide ticket pool

**Our own resources are shared, and no adapter can see that.** Every venue's figure can be
individually right while their sum is wrong: each adapter declares its cadence and concurrency beside
its evidence, and the sum of those concurrencies is more than one machine can hold open at once.
Summed, they come back as connect timeouts on venues doing nothing unusual, at the moment the others
are busiest. A limit that lives in an adapter cannot catch this, because the number that is wrong is
one no adapter knows.

`PROSPECTOR_CONCURRENCY` is that number. It is a **pool of tickets**, not an allocation: a
request takes one before going out and returns it when it is answered, and the pool neither knows
nor cares which venue is asking. There is nothing to divide up and nothing to recompute when a
venue starts or finishes.

**The pool opens gradually, by work done.** It starts at 100 and grows by 100 for every 1,000
requests answered until it reaches `PROSPECTOR_CONCURRENCY`, and starts over from 100 whenever the
network gate lets go of what it held. A start or a release sends every venue at once, and every
request over HTTP/1.1 is a connection and a TLS handshake on a transport worker's one thread; a
worker opening hundreds at once falls far enough behind that bodies already arriving read as silent
(measured 2026-10-01). Growing only as earlier requests are answered opens connections as fast as the
venues can serve them. Each venue's own limit still opens by the clock as well.

The two limits compose without either knowing about the other:

- a venue at **its own** `concurrency` does not ask for a ticket at all, so it never sits on one
  while waiting for itself
- a venue that wants more waits in one **first come, first served** queue with everyone else
- a venue surveying **alone** is bounded only by its own figure, because nothing else is holding
  tickets

Order matters and is the same everywhere: the venue's slot is taken first, the ticket second. The
other way round, a lane blocked on its own venue would be sitting on the scarcer of the two for the
sake of the looser one. A ticket is held across the cadence wait rather than surrendered, because
lanes released together would otherwise fire together — which is the burst `perSecond` exists to
prevent.

None of that trades correctness or politeness for speed: what is retried, and what is an answer, is
*[the retry ladder](#the-retry-ladder)*.

## A refusal aimed at us stops the venue

**A refusal aimed at a key does not.** S3 declines one object and says so, with an `x-amz-error-code`;
a CDN turning us away serves its own error page naming no key. So `blocked` in `http.ts` reads a
reply as a refusal aimed at us when the adapter's `refusesUs(status, headers)` says so, and, where the
adapter has no such rule, when it is a `403` or `429` without `x-amz-error-code`. The default leans
that way because that is the direction where being wrong is cheap: a stood-down venue costs minutes,
a banned address costs the venue. A venue whose bucket answers `403` for every key it does not hold
says otherwise in `refusesUs` — see [bitget](PROSPECTOR-VENUES.md#bitget).

**A refusal is an answer, and is never retried.** A ban lapses only while nothing is asking, so
slowing down is not a remedy, and the ladder would spend four more requests confirming what the first
established.

**Five in a row stand the venue down.** After `REFUSALS_BEFORE_BLOCK` (5) refusals with no other
answer between them, the venue's gate stops every caller at once, including the lanes already waiting
for a slot — nobody has to be told, and nobody gets to keep asking. Any other answer resets the count,
and a refusal below five is logged and nothing more: one bad reply is far more often an edge having a
bad second than a venue objecting, while a real block fails every lane in flight within a fraction of
a second and reaches five at once. A pause does not reset the count either, so a refusal after it,
before any other answer, stands the venue down again at once.

**The pause doubles while the venue keeps refusing.** The first is the venue's `standDownMs` (two
minutes in `STEADY`, which no adapter overrides), each further one twice the last, up to `ceilingMs`
(thirty minutes). It is one pause per round rather than one per refusal: a refusal that arrives while
a pause is in force belongs to that round, because every lane in flight fails at roughly the same
instant and counting each of them would reach the ceiling in milliseconds. The doubling is forgotten
at the first answer that comes 30 minutes or more after the last stand-down began (`EASE_AFTER_MS`).

A pass that meets a stand-down ends on it, unreconciled and open, and the venue's loop takes it up
again once the pause lapses.

### What the rates say

**The rate at the moment of a block is logged, because nothing else measures it.** No venue publishes
a rate-limit header, so the only evidence about where a limit sits is what was going out when it was
hit — and a per-pass average is the wrong number for that by construction, since it counts every
second spent paused. The gate reports the last second, the last five and ten, the busiest second so
far, what is in flight and the lifetime total, and those go into the block warning and the walk's
refusal line.

**A steady pass is read on different numbers, so the heartbeats carry different ones.** Ten seconds
says where the window landed rather than how the survey is going: on a venue that stands down, it
reads as a collapse whenever a pause falls inside the window and as full speed whenever one does not.
A survey running for days is judged over a minute and an hour instead — counted in a ring of
per-second and per-minute counters, because an hour of timestamps at these rates is millions of
numbers held to answer one log line, and averaged over the time actually elapsed so that a process
two minutes old does not report an hourly rate a thirtieth of the truth.

Retries are reported there as a **share of everything sent**, not a count: five hundred is a healthy
afternoon at a thousand a second and a venue falling over at ten. They are counted where the retry
ladder turns rather than inferred by subtracting answered from sent — those two figures are kept on
different scopes, one per pass and one per host since the process started, so their difference is
mostly in-flight requests rather than retries.

## The retry ladder

`fetchPage` and `fetchHead` make up to five attempts. A transport error, a deadline, a `5xx`, a `429`
that is not a refusal aimed at us, and — for a listing — a success whose body is not a listing are
tried again, after a full-jitter exponential wait (500 ms doubling, capped at 30 s) so that lanes
backing off together do not come back together. Every other status is an answer and is not
retried: a `404` or a `403`, and a refusal aimed at us least of all. A listing whose transfer was
refused — a redirect off its host, or a body past its ceiling (see [carrying
requests](#carrying-requests)) — fails at once, since the same request gets the same reply.

**A `Retry-After` is obeyed exactly as sent instead, up to the venue's `ceilingMs`.** Within that a
venue is the authority on its own pace, and shortening the wait it asked for is how a 429 becomes a
ban; the wait is logged when it starts and every minute it lasts. **A `Retry-After` longer than
`ceilingMs` stands the whole venue down for `ceilingMs`** — the longest this venue is ever left alone —
and fails the request as a stand-down rather than sleeping in it; the pass ends on it as it does on a
block, and the next request after the pause asks again.

**Every wait ends on a stop.** The backoff between attempts and a venue's `Retry-After` alike are
bound to the pass in progress, so a pause or a halt ends them within a quarter of a second; the
request is left owed, and nothing is known about what it asked for.

Above the ladder, a listing page that still fails is asked again from its cursor before its scope is
given up on ([PROSPECTOR-PASSES.md](PROSPECTOR-PASSES.md#a-job-closes-only-when-every-scope-did)), and
a probe that still fails leaves its row in `wip` for the next round.

## Carrying requests

**Archive requests are sent from worker threads.** One thread decides what to ask and writes
what comes back to the catalog, and SQLite has to stay on it: a transaction belongs to one connection,
and one connection to one thread. A request is a question in and an answer out with nothing shared,
so it is the part that moves. Measured 2026-09-30 with every venue backfilling, the main thread ran at
96% or more with a fifth of it on sockets, TLS and reading listings.

**One worker per 1,000 requests the machine may have in flight**, so raising
`PROSPECTOR_CONCURRENCY` brings the workers to carry it. What loads a worker is requests a second: a
probe takes ~0.25–0.3 s, so 1,000 in flight is ~3,300–4,000 a second, and one worker carried ~2,300 a
second alongside every other venue's walk on under half a core (2026-09-30). Requests are dealt to
the workers in turn; each keeps its own connections. A worker that exits fails what it held, as a
transport error the ladder retries, and is replaced after a wait that doubles from a second to a
minute while replacements keep dying young; after five such exits in a row its slot is left empty. A
request with no worker to take it is carried on the main thread, as it is wherever the worker file
is not built.

**Only the transfer moves.** Whether a request may go, what its status means, whether it is retried
and whether a venue is refusing us are decided on the main thread, because they read and change state
every venue shares — see *[pacing](#pacing-one-gate-per-venue-per-host)*. The worker opens
connections, sends, and reads a body to its end or drops it; a slot is held until it has. **A listing
page is read there too**, into its keys and directories, so what crosses back is the reading and not
the megabytes it came from. Requests cross in batches, sent the moment the task that decided them ends
rather than on the next turn of the loop — on a thread this busy a turn is long, and a request waiting
for it waits that long before it has left.

**Open files are not a limit; opening connections is.** What fails is opening HTTP/1.1 connections in
bulk: measured 2026-10-01, past ~1,250 opened at once from this machine connects timed out and the
open ones were lost with them, and on loopback, with no network involved, 3,000 lanes opening at once
missed their deadlines by the hundred and reopened by the thousand — every one a TLS handshake on one
thread. Over HTTP/1.1 every request in flight is a connection, so `PROSPECTOR_CONCURRENCY` has to be
set below that figure (nothing enforces it), and the pool opens gradually — see *[the ticket
pool](#the-machine-wide-ticket-pool)* — so nothing ever asks for its whole width at once.

**Idle connections are kept, all of them.** HTTP/1.1 `HEAD`s go through agents that keep every idle
connection (`maxFreeSockets: Infinity`). Node's default keeps 256 per host, and a host with more lanes
than that would close and reopen connections between requests, each costing a TLS handshake. The
venue closes a connection it no longer wants.

**Names are looked up once per host, not once per connection.** Node keeps no answers of its own, and
inside the container every lookup goes to Docker's resolver on a pool of four threads: measured
2026-10-01, 40 lookups at once took 0.3 s and 1,000 took 5.4 s — and a connection's deadline counts its
lookup. So each thread answers lookups from memory for a minute, with one real lookup per host at a
time; a failed refresh keeps the last answer. A host's addresses are handed out in turn within the
family the resolver put first, since the container has no IPv6 route and one host answers with one
IPv4 address and eight IPv6 ones.

**A `HEAD` goes over HTTP/2 wherever the host speaks it.** Node's HTTP/1.1 client does not keep a
connection after a `HEAD` reply that states neither a length nor chunking, and that is how three hosts
answer a key they do not have — bitget, kucoin and bybit's order-book host. A probe for a missing file
therefore costs a connection and a TLS handshake: measured on bitget at 250 in flight, 9,000 sockets
were closing at once and a probe took 285–907 ms at the median. Over HTTP/2 a probe is a stream on a
connection that stays, and the same probes took ~235 ms, the venue's own time to say no. Whether a
host speaks it is asked once, by the TLS handshake. A server caps the streams one connection carries
— CloudFront at 128 — so each takes at most 100, and more are opened as needed. A stream the server
refuses was never processed, which HTTP/2 guarantees, so it is asked again at once on another
connection rather than through the retry ladder. A stream nobody answers in time takes its connection
out of use, since a connection can die without either end being told.

**Everything else is HTTP/1.1.** S3's own endpoints do not offer HTTP/2; a `HEAD` there goes over a
kept connection, never through `fetch`, which opens a new one after every `HEAD` — measured
2026-09-29, ~800 ms a probe against one round trip's ~270. A listing is a `GET` through `fetch`,
whose 15-second deadline is on the answer and whose body may take as long as it takes, so long as it
does not go silent for 10 seconds.

**A listing stays on its host and within its size.** Its redirects are followed one at a time and
checked first: only to `https`, only on the host that was asked, and at most five of them, all inside
the one deadline. A body is read to at most 64 MiB (`BODY_CEILING` in `deliver.ts`), far above any
real page — an S3 page holds at most a thousand keys and an index lists one directory. A redirect
anywhere else, or a body past the ceiling, is refused as a failed transfer; a refused redirect is
logged with where it pointed.

**Happy eyeballs is off in both threads.** Node's default gives each resolved address 250 ms before
trying the next. The endpoint binance and gate are listed at, `s3-ap-northeast-1.amazonaws.com`, is
~260 ms away and answers with eight addresses, so every new connection there abandoned seven attempts
just short of their reply and took ~2 s; with it off, a new connection takes one round trip. The
default is per thread, so the worker sets it too.

**S3 asks for a slower pace with a `503`**, which the ladder retries with backoff, so a limit a bucket
has and nobody has reached shows as a pass slowing down rather than losing anything; a refusal naming
no key stands the venue down like any other.

## The network gate is tuned for this service, not taken as it comes

`@devvir/netgate` watches the network on its own and holds every archive request while it is
unusable, so that an outage is established once instead of being rediscovered by each of hundreds of
lanes through its own retry budget. `send` waits on it before the venue's own gate; a request held there
spends no attempt. Its defaults assume a probe answers quickly because the caller's own requests do.

**That assumption does not hold here, and the defaults would make the gate measure this service
rather than the network.** A venue is walked on hundreds of lanes at once; at a thousand in flight,
throughput settles near 300 a second, which is a mean above three seconds per request — for the
requests that *succeed*. Against the library's three-second deadline the gate's own probes time out
while the link is carrying everything else without a stutter: what it measures then is the contention
this service creates. It is the same effect as the summed per-venue limits above: the number that is
wrong is one no component can see alone.

So the deadline is set past what this service's own traffic costs, and the evidence widened to
match — a probe here has to answer whether the network is *unusable*, and slower than a browser is
not that (`configure` in `index.ts`):

| setting | here | library default |
|---|---|---|
| `timeoutMs` | `10000` | `3000` |
| `window` | `12` | `6` |
| `degradeAt` | `3` | `2` |
| `closeAt` | `6` | `4` |

The gate samples every five seconds, so twelve samples are a minute: two failures in thirty seconds,
which the defaults act on, is a blip here, and three in a minute is a pattern. The higher deadline
costs nothing in detection speed because the probes are asked together rather than in turn — a
sample is one round trip however long the list is. When the gate lets go of what it held, the ticket
pool opens gradually again.

## Asking a venue about itself

An archive is a bucket that answers a key. A venue's API is a web service with its own limits, its own
throttling, and its own habit of returning a refusal inside a `200` — okx does exactly that. It also
sits outside the pace gate the archive's host is held to, because it is not that host.

So there is one hardened fetcher for it, shared. It carries two clocks — one bounding the wait for a
reply, dropped the moment headers arrive, and one bounding *silence* once a body has started, so a
megabyte of instruments is welcome to take its time while a stopped download fails promptly. It
retries transport faults, reads the body inside the retry so a truncated one is retried rather than
thrown, and lets a venue say what a refusal-inside-a-success looks like.

It is `fetchJson` in `metadata.ts`, and every adapter's instrument listing goes through it.
`metadataGap`, a second and a half, is there for an adapter to space consecutive calls with. bitget's
archive-name search is a `POST`, which `fetchJson` does not speak, and is a bare `fetch` with a
timeout. None of these passes the pace gate, a ticket or a transport worker: they run on the main
thread, and they are not counted in a job's `asked` or `sent`.
