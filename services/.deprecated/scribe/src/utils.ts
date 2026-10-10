/** Small helpers shared across modules. */

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const todayUtc = (): string =>
  new Date().toISOString().slice(0, 10).replace(/-/g, '');

export const nextDay = (date: string): string => {
  const y = parseInt(date.slice(0, 4));
  const m = parseInt(date.slice(4, 6)) - 1;
  const d = parseInt(date.slice(6, 8));

  return new Date(Date.UTC(y, m, d + 1)).toISOString().slice(0, 10).replace(/-/g, '');
};

/** YYYYMMDD → ISO midnight (start of that UTC day). */
export const dateToIso = (date: string): string => {
  const y = date.slice(0, 4);
  const m = date.slice(4, 6);
  const d = date.slice(6, 8);

  return `${y}-${m}-${d}T00:00:00.000Z`;
};
