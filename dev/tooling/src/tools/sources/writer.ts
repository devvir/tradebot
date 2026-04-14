import fs from 'node:fs';
import zlib from 'node:zlib';
import { rowToCsv } from '@tradebot/utils';
import type { Header, Message } from './types';

export interface Writer {
  writeHeader(header: Header): void;
  writeMessage(msg: Message): Promise<void>;
  writeRaw(lines: string[]): Promise<void>;
  close(): Promise<void>;
}

/** Create a no-op writer used during dry-run mode. */
export function createNullWriter(): Writer {
  return {
    writeHeader:  () => { /* no-op */ },
    writeMessage: async () => { /* no-op */ },
    writeRaw:     async () => { /* no-op */ },
    close:        async () => { /* no-op */ },
  };
}

/**
 * Create a gzip-compressed CSV writer to the given output path.
 *
 * Records are serialized via the shared `rowToCsv` helper so the on-disk
 * bytes are indistinguishable from a vault-written file: fields are quoted
 * only when they contain `,`, `"`, or `\n`, and embedded quotes are doubled.
 */
export function createGzipWriter(outputPath: string): Writer {
  const fileStream = fs.createWriteStream(outputPath);
  const gzip       = zlib.createGzip({ level: 6 });

  gzip.pipe(fileStream);

  let cols: string[] | null = null;

  /** Write a single line, returning the stream's drain state. */
  const writeLine = (line: string): boolean => gzip.write(line + '\n');

  const waitForDrain = (): Promise<void> =>
    new Promise(resolve => gzip.once('drain', resolve));

  return {
    writeHeader(header: Header) {
      cols = header.columns;
      writeLine(header.columns.join(','));
    },

    async writeMessage(msg: Message) {
      if (! cols) {
        throw new Error('Writer.writeMessage called before writeHeader');
      }

      for (const row of msg.rows) {
        const ok = writeLine(rowToCsv(row, cols));

        if (! ok) {
          await waitForDrain();
        }
      }
    },

    async writeRaw(lines: string[]) {
      for (const line of lines) {
        const ok = writeLine(line);

        if (! ok) {
          await waitForDrain();
        }
      }
    },

    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        gzip.end(() => {
          fileStream.on('finish', resolve);
          fileStream.on('error', reject);
        });
      });
    },
  };
}
