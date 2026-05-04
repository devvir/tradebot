import fs from 'node:fs';
import zlib from 'node:zlib';
import { rowToCsv } from '@tradebot/utils';
import type { Header, Message } from './types';

export interface Writer {
  writeHeader(header: Header): void;
  writeMessage(msg: Message): Promise<void>;
  writeMessages(msgs: Message[]): Promise<void>;
  writeRaw(lines: string[]): Promise<void>;
  close(): Promise<void>;
}

/** Create a no-op writer used during dry-run mode. */
export function createNullWriter(): Writer {
  return {
    writeHeader:   () => { /* no-op */ },
    writeMessage:  async () => { /* no-op */ },
    writeMessages: async () => { /* no-op */ },
    writeRaw:      async () => { /* no-op */ },
    close:         async () => { /* no-op */ },
  };
}

/**
 * Create a gzip-compressed CSV writer to the given output path.
 *
 * Records are serialized via the shared `rowToCsv` helper so the on-disk
 * bytes are indistinguishable from a vault-written file: fields are quoted
 * only when they contain `,`, `"`, or `\n`, and embedded quotes are doubled.
 *
 * Writes are non-blocking and ordered via a promise chain on the writer
 * (`writing`). Each `writeMessages` / `writeRaw` call queues onto the chain
 * — the caller's awaited promise resolves when its specific batch lands,
 * but the chain itself accepts the next call without waiting for the prior
 * one to flush. Drain (when the gzip buffer fills) is handled inside the
 * chain, never by blocking the producer.
 */
export function createGzipWriter(outputPath: string): Writer {
  const fileStream = fs.createWriteStream(outputPath);
  const gzip       = zlib.createGzip({ level: 6 });

  gzip.pipe(fileStream);

  let cols: string[] | null = null;

  /** Write a single line for the synchronous header path. */
  const writeLine = (line: string): boolean => gzip.write(line + '\n');

  const waitForDrain = (): Promise<void> =>
    new Promise(resolve => gzip.once('drain', resolve));

  /**
   * Promise chain serialising writes. Each enqueue chains onto `writing`;
   * failures are caught at the chain level so one bad write does not poison
   * subsequent calls. The first error is captured and re-thrown on `close()`,
   * so callers using fire-and-forget (`void writer.writeMessages(...)`) still
   * see the failure when they await close.
   */
  let writing:    Promise<void> = Promise.resolve();
  let firstError: Error | null  = null;

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const next = writing.then(work);

    writing = next.catch((err: unknown) => {
      if (! firstError) {
        firstError = err instanceof Error ? err : new Error(String(err));
      }
    });

    return next;
  };

  /**
   * Concatenate every line and emit one `gzip.write()` call. With instrument-
   * sized rows, a 10k-message batch is several MB of text — making one big
   * write dramatically reduces per-call overhead vs `gzip.write()` per line,
   * and lets drain handling be correct (pause when the gzip buffer signals
   * back-pressure, rather than blasting through 10k small writes past the
   * high-water mark).
   */
  const flushLines = async (lines: string[]): Promise<void> => {
    if (lines.length === 0) return;

    const data = lines.join('\n') + '\n';

    if (! gzip.write(data)) {
      await waitForDrain();
    }
  };

  return {
    writeHeader(header: Header) {
      cols = header.columns;
      writeLine(header.columns.join(','));
    },

    writeMessage(msg: Message): Promise<void> {
      if (! cols) {
        return Promise.reject(new Error('Writer.writeMessage called before writeHeader'));
      }

      const lines = msg.rows.map(row => rowToCsv(row, cols!));

      return enqueue(() => flushLines(lines));
    },

    writeMessages(msgs: Message[]): Promise<void> {
      if (! cols) {
        return Promise.reject(new Error('Writer.writeMessages called before writeHeader'));
      }

      const lines: string[] = [];

      for (const msg of msgs) {
        for (const row of msg.rows) {
          lines.push(rowToCsv(row, cols!));
        }
      }

      return enqueue(() => flushLines(lines));
    },

    writeRaw(lines: string[]): Promise<void> {
      return enqueue(() => flushLines(lines));
    },

    close(): Promise<void> {
      return writing.then(() => {
        if (firstError) throw firstError;

        return new Promise<void>((resolve, reject) => {
          gzip.end(() => {
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
          });
        });
      });
    },
  };
}
