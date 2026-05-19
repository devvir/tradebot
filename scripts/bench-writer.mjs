/**
 * Bench script for the writer prototype service.
 *
 * Streams a CSV line-by-line, builds JSON-array batches, and POSTs them to
 * the writer service as fast as possible. Caps in-flight messages at
 * INFLIGHT_CAP — when reached, waits for one or more requests to ack
 * before sending more.
 *
 * Everything hardcoded. Run with:  node scripts/bench-writer.mjs
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const CSV          = '/home/x/bitmex/quote_20211204.csv';
const URL          = 'http://localhost:4000/write/quote';
const BATCH_SIZE   = 10_000;
const INFLIGHT_CAP = 200_000;

let inFlight       = 0;
let totalSent      = 0;
let totalAcked     = 0;
let errors         = 0;

let lastReportAt   = Date.now();
let lastReportAcked = 0;

let waiters = [];

const waitForCapacity = () => {
  if (inFlight + BATCH_SIZE <= INFLIGHT_CAP) return Promise.resolve();

  return new Promise(resolve => waiters.push(resolve));
};

const releaseWaiters = () => {
  while (waiters.length > 0 && inFlight + BATCH_SIZE <= INFLIGHT_CAP) {
    waiters.shift()();
  }
};

const send = async (docs) => {
  inFlight += docs.length;

  try {
    const res = await fetch(URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(docs),
    });

    if (! res.ok) {
      errors++;
      console.error(`[bench] HTTP ${res.status}: ${await res.text()}`);
    } else {
      const body = await res.json();

      totalAcked += body.inserted ?? 0;
    }
  } catch (err) {
    errors++;
    console.error(`[bench] fetch failed: ${err.message}`);
  } finally {
    inFlight -= docs.length;
    releaseWaiters();
  }
};

const reportTimer = setInterval(() => {
  const now     = Date.now();
  const elapsed = (now - lastReportAt) / 1000;
  const delta   = totalAcked - lastReportAcked;

  console.log(
    `[bench] sent=${totalSent}  acked=${totalAcked}  inFlight=${inFlight}  errors=${errors}  +${delta} in ${elapsed.toFixed(1)}s  =  ${Math.round(delta / elapsed)}/s`,
  );

  lastReportAt    = now;
  lastReportAcked = totalAcked;
}, 5_000);

const stream = createReadStream(CSV);
const lines  = createInterface({ input: stream, crlfDelay: Infinity });

let header = null;
let batch  = [];

console.log(`[bench] starting  csv=${CSV}  url=${URL}  batch=${BATCH_SIZE}  inflightCap=${INFLIGHT_CAP}`);

for await (const line of lines) {
  if (! header) {
    header = line.split(',');
    continue;
  }

  const fields = line.split(',');
  const doc    = {};

  for (let i = 0; i < header.length; i++)
    doc[header[i]] = fields[i];

  batch.push(doc);

  if (batch.length >= BATCH_SIZE) {
    const toSend = batch;

    batch = [];
    totalSent += toSend.length;

    await waitForCapacity();
    void send(toSend);
  }
}

if (batch.length > 0) {
  totalSent += batch.length;
  await waitForCapacity();
  void send(batch);
}

while (inFlight > 0) {
  await new Promise(r => setTimeout(r, 100));
}

clearInterval(reportTimer);
console.log(`[bench] done  sent=${totalSent}  acked=${totalAcked}  errors=${errors}`);
