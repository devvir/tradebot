import { createWriteStream } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import type { Container } from './types';

/**
 * Every entry is extracted, not just the first.
 *
 * These archives hold one member in practice — Binance a `.csv`, Bitget a `.csv`
 * for trades and an `.xlsx` for klines and depth — but assuming it would turn a
 * second member into silently missing data.
 */
export const zip: Container = {
  native: false,

  unpack: (absolute, into) => new Promise<string[]>((resolve, reject) => {
    const written: string[] = [];

    yauzl.open(absolute, { lazyEntries: true }, (err, archive) => {
      if (err || ! archive) return reject(err ?? new Error(`unreadable zip: ${absolute}`));

      archive.on('error', reject);
      archive.on('end', () => resolve(written));
      archive.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) return archive.readEntry();

        archive.openReadStream(entry, async (streamErr, stream) => {
          if (streamErr || ! stream) return reject(streamErr ?? new Error('no entry stream'));

          const out = join(into, basename(entry.fileName));

          try {
            await pipeline(stream, createWriteStream(out));

            written.push(out);
            archive.readEntry();
          } catch (pipeErr) {
            reject(pipeErr);
          }
        });
      });

      archive.readEntry();
    });
  }),
};
