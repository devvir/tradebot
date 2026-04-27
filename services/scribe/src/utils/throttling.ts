import { logger } from '@devvir/service-kit';

const PAUSE_THRESHOLD = 100;

const RETRY_BASE_MS  = 5_000;
const RETRY_MAX_MS   = 300_000;

export const withRetry = async <T>(
  label: string,
  fn:    () => Promise<T>,
): Promise<T> => {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      logger.warn({ label, attempt, delay, err }, 'Transient error — retrying');
      await sleep(delay);
    }
  }
};

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
