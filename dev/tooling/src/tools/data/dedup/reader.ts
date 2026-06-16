import path from 'node:path';
import { createReader } from '@devvir/zipper';
import { debug } from '../../../shared/ui/logger';
import type { Message } from '../types';

const BATCH_SIZE = 20_000;

const plog = (msg: string): void => { debug(`[${new Date().toISOString()}] ${msg}`); };

/**
 * Stream a `.csv.gz` source file as `Message` batches in native `_date_` order.
 *
 * Groups consecutive CSV lines into messages: a line whose first character is
 * not `,` starts a new message; lines starting with `,` are continuations.
 * The first line is dropped only when it is a header row (starts with `_date_`);
 * a source that opens straight on data keeps its first message. Orphan
 * continuation lines (no message in flight) are silently dropped.
 *
 * `action` is extracted from column 1 (always a metadata field, no commas).
 * `timestamp` is left null — dedup does not use it.
 */
export async function* read(filePath: string): AsyncGenerator<Message[]> {
  const name   = path.basename(filePath);
  const reader = createReader(filePath);

  let current:     string[] | null = null;
  let sawHeader    = false;
  let totalYielded = 0;
  const batch:     Message[] = [];

  plog(`[READ] start: ${name}`);

  // `reader.lines()` destroys its own decompression stream in a finally; the
  // outer finally additionally closes the reader so the pigz-backed stream is
  // released per file — without it, the streams pile up across a multi-file run.
  try {
    for await (const line of reader.lines()) {
      if (! line) continue;

      if (! sawHeader) {
        sawHeader = true;

        if (line.startsWith('_date_')) continue;
      }

      if (line.startsWith(',')) {
        if (current) current.push(line);
        continue;
      }

      if (current) {
        batch.push(buildMessage(current));

        if (batch.length >= BATCH_SIZE) {
          totalYielded += batch.length;
          plog(`[READ] ${name}: batch ${batch.length} msgs | total ${totalYielded}`);
          yield batch.splice(0);
        }
      }

      current = [line];
    }

    if (current) batch.push(buildMessage(current));

    if (batch.length > 0) {
      totalYielded += batch.length;
      plog(`[READ] ${name}: final batch ${batch.length} msgs | total ${totalYielded}`);
      yield batch;
    }

    plog(`[READ] ${name} done — ${totalYielded} msgs`);
  } finally {
    await reader.close();
  }
}

function buildMessage(lines: string[]): Message {
  const first       = lines[0]!;
  const firstComma  = first.indexOf(',');
  const secondComma = first.indexOf(',', firstComma + 1);

  const date   = first.slice(0, firstComma);
  const action = secondComma === -1
    ? first.slice(firstComma + 1)
    : first.slice(firstComma + 1, secondComma);

  return { rows: lines, date, action, timestamp: null };
}
