# elastic-queue

A dynamically-sized FIFO queue where overflow exits rather than rejects. Optionally orders items by a numeric `counter` property and filters stale items at the exit point. Designed for scenarios where you need to buffer items while waiting for something, then switch to live processing without losing or duplicating any item.

Zero dependencies. TypeScript-native with real private fields (`#`).

## Install

```sh
npm install @devvir/elastic-queue
```

## The basics — a bounded FIFO

At its core, elastic-queue is a FIFO where you set a maximum size and provide a function that receives items when they leave the queue. New items always enter. When the queue is over capacity, the oldest item exits — through your function.

```ts
import { Queue } from '@devvir/elastic-queue';

const q = new Queue<{ id: string }>(
  item => console.log('exited:', item.id),  // exitFn
  3,                                         // size
);

q.push({ id: 'a' });
q.push({ id: 'b' });
q.push({ id: 'c' });
// queue is full, nothing exits yet

q.push({ id: 'd' });
// 'a' exits → logs: exited: a
```

All three constructor arguments have defaults, so a zero-config queue accumulates up to 1000 items silently:

```ts
const q = new Queue(); // exitFn=noop, size=1000, counter=0
```

## Dynamic sizing

You can change the size at any time. Reducing it flushes the excess immediately — oldest items exit first, in order, through the current `exitFn`.

```ts
const received: string[] = [];
const q = new Queue<{ id: string }>(item => received.push(item.id), 5);

q.push({ id: 'a' });
q.push({ id: 'b' });
q.push({ id: 'c' });
q.push({ id: 'd' });
q.push({ id: 'e' });

q.size = 3;
// 'a' and 'b' exit immediately
// received → ['a', 'b']
```

Growing the size simply creates more headroom — no items move.

## Switching exitFn and size atomically

`update()` lets you change `exitFn`, `size`, and the counter threshold (covered below) in a single operation. Any argument you omit keeps its current value. The flush happens once, after all values are updated.

```ts
const q = new Queue<{ id: string }>(undefined, 5); // accumulates silently

q.push({ id: 'a' });
q.push({ id: 'b' });
q.push({ id: 'c' });

// Switch to active processing and shrink at the same time
q.update(item => process(item), 2);
// 'a' exits → process({ id: 'a' })
// queue now holds ['b', 'c']
```

## Optional: counter-based ordering

If your items carry a numeric `counter` property, the queue sorts them on insert. This keeps the exit order correct even when items arrive out of sequence — common in networked streams where delivery order isn't guaranteed.

```ts
const out: number[] = [];
const q = new Queue<{ counter: number }>(i => out.push(i.counter), 3);

q.push({ counter: 10 });
q.push({ counter: 5  }); // arrives late, inserted before counter=10
q.push({ counter: 15 });
q.push({ counter: 20 }); // overflow: counter=5 exits first (it's the oldest)

// out → [5]
// queue holds [10, 15, 20]
```

Without a `counter` property items append in push order (standard FIFO), so the feature is strictly opt-in.

**Trade-off**: ordering is guaranteed for items inside the queue. Once an item exits, a lower-counter item arriving later will insert correctly but can no longer precede what already left. You cannot have both ordering guarantees and timely dispatch — that's an inherent property of bounded buffers, not a limitation of this library.

## Optional: counter-based filtering

When an item exits the queue, its counter is compared against a threshold. Items below the threshold are dropped silently; items at or above are forwarded to `exitFn`. The threshold defaults to `0`, so by default everything passes.

This is useful when you know that items below a certain point are already accounted for (e.g. included in a snapshot) and should not be re-processed.

```ts
const out: number[] = [];

// Only forward items with counter >= 10
const q = new Queue<{ counter: number }>(i => out.push(i.counter), 2, 10);

q.push({ counter: 7  }); // fills queue
q.push({ counter: 15 }); // overflow: counter=7 exits, 7 < 10 → dropped

// out → []

q.push({ counter: 20 }); // overflow: counter=15 exits, 15 >= 10 → forwarded

// out → [15]
```

The `counter` threshold is readable and writable at any time:

```ts
q.counter = 20; // raise the bar; takes effect on the next flush
```

## The accumulate → stream pattern

This is where everything comes together. The pattern solves a common problem in real-time data systems:

> You need a consistent baseline (a snapshot), but the live stream is already running. You can't pause the stream while fetching the snapshot. How do you avoid gaps or duplicates?

The answer: start buffering immediately, fetch the snapshot, then replay only the items that arrived after the snapshot — and switch to live processing in one atomic step.

`stream(exitFn, counter?)` is shorthand for `update(exitFn, 0, counter)`. Setting size to `0` flushes everything queued so far and causes every subsequent `push` to exit immediately — the queue becomes a pass-through.

```ts
// 1. Start accumulating before you have a baseline
const q = new Queue<DeltaEvent>(); // noop exit, size=1000

// 2. Items keep arriving while you fetch your snapshot asynchronously
incomingStream.on('data', event => q.push(event));

// 3. Snapshot arrives — it covers everything up to counter N
const snapshot = await fetchSnapshot();
applySnapshot(snapshot);

// 4. Switch to streaming in one call:
//    - flushes buffered items, dropping any with counter < N (already in snapshot)
//    - forwards items with counter >= N (the gap between snapshot and now)
//    - every subsequent push exits immediately through the same filter
q.stream(event => applyDelta(event), snapshot.counter);
```

No items are lost. No items are applied twice. The transition is atomic — there is no moment where a push could slip between "flush the backlog" and "switch to live".

## API reference

### `new Queue(exitFn?, size?, counter?)`

| Argument | Type | Default | Description |
|---|---|---|---|
| `exitFn` | `(item: T) => void` | noop | Called when an item exits the queue and passes the counter filter |
| `size` | `number` | `1000` | Maximum items held; excess exits from the front |
| `counter` | `number` | `0` | Exit filter threshold; items below this are dropped |

### Methods

| Method | Description |
|---|---|
| `push(item)` | Insert an item in counter order (or at the end if no counter), then flush excess |
| `update(exitFn?, size?, counter?)` | Atomically update any combination of config values, then flush |
| `stream(exitFn, counter?)` | Sugar for `update(exitFn, 0, counter)` — flush everything and switch to pass-through mode |
| `flush()` | Manually trigger an exit pass — useful after external state changes |

### Properties

| Property | Type | Notes |
|---|---|---|
| `length` | `number` (read-only) | Current number of items in the queue |
| `size` | `number` (read/write) | Setting triggers an immediate flush |
| `counter` | `number` (read/write) | Setting triggers an immediate flush |

### Item type

Items must be objects. The `counter` property is optional. If present, it must be a number:

```ts
type Queued = { counter?: number };
```

Items without `counter` sort and filter as if `counter = 0`, which means they always pass the default threshold and maintain push order.
