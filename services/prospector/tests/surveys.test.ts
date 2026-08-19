import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginJob, closeRun, putFiles, putVenue, recordSeries } from '../src/catalog';
import { openCatalog } from '../src/database';
import { setupRoutes } from '../src/api/routes';
import type { Application } from 'express';
import type { CatalogFile, Surveys } from '../src/types';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Which venues a survey request sets going.
 *
 * **One verb, and where a venue has got to decides what it means** — start,
 * continue, or look for what has appeared since. The only thing ever refused is
 * a survey already running in this process. The cases below are the ones where
 * that broke, and each was invisible until a real catalog was asked.
 */

let dir: string;
let db:  DatabaseSync;
let app: Application;

/** Venues asked to start, in order, so a skip is provable rather than implied. */
let started: string[];

/** Venues asked to start **with the progress thrown away**. */
let refreshed: string[];

/** Venues asked to start **as an update rather than a full pass**. */
let updated: string[];

/** Venues asked to stop, and which of them were pretending to be running. */
let stopped: string[];
let live:    Set<string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'surveys-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });

  started   = [];
  refreshed = [];
  updated   = [];
  stopped = [];
  live    = new Set();

  const surveys: Surveys = {
    venues:  () => ['binance', 'bybit', 'gate'],

    start: (venue, occasion, refresh) => {
      started.push(venue);

      if (refresh) refreshed.push(venue);
      if (occasion === 'partial') updated.push(venue);
    },

    running:  (venue) => live.has(venue),
    stopping: ()      => false,
    everyMs:  ()      => 86_400_000,

    pause: (venue) => {
      if (! live.has(venue)) return false;

      stopped.push(venue);

      return true;
    },
  };

  app = express();
  app.use(express.json());
  setupRoutes(app, db, surveys);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ask = async (
  method:  'POST' | 'PATCH',
  venue?:  string | string[],
  path     = '/surveys',

  /** The modifiers, and anything else a case wants in the body. */
  extra:   Record<string, unknown> = {},
) => {
  const server = app.listen(0);
  const port   = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-catalog-token': 'change-me' },
      body:    JSON.stringify({ ...(venue ? { venue } : {}), ...extra }),
    });

    return {
      status: res.status,

      ...await res.json() as {
        started: string[];
        resumed: string[];
        paused:  string[];
        skipped: { venue: string; reason: string }[];
        unknown: string[];
        error?:  string;
        phases?: Record<string, string>;
      },
    };
  } finally {
    server.close();
  }
};

const reasonFor = (
  body:  { skipped: { venue: string; reason: string }[] },
  venue: string,
): string | undefined => body.skipped.find(one => one.venue === venue)?.reason;

/** A venue that has been surveyed once, with nothing left over. */
const finished = (venue: string): number => {
  const id  = putVenue(db, venue, 'https://x', '');
  const job = beginJob(db, id, 'walk', ['a/']);

  for (const run of [job, ...db.prepare(
    'SELECT id FROM run WHERE venue_id = ? AND scope != \'\'').all(id) as { id: number }[]])
    closeRun(db, run.id, 'T1');

  return id;
};

/** A series to hang the names on; these tests are not about series. */
const seriesOn = (venueId: number): number =>
  recordSeries(db, venueId, {
    market: 'perp', dataset: 'klines', symbol: 'BTCUSDT',
    pattern: 'p/{YYYY}{MM}/{SYMBOL}.zip',
  }).id!;

/** A name a walk found and could say nothing else about, so a probe still owes it. */
const bare = (venueId: number, path: string): CatalogFile => ({
  venueId, path, date: '20250301', size: null, etag: null,
  modified: null, existence: 'confirmed', seenAt: 'T1',
  seriesId: seriesOn(venueId),
});

