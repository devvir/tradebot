import { logger, guardBody } from '@devvir/service-kit';

/**
 * Asking a venue's API about itself, as opposed to asking its archive for files.
 *
 * **A different host, a different contract, and a different failure mode.** An
 * archive is a bucket that answers a key; a metadata endpoint is a web service
 * with its own limits, its own throttling and its own habit of returning a
 * refusal inside a `200`. It also sits outside the pace gate the archive's host
 * is held to, because it is not that host.
 *
 * Shared because every venue needs it, and needs all of the hardening below:
 * one copy per venue is one more place for a timeout or a stalled body to go
 * unguarded.
 */

/** Whether a body that arrived with a `200` is actually a refusal. */
export type Refusal = (body: unknown) => boolean;

export const fetchJson = async <T>(url: string, of: string, refused?: Refusal): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    /**
     * **A refused connection is retried like a refused request.** `fetch`
     * throws on a transport fault rather than returning a status, and a
     * metadata host is often a venue's website — a different host from the
     * archive, and a flakier one — so one `ETIMEDOUT` let through would take
     * down the whole venue's survey from inside its bootstrap.
     *
     * **Two clocks, because there are two questions.** `ANSWER_MS` bounds the
     * wait for a reply and is dropped the moment the headers arrive; measuring
     * the body against it would abort a download for being large, which is not
     * a fault. What the body is held to is silence — `guardBody` restarts its
     * clock on every chunk, so a slow instrument list finishes and a stopped one
     * fails within `STALL_MS` of stopping.
     *
     * That distinction is the difference between a survey and a wedged service.
     * Under load a body arrives one chunk per turn of the event loop, which puts
     * a megabyte of instruments well past any sane deadline — and a deadline
     * that fires mid-body leaves nothing to catch, because an aborted fetch does
     * not always settle.
     */
    let res: Response;

    const control = new AbortController();
    const answer  = setTimeout(() => control.abort(), METADATA_ANSWER_MS);

    try {
      res = await fetch(url, { signal: control.signal });
    } catch (err) {
      if (attempt >= METADATA_ATTEMPTS) throw err;

      logger.warn({ url, attempt: attempt + 1, err: describe(err) },
        `${of} metadata did not answer — retrying`);

      await sleep(METADATA_PAUSE_MS * (attempt + 1));

      continue;
    } finally {
      clearTimeout(answer);
    }

    const answered = guardBody(res, {
      stallMs: METADATA_STALL_MS,
      onStall: () => control.abort(),
    });

    if (answered.ok) {
      let body: T;

      /**
       * **Read inside the loop, so a body that fails is retried rather than
       * thrown.** Outside every guard, a stalled read would have no deadline to
       * end it and no catch to record it, and the whole venue would stop on it
       * in silence.
       */
      try {
        body = await answered.json() as T;
      } catch (err) {
        if (attempt >= METADATA_ATTEMPTS) throw err;

        logger.warn({ url, attempt: attempt + 1, err: describe(err) },
          `${of} metadata stopped mid-answer — retrying`);

        await sleep(METADATA_PAUSE_MS * (attempt + 1));

        continue;
      }

      /**
       * **A `200` is not always an answer.** Several venues return their errors
       * and throttles as a code inside the body, so the status alone cannot say
       * whether this worked — and only the venue knows what that looks like.
       */
      if (! refused?.(body)) return body;

      if (attempt >= METADATA_ATTEMPTS) throw new Error(`${of} refused the metadata: ${url}`);
    } else {
      // Nothing below reads a refusal's body, and an unread one holds its socket.
      if (answered.body) await answered.body.cancel().catch(() => {});

      /**
       * **A throttle and a server fault are asked again; anything else is an
       * answer.** A 429 or a 5xx says nothing about the request, only about the
       * moment, and lapses; another 4xx is the venue saying no to the request
       * itself, and asking again only says it again.
       */
      if (! retryable(res.status) || attempt >= METADATA_ATTEMPTS)
        throw new Error(`${of} metadata failed ${res.status}: ${url}`);
    }

    const wait = METADATA_PAUSE_MS * (attempt + 1);

    logger.warn({ url, attempt: attempt + 1, wait }, `${of} metadata refused — waiting`);

    await sleep(wait);
  }
};

const retryable = (status: number): boolean => status === 429 || status >= 500;

const METADATA_ATTEMPTS = 6;

/** A metadata call answers in under a second, or it is not going to. */
const METADATA_ANSWER_MS = 20_000;

/**
 * How long the answer itself may go quiet once it has started arriving.
 *
 * Nothing to do with how much there is to send — the option lists run to a
 * megabyte and are welcome to take their time. This is the gap between chunks,
 * which is the only thing that separates a slow venue from a dead one.
 *
 * Set just clear of the event loop's own lag, for the reason `STALL_MS` gives in
 * `http.ts`: tighter than that and a congested process fails its own healthy
 * downloads; looser and a dead one goes unreported for longer than it takes to
 * notice by other means.
 */
const METADATA_STALL_MS = 10_000;

/**
 * The wait after the n-th failed attempt is n times this: growing linearly
 * rather than doubling as `backoffDelay` does, so the six waits come to about a
 * minute where doubling would take three.
 */
const METADATA_PAUSE_MS = 3_000;

/** Between metadata calls, because a handful in a row is already too many. */
const METADATA_GAP_MS = 1_500;

/**
 * What actually went wrong, rather than the wrapper around it.
 */
const describe = (err: unknown): string =>
  (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

const sleep = async (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/** Between metadata calls at one venue, so a handful in a row is not a burst. */
export const metadataGap = async (): Promise<void> => sleep(METADATA_GAP_MS);
