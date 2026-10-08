import { closeSync, createWriteStream, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { crc32, inflateRawSync } from 'node:zlib';
import yauzl from 'yauzl';
import type { Container, Member } from './types';

/**
 * Every entry is extracted, not just the first.
 *
 * These archives hold one member in practice — Binance a `.csv`, Bitget a `.csv`
 * for trades and an `.xlsx` for klines and depth — but assuming it would turn a
 * second member into silently missing data.
 *
 * **A small archive is read whole and inflated where it stands.** Most archives
 * are tiny and there are a great many of them — a month of hourly candles is a
 * file of a few hundred bytes per instrument per day — and for those the cost
 * is not the bytes but the asking: opening, measuring, seeking and streaming
 * each one is a dozen trips through the thread pool to move a kilobyte. So one
 * read, one inflate, one write, with no waiting in between.
 *
 * Measured on 2,000 of htx's daily kline zips (2026-10-06, on a busy machine):
 * 33 s streamed against 3.5 s read whole **where the files were already in the
 * page cache**. Where they had never been read, reading them was most of the
 * cost either way — about 7 ms a file of the 12 — and the two came out at 14
 * and 12 ms a file. What this removes is the overhead, not the disk.
 *
 * **A large archive is streamed**, so it is never held in memory, and so is any
 * archive the direct read does not recognise — see `membersOf`.
 */
export const zip: Container = {
  native: false,

  unpack: async (absolute, into, tag) => {
    const members = whole(absolute);

    if (members)
      return members.map(({ name, data }) => {
        const out = join(into, `${tag}${basename(name)}`);

        writeFileSync(out, data);

        return out;
      });

    return streamed(absolute, into, tag);
  },

  members: absolute => whole(absolute),

  weight: async absolute => statedAtEnd(absolute) ?? await statedByEntry(absolute),
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** An archive up to this size is read whole; a larger one is streamed. */
const WHOLE_BYTES = 32 * 1024 ** 2;

/** A small archive's members, read whole; null where it is large, or is not a zip the direct read knows. */
const whole = (absolute: string): Member[] | null =>
  (statSync(absolute).size <= WHOLE_BYTES ? membersOf(readFileSync(absolute), absolute) : null);

/**
 * The members of a zip held in memory, inflated — or null where this cannot
 * read it and the streaming reader should.
 *
 * **Only the plain case is read here**: members stored or deflated, sizes that
 * fit the classic headers, nothing encrypted. Anything else — zip64, another
 * method, an archive with no directory to be found — is left to the library
 * that handles every case, which costs time and loses nothing.
 *
 * **What is read is checked.** A member that does not inflate to the size and
 * the CRC its directory entry states is not a member this can vouch for, and
 * that throws: a short or altered file must not reach a table as data.
 */
const membersOf = (buffer: Buffer, absolute: string): Member[] | null => {
  const directory = endOfDirectory(buffer);

  if (directory < 0) return null;

  const count = buffer.readUInt16LE(directory + 10);

  let at = buffer.readUInt32LE(directory + 16);

  if (count === 0xffff || at === 0xffffffff) return null;

  const members: Member[] = [];

  for (let entry = 0; entry < count; entry++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== ENTRY) return null;

    const flags      = buffer.readUInt16LE(at + 8);
    const method     = buffer.readUInt16LE(at + 10);
    const checksum   = buffer.readUInt32LE(at + 16);
    const compressed = buffer.readUInt32LE(at + 20);
    const size       = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local      = buffer.readUInt32LE(at + 42);
    const name       = buffer.toString('utf8', at + 46, at + 46 + nameLength);

    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);

    if (flags & ENCRYPTED) return null;
    if (method !== STORED && method !== DEFLATED) return null;
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) return null;

    if (name.endsWith('/')) continue;

    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL) return null;

    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);

    if (start + compressed > buffer.length) return null;

    const raw  = buffer.subarray(start, start + compressed);
    const data = method === DEFLATED ? inflateRawSync(raw) : raw;

    if (data.length !== size || crc32(data) !== checksum)
      throw new Error(`corrupt zip member ${name} in ${absolute}: it does not inflate to what its entry states`);

    members.push({ name, data });
  }

  return members;
};

/** Where the end-of-directory record starts, searched back from the end past any comment; -1 where there is none. */
const endOfDirectory = (buffer: Buffer): number => {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);

  for (let at = buffer.length - 22; at >= lowest; at--)
    if (buffer.readUInt32LE(at) === END) return at;

  return -1;
};

/**
 * What a zip's directory says its members inflate to, read from the end of the
 * file — or null where the directory is not all there, or is in a form this
 * does not read, and the library is asked.
 */
const statedAtEnd = (absolute: string): number | null => {
  const size   = statSync(absolute).size;
  const length = Math.min(size, END_BYTES);
  const buffer = Buffer.alloc(length);
  const file   = openSync(absolute, 'r');

  try {
    readSync(file, buffer, 0, length, size - length);
  } finally {
    closeSync(file);
  }

  const directory = endOfDirectory(buffer);

  if (directory < 0) return null;

  const count = buffer.readUInt16LE(directory + 10);
  const start = buffer.readUInt32LE(directory + 16);

  if (count === 0xffff || start === 0xffffffff) return null;

  // Where the directory starts in what was read of the file.
  let at    = start - (size - length);
  let total = 0;

  if (at < 0) return null;

  for (let entry = 0; entry < count; entry++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== ENTRY) return null;

    const stated = buffer.readUInt32LE(at + 24);

    if (stated === 0xffffffff) return null;

    total += stated;
    at    += 46 + buffer.readUInt16LE(at + 28) + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }

  return total;
};

/** The same, asked of the library: any zip there is. */
const statedByEntry = (absolute: string): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    yauzl.open(absolute, { lazyEntries: true }, (err, archive) => {
      if (err || ! archive) return reject(err ?? new Error(`unreadable zip: ${absolute}`));

      let total = 0;

      archive.on('error', reject);
      archive.on('end', () => resolve(total));
      archive.on('entry', (entry) => {
        total += entry.uncompressedSize;

        archive.readEntry();
      });

      archive.readEntry();
    });
  });

/** How much of a zip's end is read to find its directory in. */
const END_BYTES = 128 * 1024;

/** One member at a time, through the library: any zip there is, at any size. */
const streamed = (absolute: string, into: string, tag: string): Promise<string[]> =>
  new Promise<string[]>((resolve, reject) => {
    const written: string[] = [];

    yauzl.open(absolute, { lazyEntries: true }, (err, archive) => {
      if (err || ! archive) return reject(err ?? new Error(`unreadable zip: ${absolute}`));

      archive.on('error', reject);
      archive.on('end', () => resolve(written));
      archive.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) return archive.readEntry();

        archive.openReadStream(entry, async (streamErr, stream) => {
          if (streamErr || ! stream) return reject(streamErr ?? new Error('no entry stream'));

          const out = join(into, `${tag}${basename(entry.fileName)}`);

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
  });

const END      = 0x06054b50;
const ENTRY    = 0x02014b50;
const LOCAL    = 0x04034b50;

const ENCRYPTED = 1;
const STORED    = 0;
const DEFLATED  = 8;