describe('starting a survey', () => {
  /**
   * **One verb, and the state decides what it means.** Every case below used to
   * be a different answer — start, resume, or a refusal — and a caller had to
   * know which to ask for. What it actually wants is "keep this venue up to
   * date", and where the venue has got to is something the rows already say.
   */
  it('starts a venue the catalog has never heard of', async () => {
    expect((await ask('POST', 'gate')).started).toEqual(['gate']);
  });

  it('starts a venue that has a row and nothing else', async () => {
    putVenue(db, 'gate', 'https://x', '');

    expect((await ask('POST')).started).toContain('gate');
  });

  it('continues a venue whose walk is still open', async () => {
    const id = putVenue(db, 'binance', 'https://x', '');

    beginJob(db, id, 'walk', ['a/']);

    expect((await ask('POST', 'binance')).started).toEqual(['binance']);
  });

  /**
   * **The case the old answer got backwards.** A venue that finished is not
   * finished with — it is the one that should now be updating, and answering
   * "nothing to resume" refused exactly the venues that had caught up.
   */
  it('starts a venue that finished, because finishing is when updating begins', async () => {
    finished('binance');

    const body = await ask('POST', 'binance');

    expect(body.started).toEqual(['binance']);
    expect(body.phases!['binance']).toBe('updating');
  });

  /**
   * The case that reported bybit as done while 479,199 rows waited: its books
   * carry no metadata in the index, so a completed walk leaves names nothing has
   * established.
   */
  it('starts a venue whose walks finished but whose files are unprobed', async () => {
    const id = finished('bybit');

    await putFiles(db, [bare(id, 'orderbook/BTCUSDT/2025-03-01.tar.gz')]);

    expect((await ask('POST')).started).toContain('bybit');
  });

  /** The one thing still refused, because two of them would race each other. */
  it('refuses a venue this process is already surveying', async () => {
    live.add('binance');

    const body = await ask('POST', 'binance');

    expect(body.started).toEqual([]);
    expect(reasonFor(body, 'binance')).toBe('already running');
  });

  it('reports where each venue was, so a caller knows what it asked for', async () => {
    finished('binance');
    putVenue(db, 'gate', 'https://x', '');

    const body = await ask('POST');

    expect(body.phases!['binance']).toBe('updating');
    expect(body.phases!['gate']).toBe('not run');
  });

  /**
   * **A venue with no keyspace to read still has a phase.** Okx and bitget are
   * never walked — there is no index to list, so every key is generated from a
   * series — and reading the phase off `walk` rows alone answered `not run` for
   * both of them however many millions of files they had established. "Never
   * surveyed" and "cannot be walked" are different states and the answer has to
   * tell them apart.
   */
  it('reports the phase of a venue that updates rather than walks', async () => {
    const id  = putVenue(db, 'bybit', 'https://x', '');
    const job = beginJob(db, id, 'update', ['1']);

    for (const run of [job, ...db.prepare(
      'SELECT id FROM run WHERE venue_id = ? AND scope != \'\'').all(id) as { id: number }[]])
      closeRun(db, run.id, 'T1');

    expect((await ask('POST', 'bybit')).phases!['bybit']).toBe('updating');
  });
});

/**
 * **Discarding progress is asked for by name, and carried out elsewhere.** The
 * route's whole job here is to pass the request on: stopping a live loop and
 * then dropping its rows has to happen where the loop is, or the reset lands
 * under a walk that is still committing cursors against it.
 */
describe('refreshing', () => {
  it('passes the request on, so the survey starts from nothing', async () => {
    finished('binance');

    expect(await ask('POST', 'binance', '/surveys', { refresh: true }))
      .toMatchObject({ started: ['binance'] });

    expect(refreshed).toEqual(['binance']);
  });

  it('does not ask for one that was not requested', async () => {
    finished('binance');

    await ask('POST', 'binance');

    expect(started).toEqual(['binance']);
    expect(refreshed).toEqual([]);
  });

  /**
   * **The one request that interrupts.** A venue is surveyed by a loop that does
   * not end on its own, so refusing a refresh because the venue is running would
   * make a refresh impossible for ever after the first survey.
   */
  it('is accepted even while the venue is running', async () => {
    finished('binance');

    live.add('binance');

    const body = await ask('POST', 'binance', '/surveys', { refresh: true });

    expect(body.started).toEqual(['binance']);
    expect(refreshed).toEqual(['binance']);
  });

  /** An ordinary request still adds nothing to a venue already doing the work. */
  it('leaves a running venue alone when no refresh is asked for', async () => {
    live.add('binance');

    const body = await ask('POST', 'binance');

    expect(body.started).toEqual([]);
    expect(reasonFor(body, 'binance')).toBe('already running');
  });
});

/**
 * **Bringing the next update forward.**
 *
 * The modifier exists for one state — a venue idle between passes, whose loop is
 * very much alive — so "already running" cannot be an answer to it. Everywhere
 * else it either has nothing to build on, or is already doing the thing.
 */
