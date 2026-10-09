import * as mega from './mega';
import type { Progress } from './progress';
import type { Following } from './types';

/**
 * Mega's queues, as a source of progress.
 *
 * **Everything that moves a file to Mega or back is the same thing to watch**:
 * some files of a run, in one of two queues, each so far along. What differs
 * between one command and another is which queue, which files, and whether the
 * line is of all of them together or of the one moving now — and those are
 * what is told here, never a display of its own.
 *
 * It keeps one line of a block current — see `progress.ts`, which draws it —
 * by reading the queue at intervals. A storage that is not Mega is another file
 * like this one, and nothing else.
 *
 * Returns what stops it, and takes its line away.
 */
export const follow = (progress: Progress, following: Following): (() => void) => {
  const { id, queue, mine, total, label, idle } = following;
  const look = { ...(following.mark ? { mark: following.mark } : {}), ...(following.rank !== undefined ? { rank: following.rank } : {}) };
  const read = following.read ?? mega.transfers;

  const stop = progress.every(POLL_MS, async () => {
    const listed = (await read(queue)).filter(one => ! mine || mine(one.path));

    /**
     * **All of them together**: what is not in the queue any more has arrived,
     * so what is left there — whole files, or what of each is still to move —
     * is taken from what they all come to.
     */
    if (total) {
      const files = following.count === 'files';
      const left  = files ? listed.length : listed.reduce((sum, one) => sum + one.bytes * (1 - one.percent / 100), 0);
      const whole = files ? total.files : total.bytes;

      progress.set(id, {
        label: typeof label === 'string' ? label : listed.find(one => one.active) ? label(listed.find(one => one.active)!) : '',
        done: Math.max(0, whole - left), total: whole, unit: files ? 'count' : 'bytes', ...(files ? { of: 'files' } : {}), ...look,
      });

      return;
    }

    // The one moving now: Mega moves one file at a time, so there is only ever one.
    const moving = listed.find(one => one.active);

    if (moving) {
      progress.set(id, {
        label: typeof label === 'string' ? label : label(moving),
        done: moving.bytes * (moving.percent / 100), total: moving.bytes, unit: 'bytes', ...look,
      });
    }
    else progress.set(id, idle === undefined ? null : { label: idle, done: 0, total: 0, unit: 'bytes', quiet: true, ...look });
  });

  return () => {
    stop();

    progress.set(id, null);
  };
};

/** Between looks at a queue. Transfers take minutes to hours, so this is already far finer than needed. */
const POLL_MS = 3_000;
