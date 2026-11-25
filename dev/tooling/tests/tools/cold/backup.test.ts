import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setYes } from '../../../src/tools/cold/options';
import { busy, orphaned } from '../../../src/tools/cold/lock';
import { check, ledgersOf, recordOf, save } from '../../../src/tools/cold/shared/backup';
import { _test_with as megaWith } from '../../../src/tools/cold/shared/mega/exec';
import * as record from '../../../src/tools/cold/shared/record';
import type { ColdConfig } from '../../../src/tools/cold/types';
import type { CatalogPartition, Remote } from '../../../src/tools/cold/shared/types';

/** Nobody is there to answer in a test: a question asked where none should be is a failure. */
const asked = vi.hoisted(() => ({ answer: null as boolean | null, questions: [] as string[] }));

vi.mock('../../../src/shared/ui/prompts', () => ({
  confirm: async (message: string) => {
    asked.questions.push(message);

    if (asked.answer === null) throw new Error(`Asked, with nobody to answer: ${message}`);

    return asked.answer;
  },
}));

/**
 * The copy in Mega of the record and the vault's ledgers: sent when they have
 * changed and at no other time, and never when they have shrunk.
 */

let dir: string;

const config = (): ColdConfig => ({
  sourceRoot: path.join(dir, 'archives'), vaultRoot: path.join(dir, 'vault'), coldRoot: path.join(dir, 'cold'), megaRoot: '/x/vault',
  backupRoot: '/x/cold', dbPath: path.join(dir, 'cold', 'cold.sqlite'), capBytes: 1e12, queueTargetGb: 10, settledHours: null,
  catalogUrl: 'http://catalog.test', catalogToken: 't',
});

/** Mega, as far as keeping a file goes: what was handed over is what it holds. */
const mega = (): Remote & { sent: string[]; held: Map<string, { bytes: number; handle: string | null }> } => {
  const sent: string[] = [];
  const held = new Map<string, { bytes: number; handle: string | null }>();

  const queueUpload = async (local: string, remoteDir: string): Promise<void> => {
    const at = path.posix.join(path.posix.relative('/x/cold', remoteDir), path.basename(local));

    sent.push(at);
    held.set(at, { bytes: fs.statSync(local).size, handle: 'H' });
  };

  return {
    sent, held,
    queuedPaths:  async () => new Set<string>(),
    queue:        async () => ({ remaining: 0, total: 0, uploaded: 0, transfers: 0 }),
    listing:      async () => held,
    remove:       async () => {},
    queueUpload,
    queueUploads: async (locals, remoteDir) => { for (const local of locals) await queueUpload(local, remoteDir); },
  };
};

const partition = (month: string): CatalogPartition => ({
  venue: 'gate', market: 'spot', dataset: 'trades', variant: '', grain: 'daily', bundle: 'instrument', month, files: 1, bytes: 2, version: 'v1',
});

/** Something happens to the record: a tar is planned. */
const change = (month: string): void => {
  const db = record.open(config().dbPath);

  record.planTar(db, 'archives', 'gate', month, seq => ({ remote: `r${month}${seq}`, local: `l${month}${seq}` }), [partition(month)]);
  record.close(db);
};

