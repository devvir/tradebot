import { createHash } from 'node:crypto';
import fs from 'node:fs';

/** A file's SHA-256, in hex. Read as a stream, so a file of any size is hashed in a few megabytes of memory. */
export const digestOf = async (file: string): Promise<string> => {
  const hash = createHash('sha256');

  for await (const chunk of fs.createReadStream(file, { highWaterMark: 8 * 1024 ** 2 })) hash.update(chunk as Buffer);

  return hash.digest('hex');
};
