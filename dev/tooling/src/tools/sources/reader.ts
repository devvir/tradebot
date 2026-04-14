import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { createCsvParser } from '@tradebot/utils';
import type { Message } from './types';

/**
 * Read the first raw line of a .csv or .csv.gz file.
 *
 * Used for the pre-pass header probe — we need the *literal* first line to
 * decide whether the file has a header row, before handing it off to the
 * parser. CSV headers never contain embedded newlines, so a line-based read
 * is safe here (unlike message records, which can span multiple lines via
 * quoted fields and MUST go through the CSV parser).
 */
export async function readFirstLine(filePath: string): Promise<string> {
  const raw    = fs.createReadStream(filePath);
  const stream = filePath.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  return new Promise((resolve, reject) => {
    rl.once('line', (line) => {
      rl.close();
      raw.destroy();
      resolve(line);
    });

    rl.once('error', reject);
    stream.once('error', reject);
  });
}

/**
 * Stream a sources CSV file as a sequence of parsed messages.
 *
 * `columns = true`     → the file has a header row; the parser consumes line 1
 *                        and yields records keyed by that header.
 * `columns = string[]` → the file has NO header row; the supplied columns are
 *                        used for record keying, and the first line is treated
 *                        as data (used after vault-recovery of the schema).
 *
 * Messages are produced by the same grouping rule vault uses: a record with a
 * non-empty `_date_` starts a new message; subsequent records with an empty
 * `_date_` are continuation rows in the current message.
 */
export async function* streamMessages(
  filePath: string,
  columns:  true | string[],
): AsyncGenerator<Message> {
  const raw      = fs.createReadStream(filePath);
  const byteSrc  = filePath.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  const parser   = createCsvParser(columns);

  byteSrc.pipe(parser);

  let current: Message | null = null;

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    const date      = (record['_date_']    ?? '').trim();
    const action    = (record['_action_']  ?? '').trim();
    const timestamp = (record['timestamp'] ?? '').trim();

    if (date) {
      if (current) {
        yield current;
      }

      current = { rows: [record], date, action, timestamp };
    } else if (current) {
      current.rows.push(record);
    }
    // Orphan continuation (no current message): drop. The vault reader does
    // the same — a continuation with no leading row has no home.
  }

  if (current) {
    yield current;
  }
}
