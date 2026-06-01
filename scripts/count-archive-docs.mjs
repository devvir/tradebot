#!/usr/bin/env node
/**
 * Count the actual number of documents inside a mongodump --gzip --archive
 * file, without restoring it.
 *
 * Walks the archive frame-by-frame: reads each 4-byte length prefix, skips
 * that many bytes (no BSON parsing — just byte counting). Distinguishes
 * block "headers" from "body docs" by position (first BSON in each block
 * is the header; subsequent ones are bodies). The prelude block's bodies
 * are collection-metadata BSONs (not data docs); data-block bodies are the
 * actual documents.
 *
 * Format reference: github.com/mongodb/mongo-tools/common/archive/archive.go
 *   - 4 bytes magic 0x8199e26d (LE)
 *   - blocks: header BSON, 0+ body BSONs, 4-byte terminator 0xFFFFFFFF
 *   - first block = prelude (archive metadata + collection metadata)
 *   - subsequent blocks = data blocks per namespace
 *
 * Usage:
 *   node scripts/count-archive-docs.mjs <path-to-archive.gz>
 *
 * No external dependencies; uses only node: built-ins.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC      = 0x8199e26d;
const TERMINATOR = 0xFFFFFFFF;

if (process.argv.length < 3) {
  console.error('Usage: node count-archive-docs.mjs <archive.gz>');
  process.exit(1);
}

const archivePath = process.argv[2];

class BufferedReader {
  constructor(stream) {
    this.stream  = stream;
    this.chunks  = [];
    this.total   = 0;
    this.eof     = false;
    this.waiting = null;

    stream.on('data', chunk => {
      this.chunks.push(chunk);
      this.total += chunk.length;
      this._wake();
    });

    stream.on('end',   () => { this.eof = true; this._wake(); });
    stream.on('error', err => { this.error = err; this._wake(); });
  }

  _wake() {
    if (this.waiting) { const w = this.waiting; this.waiting = null; w(); }
  }

  async _waitForData(min) {
    while (this.total < min && ! this.eof && ! this.error) {
      await new Promise(resolve => { this.waiting = resolve; });
    }
    if (this.error) throw this.error;
  }

  /** Read exactly n bytes. Returns Buffer, or null on EOF before n bytes. */
  async read(n) {
    await this._waitForData(n);

    if (this.total < n) return null;

    // coalesce as needed
    while (this.chunks[0].length < n) {
      this.chunks = [Buffer.concat([this.chunks[0], this.chunks[1]]), ...this.chunks.slice(2)];
    }

    const head        = this.chunks[0];
    const out         = head.subarray(0, n);
    this.chunks[0]    = head.subarray(n);
    if (this.chunks[0].length === 0) this.chunks.shift();
    this.total       -= n;

    return out;
  }

  /** Skip n bytes without copying. Returns true if skipped, false on EOF. */
  async skip(n) {
    let remaining = n;

    while (remaining > 0) {
      await this._waitForData(1);

      if (this.total === 0) return false;

      const head = this.chunks[0];
      const take = Math.min(head.length, remaining);

      if (take === head.length) this.chunks.shift();
      else                       this.chunks[0] = head.subarray(take);

      this.total -= take;
      remaining  -= take;
    }

    return true;
  }
}

async function main() {
  const start  = Date.now();
  const stream = fs.createReadStream(archivePath).pipe(zlib.createGunzip());
  const reader = new BufferedReader(stream);

  // 1. magic
  const magicBytes = await reader.read(4);

  if (! magicBytes) {
    console.error('archive too short — no magic');
    process.exit(1);
  }

  const magic = magicBytes.readUInt32LE(0);

  if (magic !== MAGIC) {
    console.error(`bad magic: 0x${magic.toString(16).padStart(8, '0')} (expected 0x${MAGIC.toString(16)})`);
    process.exit(1);
  }

  // 2. walk frames
  let blockIdx     = 0;     // 0 = prelude, 1+ = data blocks
  let expectHeader = true;  // true = the next BSON is a block header, false = it's a body
  let dataDocs     = 0;     // body BSONs in data blocks (the answer)
  let metaDocs     = 0;     // body BSONs in the prelude (collection metadata)
  let bytesRead    = 4;     // magic
  let lastLog      = Date.now();

  while (true) {
    const lenBytes = await reader.read(4);

    if (! lenBytes) break;  // clean EOF

    const len = lenBytes.readUInt32LE(0);

    bytesRead += 4;

    if (len === TERMINATOR) {
      blockIdx++;
      expectHeader = true;
      continue;
    }

    // It's a length-prefixed BSON. `len` is the TOTAL BSON size (incl. the 4
    // length bytes we just consumed). Skip the remaining (len - 4) bytes.
    if (len < 5) {
      console.error(`invalid BSON length ${len} at byte ${bytesRead - 4}`);
      process.exit(1);
    }

    const ok = await reader.skip(len - 4);

    if (! ok) {
      console.error(`unexpected EOF inside BSON: needed ${len - 4} more bytes`);
      process.exit(1);
    }

    bytesRead += len - 4;

    if (expectHeader) {
      expectHeader = false;
    } else if (blockIdx === 0) {
      metaDocs++;
    } else {
      dataDocs++;
    }

    // Heartbeat every ~3s so a slow run shows life
    const now = Date.now();
    if (now - lastLog > 3000) {
      process.stderr.write(`\r  blocks=${blockIdx}  data docs=${dataDocs.toLocaleString()}  uncompressed=${(bytesRead / 1024 / 1024 / 1024).toFixed(2)}GB`);
      lastLog = now;
    }
  }

  process.stderr.write('\r' + ' '.repeat(80) + '\r');

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`archive:                ${archivePath}`);
  console.log(`magic:                  OK (0x${MAGIC.toString(16)})`);
  console.log(`blocks:                 ${blockIdx}  (1 prelude + ${blockIdx - 1} data)`);
  console.log(`prelude metadata docs:  ${metaDocs}`);
  console.log(`data documents:         ${dataDocs.toLocaleString()}`);
  console.log(`bytes read (uncompressed): ${bytesRead.toLocaleString()}  (${(bytesRead / 1024 / 1024 / 1024).toFixed(2)}GB)`);
  console.log(`elapsed:                ${elapsed}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