describe('forcing an update', () => {
  it('updates a venue that is waiting between passes', async () => {
    finished('binance');

    live.add('binance');

    const body = await ask('POST', 'binance', '/surveys', { update: true });

    expect(body.started).toEqual(['binance']);
    expect(updated).toEqual(['binance']);
  });

  /**
   * **Nothing to update from.** A venue mid-walk, or one that has never run, is
   * owed the walk it is already doing — an update planned against bounds nothing
   * has established is not a cheaper version of that.
   */
  it('refuses a venue no pass has ever completed', async () => {
    const id = putVenue(db, 'binance', 'https://x', '');

    beginJob(db, id, 'walk', ['a/']);

    const body = await ask('POST', 'binance', '/surveys', { update: true });

    expect(body.status).toBe(409);
    expect(started).toEqual([]);
    expect(reasonFor(body, 'binance')).toBe('no pass has completed — walk it first');
  });

  it('refuses a venue the catalog has never heard of', async () => {
    expect((await ask('POST', 'gate', '/surveys', { update: true })).status).toBe(409);
    expect(started).toEqual([]);
  });

  /** Already doing it. A loop does not end on its own, so there is nothing to add. */
  it('leaves a venue whose update is already running alone', async () => {
    const id = finished('binance');

    beginJob(db, id, 'update', ['1']);
    live.add('binance');

    const body = await ask('POST', 'binance', '/surveys', { update: true });

    expect(body.status).toBe(409);
    expect(started).toEqual([]);
    expect(reasonFor(body, 'binance')).toBe('already updating');
  });

  /**
   * **An update open with nothing working it is a resume, and says so.** That is
   * what a pause during an update leaves, and equally what a killed container
   * leaves. From outside it is indistinguishable from a new update and it is not
   * one: it carries on from cursors that already exist.
   */
  it('resumes an open update rather than reporting a new one', async () => {
    const id = finished('binance');

    beginJob(db, id, 'update', ['1']);

    const body = await ask('POST', 'binance', '/surveys', { update: true });

    expect(body.resumed).toEqual(['binance']);
    expect(body.started).toEqual([]);
    expect(updated).toEqual(['binance']);
  });

  /** One discards the progress the other builds on, so asking for both decides nothing. */
  it('refuses to be combined with a refresh', async () => {
    finished('binance');

    const body = await ask('POST', 'binance', '/surveys', { update: true, refresh: true });

    expect(body.status).toBe(400);
    expect(started).toEqual([]);
  });
});

describe('pausing', () => {
  it('stops the venues that are running and says which were not', async () => {
    live.add('bybit');

    const body = await ask('POST', undefined, '/surveys/pause');

    expect(body.paused).toEqual(['bybit']);
    expect(reasonFor(body, 'binance')).toBe('not running');
    expect(reasonFor(body, 'gate')).toBe('not running');
  });

  it('pauses one venue when one is named', async () => {
    live.add('bybit');
    live.add('gate');

    const body = await ask('POST', 'gate', '/surveys/pause');

    expect(body.paused).toEqual(['gate']);
    expect(stopped).toEqual(['gate']);
  });

  /** "One, some, or all" — a list is the middle case, and the same for starting. */
  it('pauses several when several are named', async () => {
    live.add('binance');
    live.add('bybit');
    live.add('gate');

    const body = await ask('POST', ['binance', 'gate'], '/surveys/pause');

    expect(body.paused).toEqual(['binance', 'gate']);
    expect(stopped).not.toContain('bybit');
  });

  it('refuses a venue it does not have, rather than pausing the rest', async () => {
    live.add('gate');

    const body = await ask('POST', ['gate', 'nonesuch'], '/surveys/pause');

    expect(body.unknown).toEqual(['nonesuch']);
    expect(stopped).toEqual([]);
  });

  /** The same selection rules apply to starting, which is the point of sharing them. */
  it('starts several when several are named', async () => {
    const body = await ask('POST', ['binance', 'gate']);

    expect(body.started).toEqual(['binance', 'gate']);
  });
});

/**
 * Naming the venue in the path rather than the body.
 *
 * **A shortcut, so what it must prove is sameness.** Anything that behaved even
 * slightly differently here would be a second implementation of starting a
 * survey, and the two would drift — so these check that it resolves to the same
 * request `POST /surveys` would have made, refusals and all.
 */
describe('starting one venue by name', () => {
  it('starts exactly that venue', async () => {
    expect(await ask('POST', undefined, '/venues/binance/surveys'))
      .toMatchObject({ started: ['binance'] });
  });

  it('leaves every other venue alone', async () => {
    const answer = await ask('POST', undefined, '/venues/binance/surveys');

    expect(answer.started).toEqual(['binance']);
    expect(answer.skipped ?? []).toEqual([]);
  });

  /** The path is the venue, so a body naming another one cannot smuggle it in. */
  it('ignores a venue in the body when the path names one', async () => {
    expect(await ask('POST', 'gate', '/venues/binance/surveys'))
      .toMatchObject({ started: ['binance'] });
  });

  it('refuses a venue this build cannot read', async () => {
    expect(await ask('POST', undefined, '/venues/nonsense/surveys'))
      .toMatchObject({ unknown: ['nonsense'] });
  });

  /** The same refusal `POST /surveys` gives, for the same reason. */
  it('refuses one this process is already surveying', async () => {
    live.add('binance');

    const body = await ask('POST', undefined, '/venues/binance/surveys');

    expect(body.started).toEqual([]);
    expect(reasonFor(body, 'binance')).toBe('already running');
  });

  it('honours refresh, as the body form does', async () => {
    finished('binance');

    await ask('POST', undefined, '/venues/binance/surveys', { refresh: true });

    expect(refreshed).toEqual(['binance']);
  });
});
