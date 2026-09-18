import { setDefaultAutoSelectFamily } from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';
import { connectionsAtMost, deliver } from './deliver';
import { fault } from './faults';
import { cacheLookups } from './lookup';
import type { Parcel, Receipt } from './types';

/**
 * Carries requests for the main thread: parcels in, receipts out. See
 * `transport.ts`.
 *
 * **Happy eyeballs off here too**, since a worker has its own copy of the
 * default the main thread turns off — see `index.ts`.
 */
setDefaultAutoSelectFamily(false);

/** Names are looked up once per host, not once per connection — see `lookup.ts`. */
cacheLookups();

connectionsAtMost((workerData as { connections: number }).connections);

let outbox: Receipt[] = [];
let scheduled = false;

/** Answers go back together, as soon as the task that settled them ends — see `schedule` in `transport.ts`. */
const answer = (receipt: Receipt): void => {
  outbox.push(receipt);

  if (scheduled) return;

  scheduled = true;

  queueMicrotask(() => {
    scheduled = false;

    const receipts = outbox;

    outbox = [];
    parentPort!.postMessage(receipts);
  });
};

parentPort!.on('message', (parcels: Parcel[]) => {
  for (const { id, url, read } of parcels)
    deliver(url, read).then(
      carried => answer({ id, carried }),
      err     => answer({ id, fault: fault(err) }),
    );
});
