import type { Writable } from 'node:stream';
import { debug } from '../../../shared/ui/logger';
import type { Message } from '../types';

const plog = (msg: string): void => { debug(`[${new Date().toISOString()}] ${msg}`); };

/**
 * Consume `source` and write each message's rows as CSV lines to `out`.
 * Each batch is concatenated to one `out.write()` call so back-pressure
 * pauses the producer cleanly on `'drain'`.
 */
export async function write<T extends Message>(
  source: AsyncGenerator<T[]>,
  out:    Writable,
): Promise<{ written: number }> {
  let written = 0;

  for await (const batch of source) {
    if (batch.length === 0) continue;

    written += batch.length;

    plog(`[WRITE] batch: ${batch.length} msgs | total written: ${written}`);

    await flushBatch(out, batch);
  }

  return { written };
}

async function flushBatch(out: Writable, batch: Message[]): Promise<void> {
  const lines: string[] = [];

  for (const msg of batch) {
    for (const row of msg.rows) {
      lines.push(row);
    }
  }

  const data = lines.join('\n') + '\n';

  if (! out.write(data)) {
    await new Promise<void>(resolve => out.once('drain', resolve));
  }
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_flushBatch = flushBatch;
