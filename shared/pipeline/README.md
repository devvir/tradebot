# @tradebot/pipeline

The pipeline's shared language: what each stage tells the next about where it has got to.

Every stage has to publish its progress, and left alone each invents a format — a TSV of month
closings here, positional columns there, hundreds of megabytes of JSONL somewhere else. A consumer
then learns a format, a grain and a set of conventions per producer. One shape means **a new
collector arrives already legible**.

```ts
import { FactManager } from '@tradebot/pipeline';

const facts = new FactManager({ owner: 'stocker', root: '/data/shared/facts' });

facts.record({ topic: 'vault', venue: 'bitget', period: '202008', market: 'perp',
               symbol: 'ADAUSDT', dataset: 'klines', subject: '1m',
               fact: 'built', value: new Date().toISOString() });

// What can I normalise? — the same query whoever answered it
facts.find({ topic: 'archives', venue: 'gate', fact: 'complete' });
```

## One row is one fact

| column | example | |
|---|---|---|
| `topic` | `archives` | the **tree** the fact is about |
| `venue` | `bitget` | |
| `period` | `202008` | see [Period, not month](#period-not-month) |
| `market` | `perp` | blank where the topic has no such dimension |
| `symbol` | `ADAUSDT` | ” |
| `dataset` | `klines` | ” |
| `subject` | `1m` | free text, **owner-shaped** |
| `fact` | `built` | free text label — what is being asserted |
| `seq` | | blank for state, set for [occurrences](#some-facts-are-additive) |
| `value` | `2026-08-09T11:39:49.873Z` | |
| `meta` | `{…}` | the owner's private state, skipped unless asked for |
| `createdAt` / `updatedAt` | | always kept, always free |

The primary key is everything from `topic` through `seq`.

**Columns are for what the whole pipeline shares and filters on equality.** venue, market, symbol
and dataset are that vocabulary even though no topic populates all of them — the archives leave
three blank, because trucker does not track the shape of each venue's tree and should not have to.

**`subject` is for what only the owner knows the shape of.** `1m` means something to klines in the
vault and nothing to anybody else, and a column per such thing is how a shared schema becomes one
service's schema with everyone else's fields left blank.

**`meta` is the owner's private state, and the owner may change its shape freely.** Nothing outside
needs to interpret it. `dev/tooling` reads it anyway — that is what tooling is for — and the
obligation that leaves on the owner is a design one rather than a compatibility one: be aware who
reads this and do not make their life stupid for no reason.

### A fact's existence is its truth; `value` carries when or what

`fact=complete, value=true` would throw away the closing time, and re-closure detection depends on
it. So `complete` carries when the month closed, and a month that is not complete simply has no row.

Re-stating a fact **updates it in place** — the key says so. No history is kept: the current value
is what consumers act on, and anything that needs to know whether the value moved stores the old one
itself. Retraction is a delete, and is meant to feel awkward.

### Period, not month

`2020`, `202008` or `20200815`. **The column is deliberately not called `month`**, because
everything being monthly is a fact about today rather than about the model — incremental collectors
are likely to be finer, and an annual roll-up is not far-fetched.

One column, prefix-comparable: a month is a prefix of its days and a year of its months. Which grain
a topic uses is the topic's business, and nothing here coerces one into another. Consumers own the
arithmetic; the store stays a lookup.

### Some facts are additive

A fact usually describes **state**: is this month complete, was this partition built. There is one
answer at a time and re-stating it replaces the old one.

A partition drifting from its inputs is not that. It **occurred**, it can occur again, and every
time it did is worth keeping — one that has drifted three times is saying something one that drifted
once is not. `append()` fills `seq` with the moment it happened, which makes otherwise-identical
keys distinct and orders them at the same time, with a counter breaking ties inside a millisecond.

That is the whole of it. State and occurrence are the same shape; only whether the key admits
repeats differs.

## Topics and ownership

A topic is the *tree* a fact is about, never the service that produced it — `archives` rather than
`trucker`, because a collector can be replaced and the tree it fills means the same afterwards.

```
archives → trucker      vault → stocker      rest, websocket → tooling
```

`FactManager` takes its owner at construction, because a service does not stop being itself while it
runs. Writing to a topic it does not own throws, and so does an unknown topic — a topic absent from
the map is a typo, not an experiment, and something written under a misspelling is invisible to
every consumer while looking perfectly fine to whoever wrote it.

**This is a mistake detector, not a security boundary.** There is no authentication between services
and none is wanted. Reads are open to everyone: a consumer needs no permission to find out where a
producer has got to — that is the entire purpose. The map doubles as the diagram of who produces
what.

### Subtopics carry the second layer

A topic can be namespaced — `vault:details`, `logs:vault`, `archives:bookkeeping` — and **the tree
is whichever segment names one, wherever it sits**. Ownership follows the tree, so a subtopic needs
no entry of its own.

What separates them is what a fact is *for*:

- **A topic** is data somebody will need. The contract.
- **`logs:`** is data we have at some moment and cannot practically fetch later. Kept because we
  have it, not because anyone asked.
- **Other subtopics** are specialisations. `vault:details` is the list of members per partition —
  real data with a real consumer, which simply does not belong in the row that answers *has this
  been built*.

**The namespace does the filtering**, which is what makes a marker column unnecessary: asking for
`archives` cannot return bookkeeping, because they are not the same topic and not even the same
database.

## Layout

```
<root>/archives.sqlite
       vault.sqlite
       vault.details.sqlite
       logs.vault.sqlite
```

**One database per topic**, which follows from one owner per topic: exactly one writer per file, and
readers are whoever turns up. It keeps the volumes apart too — `archives` is hundreds of rows about
months and `vault` is hundreds of thousands about partitions, and one should not pay for the other's
indexes.

The topic keeps its colon; the file it lives in does not, since a colon is legal in a filename and
awkward in a shell, a URL and half the tools that will ever look at this directory.

Databases open lazily, so a service that only reads `archives` never creates `vault.sqlite` by
asking a question. WAL is on, which is what lets a live service and a curious tool coexist.

Cross-topic queries are not expected. If one is ever wanted, the package can answer it without a
real join and consumers never learn where the line was.

## The API

Everything is synchronous, because `node:sqlite` is — wrapping it in promises would suggest a
concurrency that does not exist.

| | |
|---|---|
| `record(fact)` | state one fact, replacing what the same key said before |
| `recordAll(facts)` | many at once, in one transaction, all of one topic |
| `append(fact)` | state an occurrence — fills `seq` with the moment |
| `find(query, { meta })` | every fact matching a partial key |
| `stream(query, { meta })` | the same question, one row at a time |
| `distinct(field, query)` | the values one column takes |
| `value(key)` | one fact's value, or `null` when never stated |
| `forget(key)` | take one fact back |
| `forgetAll(query)` | take back a whole set |
| `close()` | |

**A query is a partial key and an absent field matches anything**, so `{ topic, venue, fact }` asks
"every period this venue has this fact for" — nearly every real question, and why this is one query
shape rather than a set of named methods.

**`recordAll`'s transaction is the point, not the convenience.** 250,000 facts one statement at a
time is one fsync each; in a transaction it is one. It is also the only way a caller makes a set of
facts appear together, which matters when two of them are only true about each other. A batch may
not span topics, because that would span databases and there is no transaction across those.

**`meta` is left out unless asked for.** It is the largest column by far, and a consumer that did not
ask for it does not want to pay to carry it.

### `find` or `stream`

`find` materialises everything before the caller sees the first row, which is what almost every
caller wants: a bounded question, and an array is easier to hold than a cursor.

`stream` is for the ones that are not bounded. `vault:details` is one fact per partition *input* —
millions of rows and hundreds of megabytes of text, which becomes upwards of a gigabyte of objects
the moment it is an array, and stocker folds them straight into a map twenty times smaller.

**The rows must not be written to while `stream` is stepping.** SQLite will let a statement step
while the same connection rewrites the rows underneath it, and what happens then depends on which
index the planner chose — rows visited twice, or skipped, with nothing said. `find` is immune
because it has read everything before it returns. Read first then write, or page with a keyset
cursor over `find`.

### `forgetAll` is for replacing a set, not for tidying up

Some facts are only true together: the members a partition was built from are the whole truth about
that partition, so a rebuild's set **replaces** the previous one rather than joining it. Removing
them one at a time would mean knowing the old set in order to forget it, which is exactly what the
new set has made unknowable.

The query is the same partial key `find` takes, so what it deletes is what `find` would have
returned. That is the only shape safe to offer.

### Prefixes are ranges, never `LIKE`

```ts
facts.find({ topic: 'vault', prefix: { period: '2026' } });
```

SQLite's `LIKE` optimisation is narrow enough not to be worth relying on — measured against this
schema it did not fire even for an all-digit prefix, and `period LIKE '2026%'` scanned the venue and
filtered where `>= '2026' AND < '2027'` seeks. So `prefix` translates to a range itself and no
caller has to remember.

The upper bound is the prefix with its last character incremented, which is a reason to **compose
`subject` and `fact` deliberately**: a separator with room above it (`/` → `0`) makes every prefix
query an index seek, and choosing one costs nothing at the time and cannot be retrofitted cheaply.

## Two rules the schema enforces that are easy to get wrong

**Empty string, never `NULL`.** SQLite treats nulls as distinct in a unique index, so two archive
facts both leaving `market` unset would both insert and the key would protect nothing. `''` means
"this topic has no such dimension" and compares like any other value.

**`STRICT`**, because SQLite is otherwise dynamically typed and a declared `TEXT` column holds
whatever it is given — which surfaces as a query silently matching nothing, months later.

## Who states what

The facts themselves, and why each is shaped the way it is, belong to the services that state them:

- [STOCKER.md](../../docs/services/STOCKER.md) — `vault`, `vault:details`, `logs:vault`
- [TRUCKER.md](../../docs/services/TRUCKER.md) — `archives`
- [COLD-EVICT.md](../../docs/tooling/COLD-EVICT.md), [COLD-PUSH.md](../../docs/tooling/COLD-PUSH.md)
  — the tooling that reads them
