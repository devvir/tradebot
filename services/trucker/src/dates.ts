/** Date helpers shared by the venues that construct URLs rather than list them. */

export const yesterdayUTC = (): string => {
  const d = new Date();

  d.setUTCDate(d.getUTCDate() - 1);

  return toYMD(d);
};

export const thisMonthUTC = (): string => new Date().toISOString().slice(0, 7).replace('-', '');

export const dateRange = (from: string, to: string): string[] => {
  const dates: string[] = [];
  const d   = fromYMD(from);
  const end = fromYMD(to);

  while (d <= end) {
    dates.push(toYMD(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return dates;
};

/** Last day of a `yyyymm`, so a monthly period orders against daily ones. */
export const endOfMonth = (month: string): string => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 0));

  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

export const monthRange = (from: string, to: string): string[] => {
  const months: string[] = [];
  const d   = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 4)}-${to.slice(4, 6)}-01T00:00:00Z`);

  while (d <= end) {
    months.push(d.toISOString().slice(0, 7).replace('-', ''));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }

  return months;
};

export const nextDay = (ymd: string): string => {
  const d = fromYMD(ymd);

  d.setUTCDate(d.getUTCDate() + 1);

  return toYMD(d);
};

export const prevMonth = (ym: string): string => {
  const d = new Date(`${ym.slice(0, 4)}-${ym.slice(4, 6)}-01T00:00:00Z`);

  d.setUTCMonth(d.getUTCMonth() - 1);

  return d.toISOString().slice(0, 7).replace('-', '');
};

export const nextMonth = (ym: string): string => {
  const d = new Date(`${ym.slice(0, 4)}-${ym.slice(4, 6)}-01T00:00:00Z`);

  d.setUTCMonth(d.getUTCMonth() + 1);

  return d.toISOString().slice(0, 7).replace('-', '');
};

/** An epoch-milliseconds timestamp as `yyyymmdd` — venue listing dates arrive as ms. */
export const msToYMD = (ms: number): string => toYMD(new Date(ms));

/** `20260727` → `2026-07-27`, the form most venues date their filenames with. */
export const dashed = (ymd: string): string =>
  `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

/** `202607` → `2026-07`. */
export const dashedMonth = (month: string): string =>
  `${month.slice(0, 4)}-${month.slice(4, 6)}`;

/** The later of two dates, where a missing side loses. */
export function latest(a: string, b: string): string;
export function latest(a: string | null, b: string | null): string | null;
export function latest(a: string | null, b: string | null): string | null {
  if (! a) return b;
  if (! b) return a;

  return a > b ? a : b;
}

/** The earlier of two dates, where a missing side loses. */
export function earliest(a: string, b: string): string;
export function earliest(a: string | null, b: string | null): string | null;
export function earliest(a: string | null, b: string | null): string | null {
  if (! a) return b;
  if (! b) return a;

  return a < b ? a : b;
}

// ── Internals ─────────────────────────────────────────────────────────────────

const toYMD = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, '');

const fromYMD = (ymd: string): Date =>
  new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
