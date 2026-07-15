export type TableOrigin = 'ws' | 'rest';

export interface TableMeta {
  name:   string;
  origin: TableOrigin;

  /**
   * Whether the table has a sources → bucket preparation stage. When `true`
   * the raw collected files are *sources* (suffixed, stored in
   * `SOURCES_MEGA_RAW`) that promote to *buckets* (suffix-less, stored in
   * `SOURCES_MEGA_VAULT`) only after processing; Mega must hold both. When
   * `false` the collected files are buckets from birth — the only Mega artifact.
   *
   * Orthogonal to `origin`: it happens that every WS table needs preparation,
   * but being sourced is not exclusive to WS. `trade`/`quote` are REST-origin
   * yet sourced — their symbol-major S3 downloads (`.s3`/`.rest`) pass through
   * `data resort` to become ts-major buckets.
   */
  sourced: boolean;
}

/**
 * The BitMEX tables tracked by `data sync`.
 *
 * WS tables are collected in real time and are all sourced (need preparation
 * before use). REST tables arrive as ready records; most are buckets from
 * birth, but the symbol-major ones (`trade`/`quote`, from courier's S3
 * downloads and scribe's REST backfill, stamped `.s3`/`.rest`) are sourced and
 * pass through `data resort` before becoming buckets.
 *
 * `tick` is a pseudo-table (not a BitMEX endpoint): the referential index
 * prints, split out of `trade` by scribe.
 *
 * `orderBookL2.secondary` is the Secondary liquidity pool's book, collected on
 * its own pool-filtered WS client and stored as its own per-pool pseudo-table
 * since 2026-07-15 (`orderBookL2` itself is Primary-only from that day; earlier
 * history is the fused Aggregated stream).
 */
export const ALL_TABLES: TableMeta[] = [
  { name: 'announcement',          origin: 'ws',   sourced: true  },
  { name: 'chat',                  origin: 'ws',   sourced: true  },
  { name: 'connected',             origin: 'ws',   sourced: true  },
  { name: 'instrument',            origin: 'ws',   sourced: true  },
  { name: 'liquidation',           origin: 'ws',   sourced: true  },
  { name: 'orderBookL2',           origin: 'ws',   sourced: true  },
  { name: 'orderBookL2.secondary', origin: 'ws',   sourced: true  },
  { name: 'publicNotifications',   origin: 'ws',   sourced: true  },

  { name: 'compositeIndex',        origin: 'rest', sourced: false },
  { name: 'funding',               origin: 'rest', sourced: false },
  { name: 'insurance',             origin: 'rest', sourced: false },
  { name: 'quote',                 origin: 'rest', sourced: true  },
  { name: 'settlement',            origin: 'rest', sourced: false },
  { name: 'tick',                  origin: 'rest', sourced: false },
  { name: 'trade',                 origin: 'rest', sourced: true  },
];

export const ALL_TABLE_NAMES: ReadonlySet<string> = new Set(ALL_TABLES.map(t => t.name));

export function tableOrigin(name: string): TableOrigin | null {
  return ALL_TABLES.find(t => t.name === name)?.origin ?? null;
}
