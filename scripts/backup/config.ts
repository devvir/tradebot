export interface Config {
  /** MongoDB URL: `mongodb://user:pass@localhost:PORT?authSource=admin` */
  mongoUrl: string;
  /** Database to back up and prune. */
  database: string;
  /** Local directory where dump files are written. */
  dumpDir: string;
  /** Delete local dump files older than this many days. */
  retentionDays: number;
  /** Delete documents older than this many days from the live database. */
  pruneAgeDays: number;
}

/**
 * Builds a MongoDB URL from `DB_USER`, `DB_PASS`, and `DB_PORT`.
 *
 * `DB_URL` in `.env` uses shell variable interpolation that `process.loadEnvFile()`
 * does not expand, so individual vars are read instead and the URL is constructed here.
 * The host is always `localhost` — MongoDB must be port-mapped to the host via `DB_PORT`.
 */
const buildMongoUrl = (): string => {
  const user = process.env['DB_USER'];
  const pass = process.env['DB_PASS'];
  const port = process.env['DB_FEED_PORT'];

  if (! user || ! pass) throw new Error('DB_USER and DB_PASS must be set');

  return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@localhost:${port}/?authSource=admin`;
};

export const loadConfig = (): Config => ({
  mongoUrl:      buildMongoUrl(),
  database:      process.env['BACKUP_DATABASE']       ?? 'tradebot_archive',
  dumpDir:       process.env['DUMP_DIR']               ?? '/data/backups/tradebot',
  retentionDays: Number(process.env['DUMP_RETENTION_DAYS'] ?? '60'),
  pruneAgeDays:  Number(process.env['PRUNE_AGE_DAYS']      ?? '30'),
});
