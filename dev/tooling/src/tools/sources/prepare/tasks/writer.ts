import { debug } from '../../../../shared/ui/logger';
import type { Writer } from '../../writer';
import type { Message } from '../../types';
import type { Overflow } from '../overflow';
import type { PreparedMessage } from '../types';

const plog = (msg: string): void => { debug(`[${new Date().toISOString()}] ${msg}`); };

/**
 * WRITE — consume the post-DEDUP stream, route in-day messages to `writer`
 * and out-of-day messages to `overflow.add()`.
 *
 * Day membership: `message.date.slice(0, 8) === groupDay`. The exchange
 * timestamp is irrelevant — file naming across all sources is reception-time
 * based.
 *
 * In-day messages within a batch are flushed in one `writer.writeMessages()`
 * call; the writer's promise chain serialises ordering while the call returns
 * immediately, allowing this loop to keep consuming from DEDUP without
 * blocking on disk I/O.
 *
 * The writer's `.tmp` → rename dance is the orchestrator's responsibility,
 * not WRITE's.
 */
export async function write(
  source:   AsyncGenerator<PreparedMessage[]>,
  groupDay: string,
  writer:   Writer,
  overflow: Overflow,
): Promise<{ written: number; overflowed: number }> {
  let written    = 0;
  let overflowed = 0;

  for await (const batch of source) {
    const inDay:     Message[] = [];
    let   batchOver: number    = 0;

    for (const msg of batch) {
      if (msg.date.slice(0, 4) + msg.date.slice(5, 7) + msg.date.slice(8, 10) === groupDay) {
        inDay.push({
          rows:      msg.rows,
          date:      msg.date,
          action:    msg.action,
          timestamp: msg.timestamp,
        });

        written++;
      } else {
        overflow.add(msg);
        overflowed++;
        batchOver++;
      }
    }

    if (batchOver > 0) {
      plog(`[WRITE:overflow] batch: ${batchOver} msgs | total overflow: ${overflowed}`);
    }

    if (inDay.length > 0) {
      plog(`[WRITE] batch: ${inDay.length} msgs | total written: ${written}`);

      await writer.writeMessages(inDay);
    }
  }

  return { written, overflowed };
}