const ledger = (lines: number): void => {
  fs.mkdirSync(path.join(dir, 'vault'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vault', 'ledger.csv'), 'partition|revision\n' + 'p|r\n'.repeat(lines));
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-backup-'));

  asked.answer    = null;
  asked.questions = [];

  change('202001');
});

afterEach(() => {
  setYes(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the record\'s copy, as a command starts', () => {
  it('is offered where there is none, and yes unless told otherwise', async () => {
    const remote = mega();

    setYes(true);
    await check(config(), false, remote);

    expect(remote.sent).toEqual(['cold.sqlite']);
  });

  /** A copy of an unchanged record is the same bytes each time it is taken: that is what makes this quiet. */
  it('says nothing and sends nothing where it is what the record is now', async () => {
    const remote = mega();

    await save(config(), [recordOf(config())], remote);
    await check(config(), false, remote);
    await check(config(), true, remote);

    expect(remote.sent).toEqual(['cold.sqlite']);
    expect(asked.questions).toEqual([]);
  });

  it('is asked about where the record has changed since', async () => {
    const remote = mega();

    await save(config(), [recordOf(config())], remote);
    change('202002');

    asked.answer = true;
    await check(config(), false, remote);

    expect(asked.questions).toEqual(['The backup of the cold database is out of date. Update it?']);
    expect(remote.sent).toHaveLength(2);
  });

  /** The run that changed it is known to have died: there is nothing to ask. */
  it('is brought up to date without asking where a run before this one died', async () => {
    const remote = mega();

    await save(config(), [recordOf(config())], remote);
    change('202002');

    await check(config(), true, remote);

    expect(asked.questions).toEqual([]);
    expect(remote.sent).toHaveLength(2);
  });

  /** The copy is hashed as it is read, a piece at a time: a record of any size is never held in memory whole. */
  it('writes down the SHA-256 of what was sent, without reading the copy whole', async () => {
    const remote = mega();
    const whole  = fs.readFileSync;

    const reads = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).endsWith('.new')) throw new Error('read whole');

      return (whole as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);

    try {
      await save(config(), [recordOf(config())], remote);
    } finally {
      reads.mockRestore();
    }

    const sent = JSON.parse(fs.readFileSync(path.join(config().coldRoot, 'backup', 'sent.json'), 'utf8')) as Record<string, { digest: string }>;
    const [[at, one]] = Object.entries(sent) as [[string, { digest: string }]];

    expect(remote.sent).toEqual([at]);
    expect(one.digest).toBe(createHash('sha256').update(fs.readFileSync(path.join(config().coldRoot, 'backup', at))).digest('hex'));
  });

  it('is sent again where Mega no longer holds what was sent', async () => {
    const remote = mega();

    await save(config(), [recordOf(config())], remote);
    remote.held.clear();

    await check(config(), true, remote);

    expect(remote.sent).toHaveLength(2);
  });

  /** Every command looks at the copy as it starts: a Mega that is busy must not keep it going once it is done. */
  it('leaves nothing asking Mega once it gives up on an answer', async () => {
    const asked: string[] = [];

    await save(config(), [recordOf(config())], mega());

    // The clock is the test's; the disk is not, and the copy is read off it before Mega is asked.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

    // Mega busy with something long: nothing answered, each command ended only once its time is up.
    megaWith((command, _args, options) => {
      asked.push(command);

      return new Promise((_, reject) => {
        setTimeout(() => reject(Object.assign(new Error(`Command failed: ${command}`), { killed: true })), options.timeout);
      });
    }, null);

    try {
      let settled = false;

      const checked = check(config(), false).finally(() => { settled = true; });

      // Time goes on until the check is over, however long the read takes.
      while (! settled) {
        await vi.advanceTimersByTimeAsync(1_000);
        await new Promise(resolve => setImmediate(resolve));
      }

      await checked;

      expect(asked).not.toContain('mega-whoami');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      megaWith(null, null);
      vi.useRealTimers();
    }
  });

  /** A page or two either way is the record's ordinary life, and no reason to ask anything. */
  it('is sent as usual where the record is a little smaller than it was', async () => {
    const remote = mega();
    const db     = record.open(config().dbPath);

    const id = record.planTar(db, 'archives', 'gate', '202002', seq => ({ remote: `r${seq}`, local: `l${seq}` }),
      Array.from({ length: 2000 }, (_, at) => ({ ...partition('202002'), variant: `v${at}` })));

    record.close(db);

    await save(config(), [recordOf(config())], remote);

    // A handful of rows gone, as a redrawn plan leaves it.
    const again = record.open(config().dbPath);

    again.prepare('DELETE FROM held WHERE tar_id = ? AND variant IN (SELECT variant FROM held WHERE tar_id = ? LIMIT 100)').run(id, id);
    record.close(again);

    await check(config(), true, remote);

    expect(asked.questions).toEqual([]);
    expect(remote.sent).toHaveLength(2);
  });

  /** It does not lose a tenth of itself in the ordinary way: that is not a change to pass on. */
  it('is never replaced by a smaller record unless a person says so', async () => {
    const remote = mega();

    // Enough in it to weigh something: a record of a handful of rows is the size of an empty one.
    const db = record.open(config().dbPath);

    record.planTar(db, 'archives', 'gate', '202002', seq => ({ remote: `r${seq}`, local: `l${seq}` }),
      Array.from({ length: 2000 }, (_, at) => ({ ...partition('202002'), variant: `v${at}` })));
    record.close(db);

    await save(config(), [recordOf(config())], remote);

    fs.rmSync(path.join(dir, 'cold', 'cold.sqlite'));
    fs.rmSync(path.join(dir, 'cold', 'cold.sqlite-wal'), { force: true });
    fs.rmSync(path.join(dir, 'cold', 'cold.sqlite-shm'), { force: true });
    record.close(record.open(config().dbPath));

    // Every answer given beforehand is this question's own, which is no; and with a dead run behind it, it is still asked.
    setYes(true);
    await check(config(), true, remote);
    await save(config(), [recordOf(config())], remote);

    expect(remote.sent).toHaveLength(1);

    setYes(false);
    asked.answer = true;
    await check(config(), false, remote);

    expect(asked.questions).toEqual(['Replace the backup with the smaller database?']);
    expect(remote.sent).toHaveLength(2);
  });
});

describe('Mega\'s queue', () => {
  /** Sent once: what is still queued of it goes before it is queued again. */
  it('holds each file once, the newest', async () => {
    const remote = mega();
    const order: string[] = [];

    remote.dropUploadsOf = async (local) => {
      order.push(`drop ${path.basename(local)}`);

      return 1;
    };

    const queueUpload = remote.queueUpload;

    remote.queueUpload = async (local, remoteDir) => {
      order.push(`queue ${path.basename(local)}`);
      await queueUpload(local, remoteDir);
    };

    await save(config(), [recordOf(config())], remote);
    change('202002');
    await save(config(), [recordOf(config())], remote);

    expect(order).toEqual(['drop cold.sqlite', 'queue cold.sqlite', 'drop cold.sqlite', 'queue cold.sqlite']);
  });

  /** A queue that cannot be read is no reason to leave the copy out of date. */
  it('is sent to all the same where the queue cannot be cleared', async () => {
    const remote = mega();

    remote.dropUploadsOf = async () => { throw new Error('mega-cmd is not answering'); };

    await save(config(), [recordOf(config())], remote);

    expect(remote.sent).toEqual(['cold.sqlite']);
  });
});

describe('the vault\'s ledgers', () => {
  it('are sent when they have grown, and not again until they grow', async () => {
    const remote = mega();

    ledger(1);
    await save(config(), ledgersOf(config()), remote);
    await save(config(), ledgersOf(config()), remote);

    ledger(2);
    await save(config(), ledgersOf(config()), remote);

    // `backedup.csv` is not there, and what is not there is not sent.
    expect(remote.sent).toEqual(['vault/ledger.csv', 'vault/ledger.csv']);
  });

  it('are not sent smaller than they were', async () => {
    const remote = mega();

    ledger(5);
    await save(config(), ledgersOf(config()), remote);

    ledger(1);
    await save(config(), ledgersOf(config()), remote);

    expect(remote.sent).toEqual(['vault/ledger.csv']);
  });
});

describe('a lock left behind', () => {
  it('is one whose holder is gone, and not one that is held', () => {
    fs.writeFileSync(path.join(dir, 'cold', 'cold.archives.push.lock'), `pid ${process.pid} since T\n`);

    expect(orphaned(path.join(dir, 'cold'))).toBe(false);

    fs.writeFileSync(path.join(dir, 'cold', 'cold.vault.push.lock'), 'pid 2147483646 since T\n');

    expect(orphaned(path.join(dir, 'cold'))).toBe(true);
  });

  /** Another command at work is why the record is not what its copy is: nothing to ask about. */
  it('says another command is running where its holder is there and is not this one', () => {
    fs.writeFileSync(path.join(dir, 'cold', 'cold.archives.push.lock'), `pid ${process.pid} since T\n`);

    expect(busy(path.join(dir, 'cold'))).toBe(false);

    fs.writeFileSync(path.join(dir, 'cold', 'cold.vault.push.lock'), `pid ${process.ppid} since T\n`);

    expect(busy(path.join(dir, 'cold'))).toBe(true);
  });
});
