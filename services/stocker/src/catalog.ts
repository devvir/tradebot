import { createHash } from 'node:crypto';
import { logger } from '@devvir/service-kit';
import config from './config';
import { edgesOf, idOf, parseKey, partitionOf } from './keys';
import type {
  BucketPage, Building, BuildingEdge, EdgeStats, ListedObject, Partition, PartitionStats,
} from './types';

/**
 * What the catalog says every partition holds.
 *
 * The catalog serves its files as one S3-style bucket keyed by what each file
 * is, so a partition is never asked for by name: its files are scattered across
 * one directory per instrument. Instead each dataset is listed once per sweep,
 * through the configured lens, and every key folded into the partition it
 * belongs to — how many files, how many bytes, and a digest of every key, ETag
 * and size in listing order. A second pass, of only what is not yet downloaded,
 * says which partitions are still owed files.
 *
 * Nothing is kept between sweeps and nothing is written: the digest **is** the
 * partition's identity, so whatever changed in the catalog changes it.
 */
export const listPartitions = async (prefixes: string[]): Promise<Map<string, Partition>> => {
  const open = new Map<string, Building>();

  for (const prefix of prefixes) {
    const started = Date.now();
    let listed    = 0;

    for await (const object of walk(prefix, false)) {
      const file = parseKey(object.Key);

      if (! file) continue;

      listed++;

      const key = partitionOf(file);
      const id  = idOf(key);

      let building = open.get(id);

      if (! building) {
        building = { key, id, files: 0, bytes: 0, digest: createHash('sha256'), pending: 0,
          first: edge(), last: edge() };

        open.set(id, building);
      }

      const line = `${object.Key}\t${object.ETag ?? ''}\t${object.Size ?? ''}\n`;
      const size = typeof object.Size === 'number' ? object.Size : null;

      building.files++;
      building.bytes = building.bytes === null || size === null ? null : building.bytes + size;
      building.digest.update(line);

      const { first, last } = edgesOf(file);

      if (first) fold(building.first, line, size);
      if (last)  fold(building.last, line, size);
    }

    let owed = 0;

    for await (const object of walk(prefix, true)) {
      const file = parseKey(object.Key);

      if (! file) continue;

      const building = open.get(idOf(partitionOf(file)));

      if (! building) continue;

      owed++;
      building.pending++;

      const { first, last } = edgesOf(file);

      if (first) building.first.pending++;
      if (last)  building.last.pending++;
    }

    logger.info({ prefix, files: listed, pending: owed, seconds: (Date.now() - started) / 1000 },
      'Catalog listed');
  }

  return new Map([...open].map(([id, building]) => [id, finish(building)]));
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** The catalog's largest page. */
const PAGE_KEYS = 1_000;

/** Attempts at reaching the catalog before a request counts as failed. */
const ATTEMPTS = 4;

/** The wait before trying again, doubled each time. */
const RETRY_MS = 2_000;

const edge = (): BuildingEdge => ({ files: 0, bytes: 0, digest: createHash('sha256'), pending: 0 });

const fold = (into: BuildingEdge, line: string, size: number | null): void => {
  into.files++;
  into.bytes = into.bytes === null || size === null ? null : into.bytes + size;
  into.digest.update(line);
};

const finishEdge = (from: BuildingEdge): EdgeStats => ({
  files: from.files, bytes: from.bytes, digest: from.digest.digest('hex'), pending: from.pending,
});

const finish = (from: Building): Partition => {
  const stats: PartitionStats = {
    files:   from.files,
    bytes:   from.bytes,
    digest:  from.digest.digest('hex'),
    pending: from.pending,
    first:   finishEdge(from.first),
    last:    finishEdge(from.last),
  };

  return { key: from.key, id: from.id, stats };
};

/** Every object under a prefix, page by page, optionally only the undownloaded ones. */
async function* walk(prefix: string, pending: boolean): AsyncIterable<ListedObject> {
  let marker: string | null = null;

  for (;;) {
    const query = new URLSearchParams({ prefix, 'max-keys': String(PAGE_KEYS) });

    if (pending) query.set('pending', 'true');
    if (marker !== null) query.set('marker', marker);

    const page = await ask<BucketPage>(`/listings?${query.toString()}`);
    const objects = page.Contents ?? [];

    yield* objects;

    if (! page.IsTruncated || objects.length === 0) return;

    marker = page.NextMarker ?? objects[objects.length - 1]!.Key;
  }
}

/**
 * One request, tried again where the connection failed. An answer — any
 * status — is the catalog's verdict and is not retried.
 */
const ask = async <T>(path: string): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await once<T>(path);
    } catch (err) {
      if (! (err instanceof TypeError) || attempt >= ATTEMPTS) throw err;

      await new Promise(done => setTimeout(done, RETRY_MS * 2 ** (attempt - 1)));
    }
  }
};

const once = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${config.catalogApi}${path}`, {
    headers: {
      accept: 'application/json',
      ...(config.catalogToken ? { 'x-catalog-token': config.catalogToken } : {}),
      ...(config.lens ? { 'x-catalog-lens': config.lens } : {}),
    },
  });

  if (! res.ok)
    throw new Error(`Catalog answered ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);

  return await res.json() as T;
};
