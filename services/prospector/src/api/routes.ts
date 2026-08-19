import { logger } from '@devvir/service-kit';
import {
  addExclusion, correctFile, enrolment, establishedAt, everCompleted, exclusions, fileOf, keyOf,
  lastRun,
  catalogFiles, markDownloaded, markPending, monthTotals, phaseOf, removeExclusion, standingOf,
  seriesById, seriesCounts, seriesFor, venueIds, venueTotals, withdrawFile,
} from '../catalog';
import { extensionOf, partOf } from '../catalog/shape';
import { intoMarkets, intoShapes, intoSymbols } from '../catalog/contents';
import { GRAINS, levelsOf } from '../canonical';
import { adaptersForVenue } from '../venues';
import type { Application, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Adapter, Cursor, Listed, MonthState, Offered, Grain, Pending, Reported, SeriesFilter,
  Surveys,
} from '../types';

/**
 * The catalog, as everyone else reaches it.
 *
 * Prospector is the only process that opens the database, so every question and
 * every change any other service has arrives here — including from another
 * machine, since surveying is expected to run where the link is good rather than
 * where the downloading happens.
 *
 * **A venue is a venue.** Bybit publishes its order books on a second host and
 * that is this service's business: it appears in no path, no parameter and no
 * response field. A caller asks about `bybit` and gets bybit.
 */

/**
 * What a skipped venue actually is, said as a fact rather than as a refusal.
 *
 * Keyed by the reason the API returns, because the two audiences want opposite
 * framings: a caller asked us to do something and needs to know why we did not,
 * while somebody reading the log after a restart needs to know the venue's
 * state. "Nothing to resume" answers the first and misleads the second — it
 * reads as neglect when it means finished.
 */
const STATE: Record<string, string> = {
  'nothing to resume':        'Survey already complete',
  'already running':          'Survey already running',
  'already updating':         'Update already running — nothing to bring forward',
  'a survey is already open': 'Survey already open — resume it rather than starting another',

  'no pass has completed — walk it first':
    'Update refused — no pass has finished, so there is nothing to update from',
};

/** How many rows a list returns when nobody says, and the most it ever will. */
const LIMIT     = 1000;
const MAX_LIMIT = 10_000;

