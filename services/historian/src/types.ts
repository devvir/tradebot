export interface Config {
  bitmexRestUrl: string;
  database: string;
  [key: string]: unknown;
}

export interface TableConfig {
  name: string;
  path: string;
  auth: false;
  /**
   * null         — no symbol filter; fetch all data in a single pass
   * 'instruments' — iterate all active instrument symbols
   * 'indices'     — iterate index symbols (those starting with '.')
   */
  symbolSource: null | 'instruments' | 'indices';
  /**
   * Field names used to build the MongoDB _id for each document.
   * If multiple fields, they are joined as 'val1:val2'.
   * If null, documents have no unique key and are inserted (not upserted);
   * _seq is the only dedup mechanism.
   */
  idFields: string[] | null;
  /**
   * Maximum allowed start offset for this endpoint.
   * When start approaches this limit, time-block pagination kicks in.
   * null means no limit (e.g. chat).
   */
  maxStart: number | null;
  /**
   * Field name in stored documents that corresponds to the `symbol` query param.
   * Used when force-transitioning a stalled block: rows at the boundary timestamp
   * must be deleted scoped to this symbol so other symbols' rows are not touched.
   * Only relevant when symbolSource !== null. Defaults to 'symbol' when absent.
   */
  symbolField?: string;
}
