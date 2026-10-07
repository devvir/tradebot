import { closeSync, openSync, rmSync, writeSync } from 'node:fs';
import type { Pack } from './types';

/** The column a gathered file's lines open with: which archive each came from. */
export const TAG = '_tag';

/**
 * Many small files of one shape, gathered into one.
 *
 * **Reading a file costs the engine about a tenth of a millisecond before it
 * has read a byte of it**, and a month of daily candles is that many times
 * over: 16,748 files of 137 bytes took 2.1 s to read, and the same lines in
 * one file took 0.04 s (2026-10-07). So the lines of small members are written
 * one after another into a single file, each opening with the number of the
 * archive it came from, and the engine reads that file once.
 *
 * **Only where a line is a row.** Nothing here parses: a member is cut at its
 * line ends and nothing else, which is right only for text with no quoted
 * cells, since a quoted cell may hold a line end. So a member holding a quote
 * is not gathered, and neither is a sheet, a member with line ends of another
 * kind, or — where members carry a header — one whose header is not the first
 * one's. Those are left as files, read as they always were.
 *
 * **Only where it is small.** One large file is read slower than the same rows
 * in a few hundred: 10.6 million rows in 247 files took 11 s, and 20.6 s as
 * one. What is saved is the cost per file, so it is taken where files are many
 * and small and left where they are not.
 */
export class Packer {
  constructor(private readonly path: string, private readonly shape: Pack) {}

  /** Bytes written. */
  bytes = 0;

  private fd:      number | null = null;
  private header:  Buffer | null = null;
  private lines   = 0;
  private waiting: Buffer[] = [];
  private held    = 0;

  /**
   * Add a member's lines under its archive's number. False where it cannot be
   * gathered and is left to be read as a file; true where it was — or held
   * nothing, and has nothing to be read.
   */
  add(tag: number, data: Buffer): boolean {
    if (data.length > MEMBER_BYTES) return false;

    let from = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;

    if (from === data.length) return true;

    if (data.length >= 4 && data.readUInt32LE(0) === SHEET) return false;
    if (data.includes(QUOTE)) return false;

    // A line ends in a line feed, with or without a carriage return before it; one on its own is another kind of file.
    for (let at = data.indexOf(CR, from); at >= 0; at = data.indexOf(CR, at + 1))
      if (data[at + 1] !== LF) return false;

    if (this.shape.header) {
      const end  = endOf(data, from);
      const line = data.subarray(from, lineStop(data, from, end));

      if (! this.header) {
        // The number goes in front with a comma, so commas have to be what separates the columns.
        if (! line.includes(COMMA) || OTHERS.some(other => line.includes(other))) return false;

        this.header = Buffer.from(line);
        this.write(Buffer.concat([Buffer.from(`${TAG},`), line, NEWLINE]));
      }
      else if (! line.equals(this.header)) return false;

      from = end + 1;
    }

    const prefix = Buffer.from(`${tag},`);
    const pieces: Buffer[] = [];

    while (from < data.length) {
      const end  = endOf(data, from);
      const stop = lineStop(data, from, end);

      if (stop > from) {
        pieces.push(prefix, data.subarray(from, stop), NEWLINE);

        this.lines++;
      }

      from = end + 1;
    }

    if (pieces.length > 0) this.write(Buffer.concat(pieces));

    return true;
  }

  /** Finish the file and say where it is — or null, and no file, where no line went into it. */
  close(): string | null {
    this.flush();

    if (this.fd !== null) closeSync(this.fd);

    if (this.lines > 0) return this.path;

    rmSync(this.path, { force: true });

    this.bytes = 0;

    return null;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private write(lines: Buffer): void {
    this.waiting.push(lines);
    this.held += lines.length;

    if (this.held >= FLUSH_BYTES) this.flush();
  }

  private flush(): void {
    if (this.held === 0) return;

    this.fd ??= openSync(this.path, 'w');

    const all = Buffer.concat(this.waiting);

    writeSync(this.fd, all);

    this.bytes  += all.length;
    this.waiting = [];
    this.held    = 0;
  }
}

/** Where the line starting at `from` ends: at its line feed, or at the end of the data. */
const endOf = (data: Buffer, from: number): number => {
  const end = data.indexOf(LF, from);

  return end < 0 ? data.length : end;
};

/** The end of a line's own text: before the carriage return, where it has one. */
const lineStop = (data: Buffer, from: number, end: number): number =>
  (end > from && data[end - 1] === CR ? end - 1 : end);

/** The largest member gathered, as it stands once inflated. */
const MEMBER_BYTES = 64 * 1024;

/** How much is held before it is written. */
const FLUSH_BYTES = 1024 ** 2;

const LF      = 0x0a;
const CR      = 0x0d;
const QUOTE   = 0x22;
const COMMA   = 0x2c;
const NEWLINE = Buffer.from([LF]);

/** What else a header's columns may be separated by: tab, semicolon, pipe. */
const OTHERS = [0x09, 0x3b, 0x7c];

/** A sheet is a zip archive, and opens with its signature. */
const SHEET = 0x04034b50;
