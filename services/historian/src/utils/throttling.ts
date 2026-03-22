import { logger } from '@devvir/service-kit';

const PAUSE_THRESHOLD = 100;
const PARTIAL_PAGE_SLEEP_MS = 5_000;
const SUBTABLE_LOOP_SLEEP_MS = 500;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const waitIfNeeded = async (res: Response): Promise<void> => {
  if (res.status === 429) {
    logger.warn('HTTP 429 — sleeping 60s');
    return await sleep(60_000);
  }

  if (! res.ok) {
    const { status, statusText, url } = res;
    logger.warn({ status, statusText, url }, 'HTTP error — sleeping 3s');
    await sleep(3_000); // No return (intended): fall through to next check
  }

  const remaining = parseInt(res.headers.get('x-ratelimit-remaining') ?? '999', 10);
  const waitMs = Math.max(0, PAUSE_THRESHOLD - remaining) * 500;

  if (waitMs > 0) {
    logger.debug({ remaining, waitMs }, 'Rate-limit throttle');
    await sleep(waitMs);
  }
};

export const waitForPartialPage = async (hasSubtables: boolean): Promise<void> => {
  await sleep(hasSubtables ? SUBTABLE_LOOP_SLEEP_MS : PARTIAL_PAGE_SLEEP_MS);
};
