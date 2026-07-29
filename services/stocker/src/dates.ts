/**
 * Every origin dates its files in the name, in one of four shapes. Reading the
 * date is shared rather than per-series: the shapes are few, unambiguous when
 * tried longest-first, and a venue that invents a fifth is better caught here
 * than duplicated across a hundred map entries.
 */
const SHAPES: RegExp[] = [
  /(\d{4})-(\d{2})-(\d{2})/,                    // 2026-07-24
  /(?<!\d)(\d{4})(\d{2})(\d{2})\d{2}(?!\d)/,    // 2026072716  — Gate's hourly books
  /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/,         // 20260724
  /(\d{4})-(\d{2})(?!-?\d)/,                    // 2026-07
  /(?<!\d)(\d{4})(\d{2})(?!\d)/,                // 202607
];

/** The month a file belongs to, as `YYYY-MM`. Null when nothing dates it. */
export const monthOf = (name: string): string | null => {
  for (const shape of SHAPES) {
    const m = shape.exec(name);

    if (m) return `${m[1]}-${m[2]}`;
  }

  return null;
};

/** The three shapes that carry a day; the month-only ones cannot. */
const DAILY = SHAPES.slice(0, 3);

/** The day a file covers, as `yyyymmdd`. Null for a monthly file. */
export const dayOf = (name: string): string | null => {
  for (const shape of DAILY) {
    const m = shape.exec(name);

    if (m) return `${m[1]}${m[2]}${m[3]}`;
  }

  return null;
};

/** The day after a `yyyymmdd`, in the same form. */
export const dayAfter = (day: string): string => {
  const next = new Date(Date.UTC(
    Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6)) + 1));

  return next.toISOString().slice(0, 10).replace(/-/g, '');
};

/** A `YYYY-MM` shifted by whole months, negative for earlier. */
export const monthShift = (month: string, by: number): string => {
  const [year, index] = month.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, index - 1 + by, 1));

  return shifted.toISOString().slice(0, 7);
};

/**
 * Last day of a month, as `yyyymmdd` — the form trucker publishes milestones in.
 *
 * A month is only complete once collection has passed its final day, so this is
 * what a settled-through date has to reach for the month to be safe to build.
 */
export const endOfMonth = (month: string): string => {
  const [year, index] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, index, 0));

  return last.toISOString().slice(0, 10).replace(/-/g, '');
};
