import { logger } from "@devvir/service-kit";

const MAX_PAUSE_MS = 5 * 60 * 1000; // 5 minutes

let semaphore: Promise<void> | null = null;
let resolver: (() => void) | null = null;
let resumer: NodeJS.Timeout | null = null;

export const greenLight = () => semaphore ?? Promise.resolve();
export const paused = () => semaphore !== null;

export const pause = (delayMs: number = MAX_PAUSE_MS) => {
  logger.warn({ delayMs }, `Pausing processing for ${delayMs}ms`);

  clearResumer();
  resumer = setTimeout(resume, delayMs).unref();

  return semaphore ??= new Promise<void>(resolve => {
    resolver = resolve;
  });
}

export const resume = () => {
  logger.warn(`Resuming processing`);

  clearResumer();

  resolver?.();
  semaphore = null;
  resolver = null;
}

const clearResumer = () => {
  resumer && clearTimeout(resumer);
  resumer = null;
}
