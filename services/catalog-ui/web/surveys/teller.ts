/** How long an acknowledgement stays on screen before it stops being news. */
export const SAID_MS = 6_000;

/** What the page has just said: the words, and whether they stay until dismissed. */
export interface Said {
  text:   string;
  sticks: boolean;
}

/**
 * What the page says about what was just asked for, with `show` told each time
 * it changes.
 *
 * **An acknowledgement fades; a failure stays.** "Asked" describes an instant,
 * and left on the page it reads as a condition — misleading beside a table that
 * is telling you the actual state every ten seconds. A failure is the opposite:
 * nothing else on the page says it, so it stays until it is dismissed or
 * something else is said.
 */
export const teller = (show: (now: Said | null) => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const set = (now: Said | null) => {
    clearTimeout(timer);
    timer = undefined;
    show(now);
  };

  return {
    say: (text: string) => {
      set({ text, sticks: false });
      timer = setTimeout(() => set(null), SAID_MS);
    },
    fail:  (text: string) => set({ text, sticks: true }),
    clear: () => set(null),
    stop:  () => clearTimeout(timer),
  };
};
