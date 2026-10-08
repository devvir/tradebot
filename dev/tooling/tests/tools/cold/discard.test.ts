import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discard } from '../../../src/tools/cold/evict/discard';

describe('taking files off the disk outright', () => {
  /** A signal is only heard when the thread is handed back: a removal that never does cannot be stopped. */
  it('hands the thread back on every call, however little it removes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-discard-'));

    try {
      let heard = 0;

      for (let at = 0; at < 5; at++) {
        const file = path.join(dir, `f${at}`);

        fs.writeFileSync(file, 'x');
        setImmediate(() => { heard++; });

        await discard([file], true);

        expect(fs.existsSync(file)).toBe(false);
        expect(heard).toBe(at + 1);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
