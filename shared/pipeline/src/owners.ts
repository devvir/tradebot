import type { BaseTopic, Owner, Topic } from './types';

/**
 * Who produces what.
 *
 * **This map is the diagram.** Reading it tells you which service fills which
 * tree, which is a thing the codebase otherwise only says by implication across
 * four repositories' worth of file paths.
 *
 * It is enforced on writes, and that enforcement is a **mistake detector, not a
 * security boundary** — there is no authentication between services and none is
 * wanted. It catches a topic typed wrong and a service writing somewhere it did
 * not mean to, which are the two things that actually happen.
 *
 * Reads are open to everyone. A consumer needs no permission to find out where
 * a producer has got to; that is the entire purpose.
 */
export const OWNERS: Record<BaseTopic, Owner | readonly Owner[]> = {
  /**
   * **Two writers, for as long as the archives have two collectors.** Trucker
   * discovers and downloads in one service; hauler works from the catalog and
   * writes at a finer grain. They fill the same tree and say the same kind of
   * thing about it, so the tree keeps one meaning and the handover needs no
   * migration — trucker's entry goes when trucker does.
   *
   * A list is still an enumeration, so this is not a hole: a service not named
   * here cannot write here, which is the whole job.
   */
  archives:  ['trucker', 'hauler'],
  vault:     'stocker',
  rest:      'tooling',
  websocket: 'tooling',
};

/**
 * Refuse a write that is not the caller's to make.
 *
 * **An unknown topic throws rather than being allowed through.** A topic absent
 * from the map is not an experiment, it is a typo — the map is what makes a
 * topic real, and something written under a misspelling is invisible to every
 * consumer while looking perfectly fine to whoever wrote it.
 */
export const assertOwns = (owner: Owner, topic: Topic): void => {
  const tree   = baseOf(topic);
  const holder = tree ? OWNERS[tree] : undefined;

  if (! holder)
    throw new Error(`Unknown topic '${topic}'. Known: ${Object.keys(OWNERS).join(', ')}`);

  const holders = typeof holder === 'string' ? [holder] : holder;

  if (! holders.includes(owner))
    throw new Error(
      `'${owner}' cannot write '${topic}' facts — that topic belongs to '${holders.join("', '")}'`);
};

/**
 * The tree a topic is about, however it is namespaced.
 *
 * `archives:bookkeeping` and `logs:archives` are both trucker saying more about
 * the archives — not a second tree with a second owner — so ownership is
 * answered by the tree and a subtopic needs no entry of its own.
 *
 * **The tree is whichever segment names one, wherever it sits.** Fixing it to
 * the first segment or the last would settle a naming convention in code, and
 * that convention is a documentation decision that should stay changeable.
 * Two known trees in one topic is a mistake rather than a clever composition,
 * and it says so.
 */
export const baseOf = (topic: Topic): BaseTopic | undefined => {
  const named = topic.split(':').filter((segment): segment is BaseTopic => segment in OWNERS);

  if (named.length > 1)
    throw new Error(`Topic '${topic}' names more than one tree: ${named.join(', ')}`);

  return named[0];
};