export const setupRoutes = (app: Application, db: DatabaseSync, surveys: Surveys): void => {
  /**
   * Where a downloader starts.
   *
   * Only venues that can actually be worked on appear — one with no scanner is
   * absent rather than listed as empty, so no caller needs to know it exists.
   */
  app.get('/venues', (_req, res) => {
    const rows   = venueTotals(db).filter(row => surveyable(row.venue));

    /** One pass for every venue, rather than one filtered scan per venue. */
    const counts = seriesCounts(db);

    res.json({
      items: rows.map(row => ({
        ...row,

        /**
         * **Summed over the venue's servers.** A venue listed once here may be
         * several ids — bybit publishes its books from a second host — and the
         * progress a reader wants is the venue's, not one server's.
         */
        series:      venueIds(db, row.venue).reduce((sum, id) => {
          const held = counts.get(id);

          return {
            withFiles: sum.withFiles + (held?.withFiles ?? 0),
            total:     sum.total     + (held?.total     ?? 0),
          };
        }, { withFiles: 0, total: 0 }),

        established: establishedFor(db, row.venue),

        /**
         * **What the venue's most recent pass was, and whether it is still
         * going.** `established` is a completion time and cannot say either: a
         * venue three hours into its first walk has never completed one, and
         * reads identically to a venue nobody has ever surveyed.
         */
        lastRun:     lastRun(db, venueIds(db, row.venue)),
      })),
    });
  });

  app.get('/venues/:venue/months', (req, res) => months(db, req, res));
  app.get('/venues/:venue/months/open', (req, res) => months(db, req, res, 'open'));
  app.get('/venues/:venue/months/closed', (req, res) => months(db, req, res, 'closed'));

  /** One month is a resource: it exists or it does not. */
  app.get('/venues/:venue/months/:month', (req, res) => {
    const ids = idsFor(db, req, res);

    if (! ids) return;

    const [found] = monthTotals(db, ids, { in: [String(req.params['month'])] });

    if (! found) {
      res.status(404).json({ error: 'No such month' });

      return;
    }

    res.json(found);
  });

  /**
   * **What this venue publishes, in canonical terms** — the endpoint for
   * deciding what to want before fetching anything.
   *
   * One row per `(market, dataset, variant, grain)`: which bar lengths, which
   * book depths and modes, whether a month is filed monthly or a day at a time,
   * whether there is a venue-wide file or only per-instrument ones, and over what
   * span. A caller wanting the coarse view collapses the rows it gets.
   *
   * Narrowed by the same filters a listing takes — `market`, `dataset`,
   * `variant`, `period` — so "what kline intervals does this venue have" is
   * `?dataset=klines`, and "does it have books, and at what depths" is
   * `?dataset=books`.
   *
   * Answered from the patterns and their series, which are thousands of rows
   * where files are millions, so it costs nothing to ask.
   */
  app.get('/venues/:venue/shapes', (req, res) => contents(db, req, res, 'shapes'));

  /**
   * **What the catalog holds, walked rather than queried.**
   *
   * The same rows `/shapes` folds, offered one level at a time so a person can
   * find their way down without knowing the filters — which is what makes it
   * answerable from a browser. Every level is a projection of one read, so no
   * two of them can disagree about whether a retired pattern counts or what an
   * unstated end means.
   *
   * Deliberately three levels deep and no further. A `/datasets` level below
   * this one would carry the same rows grouped, and `/datasets/:dataset` the
   * same rows filtered — a query parameter wearing a path segment. The largest
   * market answers 130 rows, so there is nothing to page and nothing to split.
   */
  app.get('/contents/venues', (_req, res) => {
    const rows   = venueTotals(db).filter(row => surveyable(row.venue));

    /** One pass for every venue, rather than one filtered scan per venue. */
    const counts = seriesCounts(db);

    res.json({
      items: rows.map(row => ({
        ...row,

        /**
         * **Summed over the venue's servers.** A venue listed once here may be
         * several ids — bybit publishes its books from a second host — and the
         * progress a reader wants is the venue's, not one server's.
         */
        series:      venueIds(db, row.venue).reduce((sum, id) => {
          const held = counts.get(id);

          return {
            withFiles: sum.withFiles + (held?.withFiles ?? 0),
            total:     sum.total     + (held?.total     ?? 0),
          };
        }, { withFiles: 0, total: 0 }),

        established: establishedFor(db, row.venue),

        /**
         * **What the venue's most recent pass was, and whether it is still
         * going.** `established` is a completion time and cannot say either: a
         * venue three hours into its first walk has never completed one, and
         * reads identically to a venue nobody has ever surveyed.
         */
        lastRun:     lastRun(db, venueIds(db, row.venue)),
      })),
    });
  });

  app.get('/contents/venues/:venue', (req, res) => contents(db, req, res, 'markets'));

  app.get('/contents/venues/:venue/symbols', (req, res) => contents(db, req, res, 'symbols'));

  app.get('/contents/venues/:venue/markets/:market', (req, res) =>
    contents(db, req, res, 'shapes'));

  app.get('/contents/venues/:venue/markets/:market/symbols', (req, res) =>
    contents(db, req, res, 'symbols'));

  /**
   * Every file the catalog holds for a venue, oldest first.
   *
   * **The listing this service exists to serve.** A consumer names what it wants
   * in the catalog's own vocabulary — `perp` `klines` at `1h`, monthly, these
   * instruments, this range — and is answered with URLs that work. Which tree a
   * venue files those under, how it spells the interval and where the date sits
   * in the name are all resolved here, because that is the knowledge this
   * service exists to hold.
   *
   * Every parameter is optional and absent means *any*, so no parameters at all
   * is the whole venue. The one exception is naming instruments that do not
   * exist: an explicit set that matches no series is a filter that matched
   * nothing, and is answered with nothing.
   *
   * | | |
   * |---|---|
   * | `market` `dataset` `variant` | case-blind, in canonical terms |
   * | `symbol` | repeatable, or comma-separated. The venue's own name for it |
   * | `period` | `monthly` `daily` `hourly` `minutely` — which rendering |
   * | `month` | a whole calendar month, whatever grain its files are in |
   * | `from` `to` | bounds in each series' own grain, for callers that mean it |
   * | `downloaded` | `true`, `false`, or absent for either |
   * | `after` `limit` | paging |
   */
  app.get('/venues/:venue/files', (req, res) => listing(db, req, res, downloadState(req)));

  /**
   * The same listing, narrowed to what is still owed.
   *
   * **A shortcut, not a second endpoint** — it is `GET /venues/:venue/files`
   * with `downloaded=false` fixed, which is what a downloader asks for every
   * time and should not have to say. Every other parameter behaves identically,
   * because it *is* the same handler.
   */
  app.get('/venues/:venue/pending', (req, res) => listing(db, req, res, false));

  /**
   * What became of a page, from whoever downloaded it.
   *
   * **The caller reports problems; this service rules on them.** Nothing here
   * takes a caller's word for what a venue serves: a key that would not deliver
   * and a file whose bytes disagree are both checked against the venue before
   * anything is written, and what the venue says is what gets recorded.
   *
   * That is what lets a partition finish. A key the catalog keeps offering and
   * the downloader keeps failing to fetch holds its month open — correctly,
   * since one of the two is wrong — until a probe settles which.
   */
  app.post('/venues/:venue/report', async (req, res) => {
    const ids = idsFor(db, req, res);

    if (! ids) return;

    const body = req.body as Partial<Reported> | undefined;

    const downloaded = Array.isArray(body?.downloaded) ? body.downloaded : [];
    const failed     = Array.isArray(body?.failed) ? body.failed : [];
    const mismatched = Array.isArray(body?.mismatched) ? body.mismatched : [];

    if (downloaded.length + failed.length + mismatched.length > MAX_LIMIT) {
      res.status(400).json({ error: `At most ${MAX_LIMIT} keys per report` });

      return;
    }

    const files = downloaded.map(fileOf).filter((one): one is NonNullable<typeof one> => one !== null);

    const recorded = markDownloaded(db, files, new Date().toISOString());

    /**
     * **A file that would not come is asked about, not believed.** The venue
     * either still serves it — so it stays owed and comes round again — or it
     * has gone, and is ruled absent so nothing is left outstanding.
     */
    let withdrawn = 0;

    for (const key of failed) {
      const file = fileOf(key);

      if (! file) continue;

      const adapter = adapterFor(db, file.venueId);
      const seen    = adapter ? await confirm(db, adapter, file.path) : null;

      if (seen) {
        logger.warn({ path: file.path },
          'Reported as undownloadable, but the venue still serves it — leaving it owed');

        continue;
      }

      withdrawn += withdrawFile(db, file.venueId, file.path) ? 1 : 0;
    }

    /** A disagreement about the bytes is settled the same way: by asking. */
    let corrected = 0;

    for (const one of mismatched) {
      const file = fileOf(one.key);

      if (! file) continue;

      corrected += await reconcile(db, file, one, false) ? 1 : 0;
    }

    res.json({ recorded, withdrawn, corrected });
  });

  /**
   * Records a batch as on disk.
   *
   * **Nothing here is transactional with the download itself, on purpose.** A
   * file fetched but never reported comes round in the next batch, where the
   * downloader finds it already on disk and reports it then — which is also what
   * lets a machine whose archive is already there be adopted with no seeding
   * step.
   */
  app.post('/venues/:venue/downloaded', async (req, res) => {
    const ids = idsFor(db, req, res);

    if (! ids) return;

    const keys = Array.isArray(req.body?.keys) ? req.body.keys as string[] : null;

    if (! keys) {
      res.status(400).json({ error: 'keys must be an array' });

      return;
    }

    if (keys.length > MAX_LIMIT) {
      res.status(400).json({ error: `At most ${MAX_LIMIT} keys per request` });

      return;
    }

    const files = keys.map(fileOf).filter((one): one is NonNullable<typeof one> => one !== null);

    /**
     * A report that the bytes differ is not an error — it is the archive having
     * changed, with the downloader holding the new version. Each is confirmed
     * against the venue before it is believed, then recorded on its own.
     */
    const observed = (req.body?.observed ?? {}) as Record<string, Partial<Listed>>;
    let   settled  = 0;

    for (const [key, seen] of Object.entries(observed)) {
      const file = fileOf(key);

      if (! file) continue;

      settled += await reconcile(db, file, seen) ? 1 : 0;
    }

    const plain = files.filter(file => ! observed[keyOf(file.venueId, file.path)]);

    res.json({ recorded: markDownloaded(db, plain, new Date().toISOString()) + settled });
  });

  app.post('/venues/:venue/downloaded/:key', (req, res) => one(db, req, res, true));
  app.delete('/venues/:venue/pending/:key', (req, res) => one(db, req, res, true));
  app.post('/venues/:venue/pending/:key', (req, res) => one(db, req, res, false));
  app.delete('/venues/:venue/downloaded/:key', (req, res) => one(db, req, res, false));

  /**
   * Corrects what is recorded, outside the download flow entirely — a one-time
   * script, something tooling noticed, a person who checked. Confirmed the same
   * way a mismatched download report is, and the file stays owed: whoever is
   * calling has not said they hold these bytes.
   */
  app.patch('/venues/:venue/files/:key', async (req, res) => {
    const file = fileOf(String(req.params['key']));

    if (! file) {
      res.status(404).json({ error: 'No such file' });

      return;
    }

    const done = await reconcile(db, file, req.body ?? {}, false);

    res.status(done ? 200 : 409).json(done ? { corrected: true } : { error: 'Could not confirm' });
  });

  /**
   * The half of exclusion that can only be **listed**.
   *
   * A truncated copy of the wrong file at a real URL is not a pattern, and the
   * next one will not resemble it — so these are rows, and finding a bad file
   * costs a request rather than a rebuild and a redeploy. Anything that *can* be
   * described belongs in an adapter's `accepts`, in code, where it also covers
   * keys nobody has published yet.
   */
  app.get('/venues/:venue/exclusions', (req, res) => {
    const ids = idsFor(db, req, res);

    if (! ids) return;

    res.json({ items: ids.flatMap(id => exclusions(db, id))
      .map(row => ({ key: keyOf(row.venueId, row.path), path: row.path, reason: row.reason })) });
  });

  /**
   * **Applied to every server of the venue**, so a caller never has to know that
   * one of them is served from two machines. A path that only exists on one is
   * harmless on the other: exclusions match exactly, so it can never fire there.
   *
   * Nothing already catalogued is removed. This says what must not be *fetched*
   * again; what a venue once published stays on record, and deciding what to do
   * about a copy already on disk is a separate act.
   */
  app.post('/venues/:venue/exclusions', (req, res) => {
    const ids  = idsFor(db, req, res);

    if (! ids) return;

    const path   = optional(req.body?.path);
    const reason = optional(req.body?.reason);

    if (! path || ! reason) {
      res.status(400).json({ error: 'path and reason are both required' });

      return;
    }

    for (const id of ids) addExclusion(db, id, path, reason);

    res.json({ excluded: path, keys: ids.map(id => keyOf(id, path)) });
  });

  /** Lift one, by the key the listing handed out. */
  app.delete('/venues/:venue/exclusions/:key', (req, res) => {
    const file = fileOf(String(req.params['key']));

    if (! file) {
      res.status(404).json({ error: 'No such exclusion' });

      return;
    }

    res.json({ lifted: removeExclusion(db, file.venueId, file.path) });
  });

  /**
   * Start a run, or continue the one there is.
   *
   * **"Add a survey", and what that means depends on where the venue is.** A
   * venue with nothing starts; one with work outstanding continues from its
   * cursors; one that has been complete finds what has appeared since. None of
   * those is a separate verb, because none of them is a separate decision for a
   * caller to make — see `phaseOf`.
   *
   * **Two modifiers, and they are the only decisions a caller makes.**
   *
   * `refresh: true` throws the progress away first and walks it all again. It is
   * opt-in precisely so that the ordinary request can never silently discard a
   * backfill in flight.
   *
   * `update: true` skips the wait and updates now. It is refused where no pass
   * has ever finished — there is nothing to update from — and does nothing where
   * an update is already running.
   *
   * They are mutually exclusive: one discards everything and the other builds on
   * it, so a request asking for both has not decided.
   */
  app.post('/surveys', (req, res) => surveying(db, req, res, surveys));

  /**
   * The same thing for one venue, named where it reads most naturally.
   *
   * **A shortcut, not a second endpoint.** It resolves to exactly the request
   * `POST /surveys` would have made with that venue in its body — same phases,
   * same refusal when one is already running, same `refresh` — because it *is*
   * that request by the time anything acts on it. A venue this build cannot read
   * is a 404 here as it is there.
   */
  app.post('/venues/:venue/surveys', (req, res) => surveying(db, req, res, surveys));

  /**
   * Stop surveys where they are — one venue, several, or every one of them.
   *
   * **Symmetrical with starting them**, deliberately: the same `venue` argument,
   * absent meaning all. And there is no matching resume, because starting a
   * paused venue *is* resuming it — a pause keeps every cursor, so nothing else
   * would have anything to do.
   */
  app.post('/surveys/pause', (req, res) => {
    const asked = requested(req, res, surveys);

    if (! asked) return;

    const paused:  string[] = [];
    const skipped: { venue: string; reason: string }[] = [];

    for (const venue of asked)
      if (surveys.pause(venue)) paused.push(venue);
      else skipped.push({ venue, reason: 'not running' });

    if (paused.length > 0) logger.info({ venues: paused }, 'Pause requested');

    res.json({ at: new Date().toISOString(), paused, skipped });
  });

  /** The figures as the caches hold them, so they can be read without the database. */
  app.get('/status', (req, res) => {
    const only  = optional(req.query['venue']);
    /** One pass for every venue, rather than one filtered scan per venue. */
    const counts = seriesCounts(db);

    const items = venueTotals(db)
      .filter(row => ! only || row.venue === only)
      .map(row => {
        const ids = venueIds(db, row.venue);

        return {
          ...row,
          established: establishedFor(db, row.venue),
          lastRun:     lastRun(db, ids),

          /**
           * **How far the venue has got, per series.** Summed over its servers:
           * a venue listed once here may be several ids, and the progress a
           * reader wants is the venue's rather than one server's.
           */
          series:      ids.reduce((sum, id) => {
            const held = counts.get(id);

            return {
              withFiles: sum.withFiles + (held?.withFiles ?? 0),
              total:     sum.total     + (held?.total     ?? 0),
            };
          }, { withFiles: 0, total: 0 }),

          /**
           * **One word for where the venue stands, and the facts behind it.**
           *
           * This used to report an open job beside a boolean and leave the
           * reader to work out the rest, which could not distinguish the two
           * states a person most needs to tell apart: a venue between passes and
           * a venue nobody has ever asked about both showed as not surveying.
           */
          ...standingOf(db, row.venue, ids, surveys.everyMs()),

          /**
           * **Whether this process has a loop alive**, which is not the same as
           * work being outstanding. An open job with nothing surveying is what a
           * killed container leaves behind; the pair is kept side by side
           * because they want opposite responses.
           */
          surveying:   surveys.running(row.venue),

          /** Asked to stop, and still finishing the page it was on. */
          stopping:    surveys.stopping(row.venue),

          /**
           * **Whether there is a keyspace to walk at all.**
           *
           * A venue whose bucket refuses `ListObjects` has none: its series are
           * declared and every pass is an update over them, so a re-survey has
           * nothing to re-read. Saying so here is what stops a caller offering
           * work that cannot happen — see okx and bitget, where `refresh` drops
           * the run rows and the walk that follows finds nothing to walk.
           *
           * A venue listed here with no adapter at all is not listable either:
           * nothing can walk it, whatever the reason.
           */
          listable:    adaptersForVenue(row.venue).some(one => one.listable !== false),
          wip:         ids.reduce((total, id) => total + parked(db, id), 0),
        };
      });

    res.json({ items });
  });
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Start or resume surveys.
 *
 * **`venue` is optional, and leaving it out means all of them.** Venues are
 * unrelated hosts with their own limiters and are already surveyed
 * concurrently, so asking for one at a time buys nothing — and the ordinary
 * request is "go and look at everything".
 *
 * Named venues are checked against the **registry**, never against the catalog's
 * `venue` table: that table is written *by* a survey, so on a fresh database it
 * is empty and validating against it would mean no first survey could ever
 * start.
 *
 * **One verb.** A venue with an open job continues it, one that is complete
 * updates, one that has never run starts — none of which is a caller's decision.
 * `refresh: true` is the exception, and drops the run rows before any of that.
 *
 * It does not wait for the walk — a survey runs for hours, and `GET /status` is
 * where its progress lives. A venue that cannot be acted on is reported rather
 * than failing the request, because with several venues in one call some will be
 * busy and some will not.
 */
const surveying = (
  db:      DatabaseSync,
  req:     Request,
  res:     Response,
  surveys: Surveys,
): void => {
  const refresh = req.body?.refresh === true;
  const forced  = req.body?.update === true;

  if (refresh && forced) {
    res.status(400).json({
      error: 'refresh and update are mutually exclusive — one discards the progress the other builds on',
    });

    return;
  }

  const asked = requested(req, res, surveys);

  if (! asked) return;

  const venues  = asked;
  const started: string[] = [];
  const resumed: string[] = [];
  const skipped: { venue: string; reason: string }[] = [];
  const doing:   { venue: string; phase: string }[] = [];

  /**
   * **Said on arrival, before any of the work.** Whoever sent this is watching
   * the log for it, and the passes themselves begin a turn later — see `survey`
   * in `index.ts` — so this is the line that says the order was received.
   */
  logger.info({ venues, refresh, update: forced }, 'Surveys requested — starting shortly');

  for (const venue of venues) {
    const ids = venueIds(db, venue);

    /**
     * **A forced update is refused where no pass has ever finished.** There is
     * nothing to update *from*: the venue is mid-walk, or has never run, and
     * what it needs is the walk it is already owed rather than a second kind of
     * pass planned against bounds nothing has established.
     *
     * **Whether it is paused makes no difference to that.** A pause during the
     * walk fails for the ordinary reason, and one during an update is the case
     * below — the pause is not the question, what it interrupted is.
     */
    if (forced) {
      if (! ids.some(id => everCompleted(db, id))) {
        skipped.push({ venue, reason: 'no pass has completed — walk it first' });

        continue;
      }

      const open = ids.some(id => enrolment(db, id).open === 'update');

      /**
       * **An update open and being worked is already what was asked for**, and
       * a loop does not end on its own, so there is nothing to add to it.
       */
      if (open && surveys.running(venue)) {
        skipped.push({ venue, reason: 'already updating' });

        continue;
      }

      /**
       * **An update open with nothing working it is resumed, and reported as a
       * resume.** From outside the two are identical and they are not the same
       * thing: this carries on from partition cursors that already exist, where
       * a new update would plan fresh scopes. Somebody told "update started"
       * about work that was half done has been told the wrong thing.
       *
       * That is what a pause during an update leaves, and equally what a killed
       * container leaves — neither needs its own rule.
       */
      if (open) resumed.push(venue);
    }

    /**
     * **A venue already surveying is already doing what was asked**, since the
     * loop that walks it then updates it daily does not end on its own. So an
     * ordinary request adds nothing and says so, rather than starting a second
     * loop against the same host.
     *
     * The modifiers are the exceptions, and the only ones: a refresh is the
     * request to throw the progress away and a forced update the request to stop
     * waiting, and both mean stopping the loop first. That sequencing belongs
     * where the loop is — see `survey` in `index.ts` — because interrupting from
     * out here would drop rows a live walk is still committing against.
     */
    if (surveys.running(venue) && ! refresh && ! forced) {
      skipped.push({ venue, reason: 'already running' });

      continue;
    }

    surveys.start(venue, forced ? 'partial' : 'full', refresh);

    if (! resumed.includes(venue)) started.push(venue);

    // Read for the answer rather than to decide: a caller wants to know whether
    // this is a backfill or a catch-up, and nothing else in the reply says.
    doing.push({ venue, phase: refresh ? 'not run' : (ids.map(id => phaseOf(db, id))[0] ?? 'not run') });
  }

  /**
   * **A venue with nothing to do says what it *is*, not what we declined to do
   * to it.** The answer goes back over HTTP, but whoever restarted the service
   * is reading the log, and silence there is indistinguishable from a venue that
   * was forgotten. "Not surveyed" reads as neglect; the fact is the opposite —
   * it was surveyed already, and that is the result worth stating.
   */
  for (const one of skipped)
    logger.info({ venue: one.venue }, STATE[one.reason] ?? `Not surveyed: ${one.reason}`);

  /**
   * **A modifier that moved nothing is a failed request, not an empty success.**
   *
   * An ordinary request finding every venue current has done its job — that is
   * the venue already being kept up to date. A `update: true` that started
   * nothing means the one thing it was for did not happen, and answering 200 to
   * that puts the reason in a field somebody has to go and read.
   */
  if (forced && started.length === 0 && resumed.length === 0) {
    /**
     * **One venue asked gets its own reason back**, rather than a summary it
     * then has to look up. "No pass has completed — walk it first" is the whole
     * answer, and with several venues in the request there is no single one.
     */
    const why = skipped.length === 1 ? `Nothing to update: ${skipped[0]!.reason}` : 'Nothing to update';

    res.status(409).json({ error: why, skipped });

    return;
  }

  res.json({
    at: new Date().toISOString(),
    started,
    resumed,
    skipped,
    phases: Object.fromEntries(doing.map(one => [one.venue, one.phase])),
  });
};

/**
 * Which venues a request is about: the ones it names, or all of them.
 *
 * **Named venues are checked against the registry, never against the catalog's
 * `venue` table**, which is written *by* a survey — on a fresh database it is
 * empty, and validating against it would mean no first survey could ever start.
 *
 * Answers `null` once it has already replied, so a caller returns rather than
 * deciding again what went wrong.
 */
const requested = (req: Request, res: Response, surveys: Surveys): string[] | null => {
  /**
   * **The path wins where there is one**, which is what makes
   * `/venues/:venue/surveys` a shortcut rather than a second implementation: it
   * is the same request with the venue named somewhere more convenient, and
   * everything after this point cannot tell the two apart.
   */
  const named = req.params['venue'];
  const body  = named ?? req.body?.venue as unknown;
  const asked = body === undefined || body === null ? []
    : Array.isArray(body) ? body.map(String)
      : [String(body)];

  const known   = surveys.venues();
  const unknown = asked.filter(one => ! known.includes(one));

  if (unknown.length > 0) {
    res.status(404).json({ error: 'No such venue', unknown, venues: known });

    return null;
  }

  return asked.length > 0 ? asked : known;
};

/** Whether anything here can actually read this venue. */
const surveyable = (venue: string): boolean => {
  try {
    return adaptersForVenue(venue).some(one => one.scanner.name !== 'none');
  } catch {
    return false;
  }
};

/**
 * One page of a venue's files, however the caller narrowed it.
 *
 * **Narrowing by series is a different query, not the same one with a filter.**
 * Which series are a venue's `perp` `klines` at `1h` is answered from the
 * registry in memory — series are counted in thousands where files are counted
 * in millions — so what reaches SQLite is "the files of these series in this
 * range", which `file_series` indexes directly, one seek each.
 */
const listing = (
  db:         DatabaseSync,
  req:        Request,
  res:        Response,
  downloaded: boolean | undefined,
): void => {
  const ids = idsFor(db, req, res);

  if (! ids) return;

  const grain = optional(req.query['grain']);

  if (grain !== undefined && ! (GRAINS as readonly string[]).includes(grain)) {
    res.status(400).json({ error: `grain must be one of ${GRAINS.join(', ')}` });

    return;
  }

  const filter: SeriesFilter = {
    ...optionally('market',  optional(req.query['market'])),
    ...optionally('dataset', optional(req.query['dataset'])),
    ...optionally('variant', optional(req.query['variant'])),
    ...(grain ? { grain: grain as Grain } : {}),
    ...(symbolsOf(req.query['symbol']) ? { symbols: symbolsOf(req.query['symbol'])! } : {}),
  };

  const limit = capped(req.query['limit']);
  const after = decodeCursor(req.query['after']);

  /**
   * **`month` is the parameter that means what a caller wants**, and the only
   * one that gets a whole month right: `date` holds each series' own grain, so
   * a month is matched the way any prefix on a sorted key is — `>= '202506'` and
   * `< '202507'` — rather than with an inclusive `to`, which is the wrong
   * operator for a prefix at any grain.
   */
  const month = optional(req.query['month']);

  // One more than asked for, so "is there another page" is answered by the rows
  // themselves rather than by a second count over the same range.
  const rows = catalogFiles(db, ids, {
    from:  month ?? optional(req.query['from']),
    to:    month ? undefined : optional(req.query['to']),
    until: month ? nextMonth(month) : undefined,
    after,
    limit: limit + 1,
    ...(downloaded === undefined ? {} : { downloaded }),
    ...(Object.keys(filter).length > 0
      ? { series: ids.flatMap(id => seriesFor(db, id, filter).map(one => one.id!)) }
      : {}),
  });

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  res.json({
    items: page.map(row => offered(db, row)),
    limit,

    /**
     * A narrowed listing carries the series it stopped in, because it walks its
     * series in turn rather than along one ordering across the venue.
     */
    next: rows.length > limit && last
      ? encodeCursor({
        date:    last.date,
        path:    last.path,
        venueId: last.venueId,
        seriesId: last.seriesId,
      })
      : null,
  });
};

/**
 * Which download state a listing is asking about, or undefined for either.
 *
 * **Absent is not `false`.** A caller that says nothing wants the catalog's
 * whole answer; only `/pending` means "owed", and it says so itself rather than
 * relying on a default that would make the general endpoint the narrow one.
 */
const downloadState = (req: Request): boolean | undefined => {
  const asked = optional(req.query['downloaded']);

  return asked === undefined ? undefined : asked !== 'false';
};

/**
 * The instruments a request named, however it named them.
 *
 * Repeated parameters and one comma-separated value are the same request said
 * two ways, and a caller should not have to know which this accepts. Nothing
 * named at all is no filter; naming only blanks is the same thing, since a
 * caller that meant "no instruments" had to type one.
 */
const symbolsOf = (value: unknown): string[] | undefined => {
  const raw = Array.isArray(value) ? value.map(String)
    : typeof value === 'string' ? value.split(',')
      : [];

  const named = raw.map(one => one.trim()).filter(Boolean);

  return named.length > 0 ? named : undefined;
};

/**
 * One read of the catalog, projected however the route asked for it.
 *
 * **The single point of access, with the routes as a thin interface over it.**
 * Which markets a venue has, which datasets a market has, and which instruments
 * carry them are the same series rows counted three ways — so they are folds of
 * one result rather than three queries. Three queries could each decide
 * differently whether a retired pattern counts or whether an unstated end means
 * open, and the levels of one namespace disagreeing is worse than any of the
 * answers being wrong on its own.
 *
 * The filter is assembled from whatever the route supplied — a path segment and
 * a query parameter are the same narrowing here — so `/markets/:market` and
 * `?market=` cannot mean different things.
 */
const contents = (
  db:   DatabaseSync,
  req:  Request,
  res:  Response,
  give: 'shapes' | 'markets' | 'symbols',
): void => {
  const ids = idsFor(db, req, res);

  if (! ids) return;

  const grain = optional(req.query['grain']);

  if (grain !== undefined && ! (GRAINS as readonly string[]).includes(grain)) {
    res.status(400).json({ error: `grain must be one of ${GRAINS.join(', ')}` });

    return;
  }

  const filter: SeriesFilter = {
    ...optionally('market',  optional(req.params['market']) ?? optional(req.query['market'])),
    ...optionally('dataset', optional(req.query['dataset'])),
    ...optionally('variant', optional(req.query['variant'])),
    ...(grain ? { grain: grain as Grain } : {}),
  };

  const rows = ids.flatMap(id => seriesFor(db, id, filter));

  res.json({ items: give === 'markets' ? intoMarkets(rows)
    : give === 'symbols' ? intoSymbols(rows)
      : intoShapes(rows) });
};

const months = (db: DatabaseSync, req: Request, res: Response, state?: MonthState): void => {
  const ids = idsFor(db, req, res);

  if (! ids) return;

  res.json({ items: monthTotals(db, ids, {
    state: state ?? (optional(req.query['state']) as MonthState | undefined),
    from:  optional(req.query['from']),
    to:    optional(req.query['to']),
    in:    optional(req.query['in'])?.split(',').map(one => one.trim()).filter(Boolean),
  }) });
};

/** The two collections, from either side: the same move, named twice. */
const one = (db: DatabaseSync, req: Request, res: Response, downloaded: boolean): void => {
  const file = fileOf(String(req.params['key']));

  if (! file) {
    res.status(404).json({ error: 'No such file' });

    return;
  }

  const moved = downloaded
    ? markDownloaded(db, [file], new Date().toISOString()) === 1
    : markPending(db, file.venueId, file.path);

  res.json({ moved });
};

/**
 * Check a claim against the venue, then record what the venue said.
 *
 * **What prospector confirms is what gets written, not what it was told.** A
 * downloader is almost always right — an archive is insert-only unless somebody
 * erred — but almost always is not a thing to write into a database on, and the
 * alternative to asking is finding out at the next full survey, days away. It
 * costs one request and fires almost never.
 *
 * A disagreement is logged loudly and the file stays owed: whatever the caller
 * holds, it demonstrably is not what the venue is serving.
 */
const reconcile = async (
  db:         DatabaseSync,
  file:       { venueId: number; path: string },
  claimed:    Partial<Listed>,
  downloaded = true,
): Promise<boolean> => {
  const adapter = adapterFor(db, file.venueId);

  if (! adapter) return false;

  const seen = await confirm(db, adapter, file.path);

  if (! seen) {
    logger.warn({ path: file.path, claimed }, 'Could not confirm a reported change');

    return false;
  }

  // The ETag is compared case-blind: the case is the server's, not the file's,
  // and a downloader that upper-cased what a venue lower-cased has not seen a
  // different file.
  const agrees = (claimed.size == null || claimed.size === seen.size)
    && (claimed.etag == null || claimed.etag.toLowerCase() === seen.etag?.toLowerCase());

  if (! agrees)
    logger.error({ path: file.path, claimed, seen },
      'A reported change does not match the venue — recording what the venue says');

  return correctFile(
    db, file.venueId, file.path,
    { size: seen.size, etag: seen.etag, modified: seen.modified },
    new Date().toISOString(),
    downloaded && agrees,
  );
};

/**
 * Ask the venue about one key, through the context its scanner expects.
 *
 * **A scanner is never handed an adapter.** It is written against the context
 * its venue builds — `text` and `head` already paced, or a set of ranges — and
 * an adapter carries none of those, so passing one meant every confirmation
 * threw and was swallowed as "could not confirm". The generic `Scanner<any>` in
 * the registry is what let that compile.
 *
 * Built per call rather than held, with `'lookup'` as the occasion — the one
 * that reaches no venue, so an adapter cannot turn a single confirmation into an
 * unbounded call inside a request handler.
 */
const confirm = async (
  db:      DatabaseSync,
  adapter: Adapter,
  path:    string,
): Promise<Listed | null> => {
  try {
    return await adapter.scanner.confirm(await adapter.getContext(db, 'lookup'), path);
  } catch {
    return null;
  }
};

const idsFor = (db: DatabaseSync, req: Request, res: Response): number[] | null => {
  const venue = String(req.params['venue']);
  const ids   = venueIds(db, venue);

  if (ids.length === 0) {
    res.status(404).json({ error: 'No such venue' });

    return null;
  }

  return ids;
};

/** Market, then dataset, then variant, then grain — the order somebody reads in. */
/**
 * A catalogued row as a downloader receives it: what the file *is*, plus an
 * opaque URL.
 *
 * **The whole point of the listing.** A downloader that read paths would have to
 * learn how every venue arranges its archive and be taught again whenever one
 * moved — so which market, which instrument, which dataset and which bar length
 * are resolved here, where that knowledge already lives, and handed over as
 * fields. What crosses the wire is facts about the data and a string to fetch.
 *
 * Every catalogued row has a series — a path this service cannot place is not
 * catalogued at all — so these fields are answers rather than best efforts. The
 * fallbacks below cover only a registry that has yet to see a row the file
 * table already references.
 */
const offered = (db: DatabaseSync, row: Pending): Offered => {
  const series = seriesById(db, row.seriesId);
  const shape  = series?.pattern ?? '';

  return {
    ...row,
    key:     keyOf(row.venueId, row.path),
    url:     urlFor(db, row.venueId, row.path),
    market:  series?.market ?? '',
    dataset: series?.dataset ?? '',
    grain:   series?.grain ?? '',

    /**
     * **The venue's own name for the instrument, not the archive's spelling.**
     * Okx serves a futures family as `<name>-futureschain`; that is a fact about
     * its URLs and stops here.
     */
    symbol:  series?.symbol ?? '',

    /**
     * **Named on the way out.** The catalog stores the levels as one string
     * because a path is one string, but `400,incremental` is two facts about a
     * book — so a consumer is handed `{ depth, mode }` and never has to split a
     * comma or count positions. Absent where the dataset has no level below it.
     */
    ...(series && series.variant
      ? { variant: levelsOf(series.dataset, series.variant) }
      : {}),
    ...optionally('part', partOf(row.path, shape)),
    ext:     extensionOf(row.path),
  };
};

/** Leave a field out entirely rather than send it null. */
const optionally = (name: string, value: string | undefined): Record<string, string> =>
  value === undefined ? {} : { [name]: value };

/**
 * A file's URL, composed here rather than stored or built by the caller.
 *
 * How a venue addresses its own keys is this service's knowledge; a downloader
 * that built URLs would have to be taught the rule and taught again whenever a
 * venue moved. The venue rows are a handful, so this is a lookup rather than a
 * join, and one that moves its archive is a restart.
 */
const urlFor = (db: DatabaseSync, venueId: number, path: string): string => {
  const row = db.prepare('SELECT base, root FROM venue WHERE id = ?')
    .get(venueId) as { base: string; root: string } | undefined;

  return row ? `${row.base.replace(/\/$/, '')}/${row.root}${path}` : path;
};

const adapterFor = (db: DatabaseSync, venueId: number): Adapter | null => {
  const row = db.prepare('SELECT name, host FROM venue WHERE id = ?')
    .get(venueId) as { name: string; host: string } | undefined;

  if (! row) return null;

  return adaptersForVenue(row.name).find(one => (one.host ?? '') === row.host) ?? null;
};

const establishedFor = (db: DatabaseSync, venue: string): string | null =>
  venueIds(db, venue)
    .map(id => establishedAt(db, id, ''))
    .filter((at): at is string => at !== null)
    .sort()[0] ?? null;

const parked = (db: DatabaseSync, venueId: number): number =>
  (db.prepare('SELECT count(*) n FROM wip WHERE venue_id = ?')
    .get(venueId) as { n: number }).n;

/** The month after this one, as the exclusive ceiling of a whole month. */
const nextMonth = (month: string): string => {
  const year = Number(month.slice(0, 4));
  const at   = Number(month.slice(4, 6));

  if (! Number.isInteger(year) || ! Number.isInteger(at) || at < 1 || at > 12) return month;

  return at === 12 ? `${year + 1}01` : `${year}${String(at + 1).padStart(2, '0')}`;
};

const optional = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

/** Asking past the cap gets the cap: a client's mistake stays the client's. */
const capped = (value: unknown): number => {
  const asked = Number(optional(value) ?? LIMIT);

  if (! Number.isFinite(asked) || asked <= 0) return LIMIT;

  return Math.min(Math.floor(asked), MAX_LIMIT);
};

/**
 * The cursor is opaque so that where a page left off stays this service's
 * business — a caller that read it would end up depending on the ordering.
 */
const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const decodeCursor = (value: unknown): Cursor | null => {
  const raw = optional(value);

  if (! raw) return null;

  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;

    return typeof parsed?.date === 'string' && typeof parsed?.path === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
};
