import * as catalog from '../../shared/catalog';
import { Archives, matches } from '../../shared/disk';
import { means, preferred } from '../filter';
import { idOf } from '../../shared/keys';
import * as record from '../../shared/record';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Origin } from '../../types';
import type { Pullable, PullOptions } from '../types';

/**
 * What cold storage holds of one venue that the filter means, each set against
 * the catalog's version of it and against the disk.
 */
export const survey = async (
  db:       DatabaseSync,
  config:   ColdConfig,
  origin:   Origin,
  venue:    string,
  options:  Pick<PullOptions, 'filter' | 'prefer'>,
  archives: Archives,
): Promise<Pullable[]> => {
  const held = preferred(record.pullableOf(db, origin, venue).filter(one => means(options.filter, one)), options.prefer);

  if (held.length === 0) return [];

  const versions = new Map((await catalog.partitions(config, venue)).map(one => [idOf(one), one.version]));
  const found: Pullable[] = [];

  for (const one of held.sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1))) {
    if (versions.get(idOf(one)) !== one.version) {
      found.push({ held: one, state: 'old' });

      continue;
    }

    const files = await archives.filesOf(one);

    found.push({ held: one, state: files.length === 0 ? 'away' : matches(files, one) ? 'same' : 'differs' });
  }

  return found;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_survey = survey;
